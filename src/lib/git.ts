// Resolving `repos` entries to commits and cloning them (spec/v0.md §5) with argv-only git, never a shell.
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exec, SETUP_TIMEOUT_MS, type ExecResult } from './exec.ts';

/** Resolving a repo at claim time (ls-remote, or a treeless clone for a commit). */
export const RESOLVE_TIMEOUT_MS = 10 * 60_000;

export class GitError extends Error {}

/**
 * Refs git would read as an option, or that aren't plain branch, tag or commit names (revision syntax
 * like `a..b`, `x^`, `@{1}`, `:path`), are refused before git ever sees them.
 */
export function checkRef(ref: string): void {
  const bad =
    ref === '' || ref.startsWith('-') || ref.startsWith('/') || ref.endsWith('/') || ref.endsWith('.') || ref.endsWith('.lock') ||
    ref === '@' || /[\x00-\x20\x7f~^:?*[\\]/.test(ref) || ref.includes('..') || ref.includes('@{') || ref.includes('//') ||
    ref.split('/').some((s) => s.startsWith('.'));
  if (bad) throw new GitError(`refusing ref ${JSON.stringify(ref)}: not a plain branch, tag or commit name`);
}

export function checkCloneUrl(url: string): void {
  if (!/^https:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/[A-Za-z0-9.\-_~%+=@:,/?]*)?$/.test(url)) throw new GitError(`refusing repo url ${JSON.stringify(url)}`);
}

export interface CloneOptions {
  url: string;
  /** Full commit SHA to check out (the one the entry resolved to at claim time). */
  sha: string;
  /** Destination directory; must not exist. */
  dest: string;
  /** Directory git runs in for the clone itself. */
  cwd: string;
  log: string;
  /** git's environment. The server's own git needs its credential setup, but never a prompt. */
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Accept non-https URLs (tests clone local bare repos). */
  allowAnyUrl?: boolean;
}

/**
 * Why a git command failed, in one line: its first `fatal:` or `error:` line (git follows it with more general
 * lines and hints such as "and the repository exists."), else its last line, else its exit status.
 */
export function gitFailure(r: { code: number; stderr: string }): string {
  const lines = r.stderr.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => /^(?:fatal|error):/.test(l)) ?? lines.at(-1) ?? `exit ${r.code}`;
}

function describe(r: ExecResult): string {
  return r.timedOut ? 'timed out' : r.signal ? `killed by ${r.signal}` : `exited ${r.code}`;
}

function gitEnv(base: NodeJS.ProcessEnv | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base ?? process.env)) if (v !== undefined) env[k] = v;
  env.GIT_TERMINAL_PROMPT = '0';
  return env;
}

/** `git clone`, then check out commit `sha` detached (fetched by SHA if no branch or tag reaches it). */
export async function cloneAt(opts: CloneOptions): Promise<void> {
  if (!isFullSha(opts.sha)) throw new GitError(`refusing commit ${JSON.stringify(opts.sha)}: not a full SHA`);
  if (!opts.allowAnyUrl) checkCloneUrl(opts.url);
  const env = gitEnv(opts.env);
  const run = async (args: string[], cwd: string) => exec(['git', ...args], { cwd, env, log: opts.log, timeoutMs: opts.timeoutMs ?? SETUP_TIMEOUT_MS });

  const clone = await run(['clone', '--quiet', '--no-checkout', '--', opts.url, opts.dest], opts.cwd);
  if (clone.code !== 0) throw new GitError(`git clone ${describe(clone)}`);
  if ((await run(['cat-file', '-e', `${opts.sha}^{commit}`], opts.dest)).code !== 0) {
    const fetch = await run(['fetch', '--quiet', '--no-tags', 'origin', opts.sha], opts.dest);
    if (fetch.code !== 0) throw new GitError(`git could not fetch commit ${opts.sha} (fetch ${describe(fetch)})`);
  }
  const co = await run(['checkout', '--quiet', '--detach', opts.sha, '--'], opts.dest);
  if (co.code !== 0) throw new GitError(`git checkout of ${opts.sha} ${describe(co)}`);
}

export function isFullSha(s: string): boolean {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(s);
}

/** Runs git and captures its output (argv only, no prompt, killed on timeout). */
export function gitOut(args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: opts.cwd, env: gitEnv(opts.env), timeout: opts.timeoutMs ?? SETUP_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 64 << 20 },
      (err, stdout, stderr) => {
        const c = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
        resolve({ code: c, stdout: String(stdout), stderr: String(stderr) });
      });
  });
}

/** `owner/name` for a clone URL on `host`, or a reason it isn't one. */
export function githubRepo(url: string, host: string): { repo: string } | { error: string } {
  const m = /^https:\/\/([^/:]+)(:\d+)?\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url);
  if (!m) return { error: `${url} is not a https://${host}/OWNER/NAME repository URL` };
  if (m[1]!.toLowerCase() !== host.toLowerCase() || m[2]) return { error: `${url} is not on ${host}, the requests repo's host, so its permissions can't be checked` };
  if ([m[3], m[4]].some((p) => p === '.' || p === '..')) return { error: `${url} is not a repository URL` };
  return { repo: `${m[3]}/${m[4]}` };
}

export interface ResolveOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** The entry gets a pull request (`deliver: pr`, not `deliver: none`): its `ref` must be a branch. */
  branch?: boolean;
  /** Accept non-https URLs (tests use local bare repos). */
  allowAnyUrl?: boolean;
}

/** What `resolveRepo` reads of a `repos` entry: its URL and exactly one of `ref` and `pr`. */
interface RepoRef {
  url: string;
  ref?: string;
  pr?: number;
}

/**
 * Resolves a `repos` entry to the full commit SHA it names now (spec/v0.md §5 Repos): a branch or tag to its
 * commit, a `pr` to `refs/pull/<pr>/head`, and any other `ref` to the commit it abbreviates or names, looked
 * up in a treeless bare clone. Resolves to the SHA, or to why the entry can't be resolved.
 */
export async function resolveRepo(entry: RepoRef, opts: ResolveOptions = {}): Promise<{ sha: string } | { error: string }> {
  try {
    if (!opts.allowAnyUrl) checkCloneUrl(entry.url);
    if (entry.ref !== undefined) checkRef(entry.ref);
  } catch (e) {
    return { error: (e as Error).message };
  }
  const tmp = mkdtempSync(join(tmpdir(), 'air-resolve-'));
  const g = (args: string[]) => gitOut(['-c', 'core.hooksPath=/dev/null', ...args], { cwd: tmp, env: opts.env, timeoutMs: opts.timeoutMs ?? RESOLVE_TIMEOUT_MS });
  try {
    const wanted = entry.pr !== undefined ? [`refs/pull/${entry.pr}/head`] : [`refs/heads/${entry.ref}`, `refs/tags/${entry.ref}`, `refs/tags/${entry.ref}^{}`];
    const ls = await g(['ls-remote', '--', entry.url, ...wanted]);
    if (ls.code !== 0) return { error: `git ls-remote ${entry.url} failed: ${gitFailure(ls)}` };
    const refs = new Map(ls.stdout.split('\n').filter(Boolean).map((l) => {
      const [sha, ref] = l.split('\t');
      return [ref!, sha!] as const;
    }));
    const found = (r: string) => (refs.has(r) && isFullSha(refs.get(r)!) ? refs.get(r) : undefined);
    if (entry.pr !== undefined) {
      const sha = found(wanted[0]!);
      return sha ? { sha } : { error: `pull request #${entry.pr} of ${entry.url} was not found (no \`refs/pull/${entry.pr}/head\`)` };
    }
    const ref = entry.ref!;
    const branch = found(`refs/heads/${ref}`);
    if (branch) return { sha: branch };
    if (opts.branch) return { error: `\`${ref}\` is not a branch of ${entry.url}, and \`deliver: pr\` opens a pull request against it` };
    const tag = found(`refs/tags/${ref}^{}`) ?? found(`refs/tags/${ref}`);
    if (tag) return { sha: tag };
    if (!/^[0-9a-f]{4,64}$/.test(ref)) return { error: `\`${ref}\` is not a branch, tag or commit of ${entry.url}` };
    // A commit, maybe abbreviated: look it up among the commits of every branch and tag.
    // Used through an explicit --git-dir: with safe.bareRepository=explicit, git won't find it from its cwd.
    const bare = join(tmp, 'r.git');
    const clone = await g(['clone', '--quiet', '--bare', '--filter=tree:0', '--', entry.url, bare]);
    if (clone.code !== 0) return { error: `git clone ${entry.url} failed: ${gitFailure(clone)}` };
    const parse = async () => {
      const r = await g(['--git-dir', bare, 'rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]);
      const sha = r.stdout.trim();
      return r.code === 0 && isFullSha(sha) ? sha : undefined;
    };
    let sha = await parse();
    // A full SHA no branch or tag reaches (say a pull request's) can still be fetched by name.
    if (!sha && isFullSha(ref) && (await g(['--git-dir', bare, 'fetch', '--quiet', '--no-tags', 'origin', ref])).code === 0) sha = await parse();
    return sha ? { sha } : { error: `\`${ref}\` is not a branch, tag or commit of ${entry.url}` };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export interface CheckpointOptions {
  /** The clone (its `origin` is the repo's url). */
  dir: string;
  /** Full commit SHA the checkpoint pushed. */
  sha: string;
  /** The local branch to put it on. */
  branch: string;
  log: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/** Fetches checkpoint commit `sha` from `origin` and checks it out on local branch `branch` (spec §5 Resume). */
export async function checkoutCheckpoint(opts: CheckpointOptions): Promise<void> {
  if (!isFullSha(opts.sha)) throw new GitError(`refusing checkpoint sha ${JSON.stringify(opts.sha)}`);
  checkRef(opts.branch);
  const env = gitEnv(opts.env);
  const run = async (args: string[]) => exec(['git', ...args], { cwd: opts.dir, env, log: opts.log, timeoutMs: opts.timeoutMs ?? SETUP_TIMEOUT_MS });
  const fetch = await run(['fetch', '--quiet', '--no-tags', 'origin', opts.sha]);
  if (fetch.code !== 0) throw new GitError(`git could not fetch checkpoint commit ${opts.sha} (fetch ${describe(fetch)})`);
  const co = await run(['checkout', '--quiet', '-B', opts.branch, opts.sha, '--']);
  if (co.code !== 0) throw new GitError(`git could not check out checkpoint ${opts.sha} as ${opts.branch} (${describe(co)})`);
}
