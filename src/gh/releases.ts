// Release assets and repo-wide issue listings on the requests repo, for `air submit` and `air sweep`.
// Uploads go through `gh release upload` (gh streams the file to the uploads host); everything else is
// `gh api`. A fake for tests is in `releases-fake.ts`.
import { basename } from 'node:path';
import { GhError, createGh, spawnGh, type Gh, type Runner } from './gh.ts';
import { checkRepo } from './issues.ts';

/** The release `air submit` uploads context zips to (spec/v0.md §5). */
export const CONTEXT_TAG = 'air-context';
/** The release servers upload artifacts and long reports to (spec/v0.md §6). */
export const ARTIFACTS_TAG = 'air-artifacts';

export interface Asset {
  id: number;
  name: string;
  /** `browser_download_url`: what `context.url` and `air-artifact` blocks point at. */
  url: string;
  size: number;
}

export interface IssueSummary {
  number: number;
  state: 'open' | 'closed';
  labels: string[];
  body: string;
  /** ISO time the issue was closed, when it is. */
  closedAt?: string;
}

export interface RepoComment {
  id: number;
  issue: number;
  body: string;
  author: string;
  authorAssociation: string;
  createdAt: string;
  updatedAt: string;
}

export interface Releases {
  readonly repo: string;
  /** Assets on the release tagged `tag`; empty when there is no such release. */
  assets(tag: string): Promise<Asset[]>;
  /** Uploads `file` as an asset named after the file's basename, creating the release if needed. */
  upload(tag: string, file: string): Promise<Asset>;
  /** Deleting an asset that is already gone is not an error. */
  deleteAsset(id: number): Promise<void>;
  createIssue(title: string, body: string, labels: string[]): Promise<{ number: number; url: string }>;
  /** Every issue and pull request, open and closed. */
  issues(): Promise<IssueSummary[]>;
  /** Every issue comment in the repo. */
  comments(): Promise<RepoComment[]>;
}

type RawRelease = { id: number };
type RawAsset = { id: number; name: string; browser_download_url: string; size: number };
type RawIssue = { number: number; state: string; labels: ({ name: string } | string)[]; body?: string | null; closed_at?: string | null };
type RawComment = {
  id: number; issue_url: string; body?: string | null; user: { login?: string } | null; author_association?: string;
  created_at: string; updated_at: string;
};

const TAG_RE = /^[A-Za-z0-9._-]+$/;

export function releases(repo: string, gh: Gh = createGh(), run: Runner = spawnGh): Releases {
  checkRepo(repo);
  const base = `repos/${repo}`;
  const release = async (tag: string): Promise<RawRelease | undefined> => {
    if (!TAG_RE.test(tag)) throw new GhError('other', `bad release tag ${JSON.stringify(tag)}`);
    try {
      return await gh.api<RawRelease>(`${base}/releases/tags/${tag}`);
    } catch (e) {
      if (e instanceof GhError && e.kind === 'not_found') return undefined;
      throw e;
    }
  };
  const toAsset = (a: RawAsset): Asset => ({ id: a.id, name: a.name, url: a.browser_download_url, size: a.size });
  const assets = async (tag: string): Promise<Asset[]> => {
    const r = await release(tag);
    if (!r) return [];
    return (await gh.paginate<RawAsset>(`${base}/releases/${r.id}/assets?per_page=100`)).map(toAsset);
  };
  return {
    repo,
    assets,
    async upload(tag, file) {
      if (!(await release(tag))) {
        try {
          await gh.api(`${base}/releases`, {
            method: 'POST',
            body: { tag_name: tag, name: tag, body: 'Files for air requests (spec/v0.md). Managed by `air submit` and `air sweep`.', make_latest: 'false' },
          });
        } catch (e) {
          // Someone else created it first.
          if (!(e instanceof GhError && e.kind === 'validation')) throw e;
        }
      }
      const r = await run(['release', 'upload', tag, file, '--repo', repo]);
      if (r.code !== 0) throw new GhError('other', `gh release upload: ${r.stderr.trim().replace(/^gh: /, '') || `exited ${r.code}`}`);
      const name = basename(file);
      const found = (await assets(tag)).find((a) => a.name === name);
      if (!found) throw new GhError('other', `uploaded ${name}, but it is not on the ${tag} release`);
      return found;
    },
    async deleteAsset(id) {
      try {
        await gh.api(`${base}/releases/assets/${id}`, { method: 'DELETE' });
      } catch (e) {
        if (!(e instanceof GhError && e.kind === 'not_found')) throw e;
      }
    },
    async createIssue(title, body, labels) {
      const i = await gh.api<{ number: number; html_url: string }>(`${base}/issues`, { method: 'POST', body: { title, body, labels } });
      return { number: i.number, url: i.html_url };
    },
    async issues() {
      return (await gh.paginate<RawIssue>(`${base}/issues?state=all&per_page=100`)).map((i) => {
        const out: IssueSummary = {
          number: i.number, state: i.state === 'open' ? 'open' : 'closed', body: i.body ?? '',
          labels: i.labels.map((l) => (typeof l === 'string' ? l : l.name)),
        };
        if (i.closed_at) out.closedAt = i.closed_at;
        return out;
      });
    },
    async comments() {
      return (await gh.paginate<RawComment>(`${base}/issues/comments?per_page=100`)).map((c) => ({
        id: c.id, issue: Number(/\/issues\/(\d+)$/.exec(c.issue_url)?.[1] ?? 0), body: c.body ?? '', author: c.user?.login ?? '',
        authorAssociation: c.author_association ?? 'NONE', createdAt: c.created_at, updatedAt: c.updated_at,
      }));
    },
  };
}
