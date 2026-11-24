// The `repos` checks a server makes before it claims (spec/v0.md §5 Repos, §6 `pr`): every entry that gets a
// pull request is on the requests repo's host, its author may write to it and this server's account can push
// to it; then every entry is resolved to the commit it names now.
import type { RequestsRepo } from '../gh/index.ts';
import { code, type RepoEntry, type Request } from '../request/index.ts';
import { githubRepo, resolveRepo, type ResolveOptions } from '../lib/index.ts';
import type { ResolvedRepo } from '../workspace/state.ts';

const WRITE = ['write', 'maintain', 'admin'];

/** Whether `entry` gets a pull request: the request delivers `pr` and the entry isn't `deliver: none`. */
export function delivers(request: Request, entry: RepoEntry): boolean {
  return request.deliver === 'pr' && entry.deliver !== 'none';
}

export type RepoCheck =
  | { ok: true; repos: ResolvedRepo[] }
  /** `requester`: the request (or its author's access) must change; otherwise only this server can't serve it. */
  | { ok: false; requester: boolean; message: string };

export interface RepoCheckOptions {
  gh: RequestsRepo;
  request: Request;
  /** The issue author, whose write access a pull request needs. */
  author: string;
  /** This server's account, which pushes. */
  viewer: string;
  /** The requests repo's GitHub host. */
  ghHost: string;
  /** git's environment for resolving (the server's credentials). */
  env?: NodeJS.ProcessEnv;
  resolve?: (entry: RepoEntry, opts: ResolveOptions) => ReturnType<typeof resolveRepo>;
}

export async function checkRepos(o: RepoCheckOptions): Promise<RepoCheck> {
  const { gh, request } = o;
  const role = async (repo: string, login: string) => {
    try {
      return await gh.permission(repo, login);
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  };
  for (const [i, entry] of request.repos.entries()) {
    if (!delivers(request, entry)) continue;
    const name = `\`repos[${i}]\` (${code(entry.path)})`;
    const target = githubRepo(entry.url, o.ghHost);
    if ('error' in target) return { ok: false, requester: true, message: `${name}: ${target.error}; \`deliver: pr\` can only push there` };
    // Our own access first: without push, GitHub won't tell us anyone's role (403, read as none), and the
    // requester would be blamed for the server's lack.
    const mine = await role(target.repo, o.viewer);
    if (mine !== 'write' && mine !== 'maintain' && mine !== 'admin') {
      return { ok: false, requester: false, message: `${name}: this server's account (${o.viewer}) can't push to ${target.repo} (${typeof mine === 'string' ? `${mine} access` : mine.error})` };
    }
    const author = await role(target.repo, o.author);
    if (typeof author !== 'string') return { ok: false, requester: false, message: `${name}: could not read @${o.author}'s permission on ${target.repo}: ${author.error}` };
    if (!WRITE.includes(author)) {
      return { ok: false, requester: true, message: `${name}: @${o.author} has ${author} access to ${target.repo}; \`deliver: pr\` needs write or admin there` };
    }
  }
  const resolve = o.resolve ?? resolveRepo;
  const repos: ResolvedRepo[] = [];
  for (const [i, entry] of request.repos.entries()) {
    const r = await resolve(entry, { ...(o.env ? { env: o.env } : {}), branch: delivers(request, entry) });
    if ('error' in r) return { ok: false, requester: true, message: `\`repos[${i}]\` (${code(entry.path)}) can't be resolved to a commit: ${r.error}` };
    repos.push({ path: entry.path, sha: r.sha });
  }
  return { ok: true, repos };
}
