// Cloning `repo.url` at `repo.ref` (spec/v0.md §5) with argv-only git, never a shell.
import { exec, SETUP_TIMEOUT_MS, type ExecResult } from './exec.ts';

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
  if (bad) throw new GitError(`refusing repo.ref ${JSON.stringify(ref)}: not a plain branch, tag or commit name`);
}

export function checkCloneUrl(url: string): void {
  if (!/^https:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/[A-Za-z0-9.\-_~%+=@:,/?]*)?$/.test(url)) throw new GitError(`refusing repo.url ${JSON.stringify(url)}`);
}

export interface CloneOptions {
  url: string;
  ref: string;
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

function describe(r: ExecResult): string {
  return r.timedOut ? 'timed out' : r.signal ? `killed by ${r.signal}` : `exited ${r.code}`;
}

/** `git clone` then check out `ref`: a branch (local branch tracking origin), a tag or a commit. */
export async function cloneAt(opts: CloneOptions): Promise<void> {
  checkRef(opts.ref);
  if (!opts.allowAnyUrl) checkCloneUrl(opts.url);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.env ?? process.env)) if (v !== undefined) env[k] = v;
  env.GIT_TERMINAL_PROMPT = '0';
  const run = async (args: string[], cwd: string) => exec(['git', ...args], { cwd, env, log: opts.log, timeoutMs: opts.timeoutMs ?? SETUP_TIMEOUT_MS });

  const clone = await run(['clone', '--quiet', '--no-checkout', '--', opts.url, opts.dest], opts.cwd);
  if (clone.code !== 0) throw new GitError(`git clone ${describe(clone)}`);
  const co = await run(['checkout', '--quiet', '--end-of-options', opts.ref, '--'], opts.dest);
  if (co.code === 0) return;
  // A commit that no branch or tag reaches isn't in the clone: fetch it by name.
  const fetch = await run(['fetch', '--quiet', '--end-of-options', 'origin', opts.ref], opts.dest);
  if (fetch.code !== 0) throw new GitError(`git could not find ref ${JSON.stringify(opts.ref)} (fetch ${describe(fetch)})`);
  const detached = await run(['checkout', '--quiet', '--detach', 'FETCH_HEAD', '--'], opts.dest);
  if (detached.code !== 0) throw new GitError(`git checkout ${describe(detached)}`);
}
