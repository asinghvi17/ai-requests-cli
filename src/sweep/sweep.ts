// `air sweep` (spec/v0.md §7): deletes expired assets on the `air-context` and `air-artifacts` releases of
// the requests repo. An asset goes only when every issue that refers to it has let its reference expire;
// assets no issue refers to are kept. Errors deciding what to keep abort the sweep before anything is
// deleted; a failed delete is reported and the sweep moves on to the next asset.
import { createTrust, type Trust } from '../claim/trust.ts';
import { requestsRepo } from '../gh/issues.ts';
import { ARTIFACTS_TAG, CONTEXT_TAG, releases as releasesApi, type Asset, type IssueSummary, type Releases, type RepoComment } from '../gh/releases.ts';
import { parseFrontMatter } from '../spec/frontmatter.ts';

/** Labels that hold an asset whatever its `expires` says. */
export const ACTIVE_LABELS = ['air:claimed', 'air:running', 'air:paused'] as const;
/** With no `expires`, a reference lasts this long after its issue closes. */
export const DEFAULT_KEEP_DAYS = 14;
const DAY = 86_400_000;

export interface SweepOptions {
  /** `owner/name` of the requests repo. */
  repo: string;
  /** Injectable for tests; default: the real repo through gh. */
  releases?: Releases;
  /** Who counts as having write access (spec/v0.md §1); default: `createTrust` on the requests repo. */
  trust?: Trust;
  now?: Date;
  dryRun?: boolean;
  /** Progress lines, without trailing newlines. */
  log?: (line: string) => void;
}

export type SweptAsset = Asset & { tag: string };

export interface SweepResult {
  /** Deleted, or with `dryRun`, would be deleted. */
  deleted: SweptAsset[];
  kept: { asset: SweptAsset; reason: string }[];
  failed: { asset: SweptAsset; error: string }[];
}

interface Reference {
  issue: number;
  /** `YYYY-MM-DD`, when the reference names one. */
  expires?: string;
}

/** Compares asset URLs by host, owner and repo case-insensitively; tag and name exactly, after decoding. */
export function normalizeUrl(url: string): string | undefined {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return undefined;
  }
  let path: string;
  try {
    path = decodeURIComponent(u.pathname);
  } catch {
    path = u.pathname;
  }
  const at = path.indexOf('/releases/download/');
  if (at < 0) return undefined;
  return `${u.host.toLowerCase()}${path.slice(0, at).toLowerCase()}${path.slice(at)}`;
}

/** `url` and `expires` of every `air-artifact` fenced block in a comment body. */
export function artifactBlocks(body: string): { url: string; expires?: string }[] {
  const out: { url: string; expires?: string }[] = [];
  let fence: { char: string; len: number; artifact: boolean; fields: Map<string, string> } | undefined;
  for (const line of body.replace(/\r\n?/g, '\n').split('\n')) {
    const f = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/.exec(line);
    if (fence) {
      if (f && f[1]![0] === fence.char && f[1]!.length >= fence.len && line.trim() === f[1]) {
        const url = fence.fields.get('url');
        if (fence.artifact && url) {
          const expires = fence.fields.get('expires');
          out.push(expires ? { url, expires } : { url });
        }
        fence = undefined;
      } else if (fence.artifact) {
        const kv = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*?)\s*$/.exec(line);
        if (kv) fence.fields.set(kv[1]!, unquote(kv[2]!.replace(/(^|\s)#.*$/, '').trim()));
      }
      continue;
    }
    if (f) fence = { char: f[1]![0]!, len: f[1]!.length, artifact: f[2] === 'air-artifact', fields: new Map() };
  }
  return out;
}

function unquote(v: string): string {
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) return v.slice(1, -1);
  return v;
}

function bodyReferences(issue: IssueSummary, wanted: Set<string>): Map<string, Reference> {
  const refs = new Map<string, Reference>();
  const fm = parseFrontMatter(issue.body);
  if (fm.ok) {
    const ctx = fm.request.context;
    const key = ctx && normalizeUrl(ctx.url);
    if (ctx && key && wanted.has(key)) refs.set(key, ctx.expires ? { issue: issue.number, expires: ctx.expires } : { issue: issue.number });
    return refs;
  }
  // A body that no longer parses still holds any asset it names, with the default expiry.
  for (const m of issue.body.matchAll(/https:\/\/[^\s"'<>)\]]+/g)) {
    const key = normalizeUrl(m[0]);
    if (key && wanted.has(key)) refs.set(key, { issue: issue.number });
  }
  return refs;
}

/** When a reference stops holding its asset, or undefined while it holds it regardless of date. */
function expiry(issue: IssueSummary | undefined, ref: Reference): number | undefined {
  if (!issue || issue.state === 'open') return undefined;
  if (issue.labels.some((l) => (ACTIVE_LABELS as readonly string[]).includes(l))) return undefined;
  if (ref.expires && /^\d{4}-\d{2}-\d{2}$/.test(ref.expires)) {
    const t = Date.parse(`${ref.expires}T00:00:00Z`);
    if (Number.isFinite(t)) return t + DAY; // kept through the whole `expires` day
  }
  const closed = issue.closedAt ? Date.parse(issue.closedAt) : NaN;
  return Number.isFinite(closed) ? closed + DEFAULT_KEEP_DAYS * DAY : undefined;
}

function heldBy(issue: IssueSummary | undefined, ref: Reference): string {
  if (!issue) return `#${ref.issue}, whose state is unknown`;
  if (issue.state === 'open') return `open issue #${ref.issue}`;
  const label = issue.labels.find((l) => (ACTIVE_LABELS as readonly string[]).includes(l));
  return label ? `#${ref.issue} (${label})` : `#${ref.issue}`;
}

export async function sweep(opts: SweepOptions): Promise<SweepResult> {
  const api = opts.releases ?? releasesApi(opts.repo);
  const trust = opts.trust ?? createTrust(requestsRepo(opts.repo));
  const now = (opts.now ?? new Date()).getTime();
  const log = opts.log ?? (() => {});
  const result: SweepResult = { deleted: [], kept: [], failed: [] };

  const assets: SweptAsset[] = [];
  for (const tag of [CONTEXT_TAG, ARTIFACTS_TAG]) for (const a of await api.assets(tag)) assets.push({ ...a, tag });
  if (assets.length === 0) return result;
  const byKey = new Map<string, SweptAsset[]>();
  for (const a of assets) {
    const key = normalizeUrl(a.url);
    if (key) byKey.set(key, [...(byKey.get(key) ?? []), a]);
  }
  const wanted = new Set(byKey.keys());

  const issues = await api.issues();
  const issueByNumber = new Map(issues.map((i) => [i.number, i]));
  const refs = new Map<string, Reference[]>();
  const addRef = (key: string, ref: Reference) => refs.set(key, [...(refs.get(key) ?? []), ref]);
  for (const issue of issues) for (const [key, ref] of bodyReferences(issue, wanted)) addRef(key, ref);
  for (const c of await api.comments()) {
    const blocks = artifactBlocks(c.body).filter((b) => wanted.has(normalizeUrl(b.url) ?? ''));
    if (blocks.length === 0 || !(await counts(c, trust))) continue;
    for (const b of blocks) addRef(normalizeUrl(b.url)!, b.expires ? { issue: c.issue, expires: b.expires } : { issue: c.issue });
  }

  for (const a of assets) {
    const key = normalizeUrl(a.url);
    const mine = key ? refs.get(key) ?? [] : [];
    if (mine.length === 0) {
      result.kept.push({ asset: a, reason: 'no issue refers to it' });
      continue;
    }
    let holding: string | undefined;
    for (const ref of mine) {
      const issue = issueByNumber.get(ref.issue);
      const until = expiry(issue, ref);
      if (until === undefined) {
        holding = `held by ${heldBy(issue, ref)}`;
        break;
      }
      if (until > now) holding ??= `held by #${ref.issue} until ${new Date(until).toISOString().slice(0, 10)}`;
    }
    if (holding) {
      result.kept.push({ asset: a, reason: holding });
      continue;
    }
    const what = `${a.tag}/${a.name} (${a.size} bytes; ${mine.map((r) => `#${r.issue}`).join(', ')})`;
    if (opts.dryRun) {
      log(`would delete ${what}`);
      result.deleted.push(a);
      continue;
    }
    try {
      await api.deleteAsset(a.id);
      log(`deleted ${what}`);
      result.deleted.push(a);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      log(`failed to delete ${a.tag}/${a.name}: ${error}`);
      result.failed.push({ asset: a, error });
    }
  }
  return result;
}

/** A comment's `air-artifact` block counts only from a trusted author and if never edited (spec/v0.md §9). */
async function counts(c: RepoComment, trust: Trust): Promise<boolean> {
  return c.createdAt === c.updatedAt && (await trust(c.author, c.authorAssociation));
}
