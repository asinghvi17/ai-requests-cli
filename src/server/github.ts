// The GitHub calls `air serve` needs beyond claiming: listing open requests, release assets (artifacts and
// over-long reports) and pull requests. All of them go through `gh api` (src/gh/gh.ts), which holds the token.
import { checkRepo, GhError, type Gh, type Issue } from '../gh/index.ts';
import { REQUEST_LABEL } from '../request/index.ts';

/** Uploads can be large: they get a longer limit than other gh calls. */
export const UPLOAD_TIMEOUT_MS = 30 * 60_000;

export interface ListedIssue extends Issue {
  assignees: string[];
}

export interface Release {
  id: number;
  uploadUrl: string;
  assets: { id: number; name: string }[];
}

export interface ServeGitHub {
  /** Open issues labelled `ai-request`, oldest first, pull requests left out. */
  openRequests(): Promise<ListedIssue[]>;
  /** The release tagged `tag` on the requests repo, created if missing. */
  release(tag: string): Promise<Release>;
  /** Uploads `file` as asset `name` (replacing an asset of that name); resolves to its id and download URL. */
  uploadAsset(release: Release, name: string, file: string, contentType: string): Promise<{ id: number; url: string }>;
  /** Opens a pull request on `repo` (OWNER/NAME); resolves to its URL. */
  createPull(repo: string, pr: { title: string; head: string; base: string; body: string }): Promise<string>;
  /** The URL of the open PR on `repo` from its branch `head`, if any. */
  findPull(repo: string, head: string): Promise<string | undefined>;
  /** Replaces the body of pull request `number` on `repo`. */
  updatePull(repo: string, number: number, body: string): Promise<void>;
}

type RawUser = { login?: string } | null;
type RawIssue = {
  number: number; title: string; body?: string | null; state: string; labels: ({ name: string } | string)[];
  user: RawUser; author_association?: string; html_url: string; pull_request?: unknown; assignees?: RawUser[];
};
type RawRelease = { id: number; upload_url: string; assets?: { id: number; name: string }[] };

function toIssue(i: RawIssue): ListedIssue {
  return {
    number: i.number, title: i.title, body: i.body ?? '', state: i.state === 'open' ? 'open' : 'closed',
    labels: i.labels.map((l) => (typeof l === 'string' ? l : l.name)), author: i.user?.login ?? '',
    authorAssociation: i.author_association ?? 'NONE', url: i.html_url, isPullRequest: i.pull_request !== undefined,
    assignees: (i.assignees ?? []).map((a) => a?.login ?? '').filter(Boolean),
  };
}

function toRelease(r: RawRelease): Release {
  return { id: r.id, uploadUrl: r.upload_url.replace(/\{.*\}$/, ''), assets: (r.assets ?? []).map((a) => ({ id: a.id, name: a.name })) };
}

export function serveGitHub(repo: string, gh: Gh): ServeGitHub {
  checkRepo(repo);
  const base = `repos/${repo}`;
  return {
    async openRequests() {
      const list = await gh.paginate<RawIssue>(`${base}/issues?state=open&labels=${encodeURIComponent(REQUEST_LABEL)}&sort=created&direction=asc&per_page=100`);
      return list.map(toIssue).filter((i) => !i.isPullRequest);
    },
    async release(tag) {
      try {
        return toRelease(await gh.api<RawRelease>(`${base}/releases/tags/${encodeURIComponent(tag)}`));
      } catch (e) {
        if (!(e instanceof GhError && e.kind === 'not_found')) throw e;
      }
      try {
        return toRelease(await gh.api<RawRelease>(`${base}/releases`, {
          method: 'POST',
          body: { tag_name: tag, name: tag, body: 'Files uploaded by air servers. `air sweep` deletes them when they expire (spec/v0.md §7).' },
        }));
      } catch (e) {
        // Another server created it meanwhile.
        if (e instanceof GhError && e.kind === 'validation') return toRelease(await gh.api<RawRelease>(`${base}/releases/tags/${encodeURIComponent(tag)}`));
        throw e;
      }
    },
    async uploadAsset(release, name, file, contentType) {
      if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new GhError('other', `bad asset name ${JSON.stringify(name)}`);
      const old = release.assets.find((a) => a.name === name);
      if (old) await gh.api(`${base}/releases/assets/${old.id}`, { method: 'DELETE' });
      const r = await gh.upload<{ id: number; browser_download_url: string }>(`${release.uploadUrl}?name=${encodeURIComponent(name)}`, file, contentType, { timeoutMs: UPLOAD_TIMEOUT_MS });
      return { id: r.id, url: r.browser_download_url };
    },
    async createPull(target, pr) {
      checkRepo(target);
      const r = await gh.api<{ html_url: string }>(`repos/${target}/pulls`, { method: 'POST', body: pr });
      return r.html_url;
    },
    async findPull(target, head) {
      checkRepo(target);
      const owner = target.split('/')[0]!;
      const list = await gh.api<{ html_url: string }[]>(`repos/${target}/pulls?state=open&head=${encodeURIComponent(`${owner}:${head}`)}`);
      return list[0]?.html_url;
    },
    async updatePull(target, number, body) {
      checkRepo(target);
      await gh.api(`repos/${target}/pulls/${number}`, { method: 'PATCH', body: { body } });
    },
  };
}
