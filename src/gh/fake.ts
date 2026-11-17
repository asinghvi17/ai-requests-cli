// In-memory RequestsRepo for tests: one repo's issues, comments, labels, assignees and permissions.
import { GhError } from './gh.ts';
import type { Issue, IssueComment, Permission, PullHead, RequestsRepo } from './issues.ts';

export interface FakeIssue extends Issue {
  assignees: string[];
  comments: IssueComment[];
}

export interface FakeGitHub extends RequestsRepo {
  issues: Map<number, FakeIssue>;
  /** `owner/name` -> login -> role. Missing entries are `none`. */
  permissions: Map<string, Map<string, Permission>>;
  /** `owner/name#n` -> head, for `pullHead`. */
  pulls: Map<string, PullHead>;
  /** The repo's labels. Adding a label to an issue creates it, as GitHub does. */
  labels: Set<string>;
  /** Every call, as `method arg...`, for asserting on order. */
  log: string[];
  /** Runs after `comments()` takes its snapshot: lets a test post a rival's comment mid-race. */
  onComments?: (n: number) => void;
  /** The same repo seen by another account (another server), sharing all state. */
  as(viewer: string, association?: string): FakeGitHub;
  addIssue(i: Partial<Issue> & { body: string }): FakeIssue;
  /** Posts a comment as `author`, as GitHub would (fresh id, equal created/updated). */
  post(n: number, author: string, association: string, body: string): IssueComment;
  setPermission(repo: string, login: string, role: Permission): void;
}

interface Store {
  nextId: number;
  issues: Map<number, FakeIssue>;
  permissions: Map<string, Map<string, Permission>>;
  pulls: Map<string, PullHead>;
  labels: Set<string>;
  log: string[];
}

export function fakeGitHub(opts: { repo?: string; viewer?: string; viewerAssociation?: string } = {}, store?: Store): FakeGitHub {
  const repo = opts.repo ?? 'o/requests';
  const me = opts.viewer ?? 'bot';
  const st: Store = store ?? { nextId: 1000, issues: new Map(), permissions: new Map(), pulls: new Map(), labels: new Set(['ai-request']), log: [] };
  const clock = () => new Date(Date.UTC(2026, 10, 7, 12, 0, 0) + st.nextId * 1000).toISOString();
  const { issues, permissions, pulls } = st;
  const log = { push: (s: string) => st.log.push(me === 'bot' ? s : `${me}: ${s}`) };
  const get = (n: number) => {
    const i = issues.get(n);
    if (!i) throw new GhError('not_found', 'Not Found (HTTP 404)', 404);
    return i;
  };
  const gh: FakeGitHub = {
    repo, issues, permissions, pulls, labels: st.labels, log: st.log,
    as(viewer, association) {
      return fakeGitHub({ repo, viewer, viewerAssociation: association ?? 'OWNER' }, st);
    },
    addIssue(i) {
      const number = i.number ?? issues.size + 1;
      const issue: FakeIssue = {
        number, title: 'A request', state: 'open', labels: ['ai-request'], author: 'alice', authorAssociation: 'OWNER',
        url: `https://github.com/${repo}/issues/${number}`, isPullRequest: false, assignees: [], comments: [], ...i,
      };
      issues.set(number, issue);
      for (const l of issue.labels) st.labels.add(l);
      return issue;
    },
    post(n, author, association, body) {
      const t = clock();
      const c: IssueComment = { id: st.nextId++, body, author, authorAssociation: association, createdAt: t, updatedAt: t };
      get(n).comments.push(c);
      return c;
    },
    setPermission(r, login, role) {
      if (!permissions.has(r)) permissions.set(r, new Map());
      permissions.get(r)!.set(login, role);
    },
    async viewer() {
      return me;
    },
    async issue(n) {
      log.push(`issue ${n}`);
      const { assignees: _a, comments: _c, ...rest } = get(n);
      return { ...rest, labels: [...rest.labels] };
    },
    async comments(n) {
      log.push(`comments ${n}`);
      const snapshot = get(n).comments.map((c) => ({ ...c }));
      gh.onComments?.(n);
      return snapshot;
    },
    async comment(n, body) {
      log.push(`comment ${n}`);
      return { ...gh.post(n, me, opts.viewerAssociation ?? 'OWNER', body) };
    },
    async editBody(n, body) {
      log.push(`editBody ${n}`);
      get(n).body = body;
    },
    async deleteComment(id) {
      log.push(`deleteComment ${id}`);
      for (const i of issues.values()) {
        const k = i.comments.findIndex((c) => c.id === id);
        if (k >= 0) {
          i.comments.splice(k, 1);
          return;
        }
      }
      throw new GhError('not_found', 'Not Found (HTTP 404)', 404);
    },
    async addLabels(n, labels) {
      log.push(`addLabels ${n} ${labels.join(',')}`);
      const i = get(n);
      for (const l of labels) {
        if (!i.labels.includes(l)) i.labels.push(l);
        st.labels.add(l);
      }
    },
    async removeLabel(n, label) {
      log.push(`removeLabel ${n} ${label}`);
      const i = get(n);
      i.labels = i.labels.filter((l) => l !== label);
    },
    async ensureLabels(want) {
      const created = want.map((l) => l.name).filter((name) => !st.labels.has(name));
      log.push(`ensureLabels ${created.join(',')}`);
      for (const name of created) st.labels.add(name);
      return created;
    },
    async assign(n, login) {
      log.push(`assign ${n} ${login}`);
      const i = get(n);
      if (!i.assignees.includes(login)) i.assignees.push(login);
    },
    async unassign(n, login) {
      log.push(`unassign ${n} ${login}`);
      const i = get(n);
      i.assignees = i.assignees.filter((a) => a !== login);
    },
    async permission(r, login) {
      log.push(`permission ${r} ${login}`);
      return permissions.get(r)?.get(login) ?? 'none';
    },
    async pullHead(r, n) {
      log.push(`pullHead ${r} ${n}`);
      const p = pulls.get(`${r}#${n}`);
      if (!p) throw new GhError('not_found', 'Not Found (HTTP 404)', 404);
      return { ...p };
    },
  };
  return gh;
}
