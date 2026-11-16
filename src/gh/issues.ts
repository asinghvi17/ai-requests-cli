// Typed issue, comment, label and permission calls on the requests repo. Claim and setup code talks to
// GitHub only through this interface, so tests can swap in an in-memory fake (`fake.ts`).
import { GhError, createGh, type Gh } from './gh.ts';

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  author: string;
  /** GitHub `author_association` of the issue author on the requests repo. */
  authorAssociation: string;
  url: string;
  isPullRequest: boolean;
}

export interface IssueComment {
  id: number;
  body: string;
  author: string;
  authorAssociation: string;
  createdAt: string;
  updatedAt: string;
}

/** The head of a pull request, as `air fetch` checks it out. */
export interface PullHead {
  /** Branch name in the head repo. */
  ref: string;
  sha: string;
  /** `https://` clone URL of the head repo. */
  cloneUrl: string;
}

/** A role from `collaborators/{login}/permission`, or `none`. */
export type Permission = 'admin' | 'maintain' | 'write' | 'triage' | 'read' | 'none';

export interface RequestsRepo {
  /** `owner/name` of the requests repo. */
  readonly repo: string;
  /** Login of the account gh is authenticated as. */
  viewer(): Promise<string>;
  issue(n: number): Promise<Issue>;
  comments(n: number): Promise<IssueComment[]>;
  comment(n: number, body: string): Promise<IssueComment>;
  /** Replaces the issue's body. */
  editBody(n: number, body: string): Promise<void>;
  deleteComment(id: number): Promise<void>;
  addLabels(n: number, labels: string[]): Promise<void>;
  /** Removing a label the issue doesn't carry is not an error. */
  removeLabel(n: number, label: string): Promise<void>;
  assign(n: number, login: string): Promise<void>;
  unassign(n: number, login: string): Promise<void>;
  /** `login`'s role on any repo (`owner/name`) on the same host; `none` when GitHub says it has none. */
  permission(repo: string, login: string): Promise<Permission>;
  /** The head of pull request `n` of any repo (`owner/name`) on the same host. */
  pullHead(repo: string, n: number): Promise<PullHead>;
}

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/;

export function checkRepo(repo: string): void {
  if (!REPO_RE.test(repo) || repo.split('/').some((p) => p === '.' || p === '..')) throw new GhError('other', `bad repo ${JSON.stringify(repo)}: expected OWNER/NAME`);
}

function checkLogin(login: string): void {
  if (!LOGIN_RE.test(login)) throw new GhError('other', `bad GitHub login ${JSON.stringify(login)}`);
}

type RawUser = { login?: string } | null;
type RawComment = { id: number; body?: string | null; user: RawUser; author_association?: string; created_at: string; updated_at: string };
type RawIssue = {
  number: number; title: string; body?: string | null; state: string; labels: ({ name: string } | string)[];
  user: RawUser; author_association?: string; html_url: string; pull_request?: unknown;
};

function toComment(c: RawComment): IssueComment {
  return {
    id: c.id, body: c.body ?? '', author: c.user?.login ?? '', authorAssociation: c.author_association ?? 'NONE',
    createdAt: c.created_at, updatedAt: c.updated_at,
  };
}

const ROLES: readonly Permission[] = ['admin', 'maintain', 'write', 'triage', 'read', 'none'];

export function requestsRepo(repo: string, gh: Gh = createGh()): RequestsRepo {
  checkRepo(repo);
  const base = `repos/${repo}`;
  let viewer: string | undefined;
  return {
    repo,
    async viewer() {
      if (viewer === undefined) {
        const u = await gh.api<{ login: string }>('user');
        checkLogin(u.login);
        viewer = u.login;
      }
      return viewer;
    },
    async issue(n) {
      const i = await gh.api<RawIssue>(`${base}/issues/${n}`);
      return {
        number: i.number, title: i.title, body: i.body ?? '', state: i.state === 'open' ? 'open' : 'closed',
        labels: i.labels.map((l) => (typeof l === 'string' ? l : l.name)), author: i.user?.login ?? '',
        authorAssociation: i.author_association ?? 'NONE', url: i.html_url, isPullRequest: i.pull_request !== undefined,
      };
    },
    async comments(n) {
      return (await gh.paginate<RawComment>(`${base}/issues/${n}/comments?per_page=100`)).map(toComment);
    },
    async comment(n, body) {
      return toComment(await gh.api<RawComment>(`${base}/issues/${n}/comments`, { method: 'POST', body: { body } }));
    },
    async editBody(n, body) {
      await gh.api(`${base}/issues/${n}`, { method: 'PATCH', body: { body } });
    },
    async deleteComment(id) {
      await gh.api(`${base}/issues/comments/${id}`, { method: 'DELETE' });
    },
    async addLabels(n, labels) {
      await gh.api(`${base}/issues/${n}/labels`, { method: 'POST', body: { labels } });
    },
    async removeLabel(n, label) {
      try {
        await gh.api(`${base}/issues/${n}/labels/${encodeURIComponent(label)}`, { method: 'DELETE' });
      } catch (e) {
        if (!(e instanceof GhError && e.kind === 'not_found')) throw e;
      }
    },
    async assign(n, login) {
      checkLogin(login);
      await gh.api(`${base}/issues/${n}/assignees`, { method: 'POST', body: { assignees: [login] } });
    },
    async unassign(n, login) {
      checkLogin(login);
      await gh.api(`${base}/issues/${n}/assignees`, { method: 'DELETE', body: { assignees: [login] } });
    },
    async permission(target, login) {
      checkRepo(target);
      checkLogin(login);
      let r: { permission?: string; role_name?: string };
      try {
        r = await gh.api(`repos/${target}/collaborators/${encodeURIComponent(login)}/permission`);
      } catch (e) {
        if (e instanceof GhError && e.kind === 'not_found') return 'none';
        throw e;
      }
      // `permission` folds maintain into write and triage into read; `role_name` keeps them.
      const role = ROLES.find((p) => p === r.role_name) ?? ROLES.find((p) => p === r.permission);
      return role ?? 'none';
    },
    async pullHead(target, n) {
      checkRepo(target);
      const p = await gh.api<{ head: { ref: string; sha: string; repo: { clone_url: string } | null } }>(`repos/${target}/pulls/${n}`);
      if (!p.head.repo) throw new GhError('not_found', `${target}#${n}: the pull request's head repo is gone`);
      return { ref: p.head.ref, sha: p.head.sha, cloneUrl: p.head.repo.clone_url };
    },
  };
}
