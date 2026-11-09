// Workspace setup for a claimed request (spec/v0.md §5, §6 `pr`): permission check, context zip, clone,
// `setup` commands and `check`, then AIR_TASK.md. Any failure sets `air:failed`, comments the failing
// step with the tail of setup.log, and releases the claim, all before an agent starts.
import { appendFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RequestsRepo } from '../gh/issues.ts';
import { CANCEL_LABEL, defaultHost, release } from '../claim/claim.ts';
import { code, fenced, tail } from '../claim/text.ts';
import { createTrust, markedComments, type Trust } from '../claim/trust.ts';
import { lint } from '../spec/lint.ts';
import type { Request } from '../spec/frontmatter.ts';
import { currentClaim } from '../spec/markers.ts';
import { fetchContext, type Download } from './context.ts';
import { childEnv } from './env.ts';
import { exec, SETUP_TIMEOUT_MS, type ExecResult } from './exec.ts';
import { cloneAt } from './git.ts';
import { airEnv } from './launch.ts';
import { activeWorkspace, LOG_FILE, REQUEST_FILE, TASK_FILE, updateState, type State } from './state.ts';
import { taskPrompt } from './task.ts';

export interface SetupOptions {
  gh: RequestsRepo;
  issue: number;
  root: string;
  host?: string;
  /** The requests repo's GitHub host; a `deliver: pr` repo must be on it. */
  ghHost?: string;
  download?: Download;
  /** Server environment the setup env's allowlist and git's env are taken from. */
  env?: NodeJS.ProcessEnv;
  /** Per-command timeout for setup, check and git (spec: 30 minutes). */
  timeoutMs?: number;
  trust?: Trust;
  now?: () => Date;
}

export type SetupResult =
  | { status: 'ready'; dir: string; state: State }
  | { status: 'failed'; dir: string; step: string; message: string }
  | { status: 'refused'; message: string };

class StepError extends Error {}

/** `owner/name` for a clone URL on `host`, or a reason it isn't one. */
export function githubRepo(url: string, host: string): { repo: string } | { error: string } {
  const m = /^https:\/\/([^/:]+)(:\d+)?\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url);
  if (!m) return { error: `${url} is not a https://${host}/OWNER/NAME repository URL` };
  if (m[1]!.toLowerCase() !== host.toLowerCase() || m[2]) return { error: `${url} is not on ${host}, the requests repo's host, so its permissions can't be checked` };
  if ([m[3], m[4]].some((p) => p === '.' || p === '..')) return { error: `${url} is not a repository URL` };
  return { repo: `${m[3]}/${m[4]}` };
}

function describe(r: ExecResult, timeoutMs: number): string {
  if (r.timedOut) return `timed out after ${timeoutMs >= 60_000 ? `${Math.round(timeoutMs / 60_000)} min` : `${timeoutMs / 1000} s`}`;
  if (r.signal) return `was killed by ${r.signal}`;
  return `exited ${r.code}`;
}

export async function setup(opts: SetupOptions): Promise<SetupResult> {
  const { gh, issue: n } = opts;
  const host = opts.host ?? defaultHost();
  const now = opts.now ?? (() => new Date());
  const trust = opts.trust ?? createTrust(gh);
  const timeoutMs = opts.timeoutMs ?? SETUP_TIMEOUT_MS;

  const ws = activeWorkspace(opts.root, gh.repo, n);
  if (!ws) return { status: 'refused', message: `no claim of ${gh.repo}#${n} on this machine: run \`air claim ${n}\` first` };
  const { dir } = ws;
  if (ws.state.phase !== 'claimed') {
    return { status: 'refused', message: `${dir} is ${ws.state.phase === 'ready' ? 'already set up' : 'a setup that was interrupted; release it and claim again'}` };
  }
  const body = readFileSync(join(dir, REQUEST_FILE), 'utf8');
  const linted = lint(body);
  if (!linted.ok || !linted.request) return { status: 'refused', message: `${join(dir, REQUEST_FILE)} no longer passes lint` };
  const request: Request = linted.request;

  // Make sure the claim is still ours before running anything.
  const issue = await gh.issue(n);
  if (issue.labels.includes(CANCEL_LABEL)) {
    await release({ gh, issue: n, root: opts.root, host, trust, now, nonce: ws.state.nonce });
    return { status: 'refused', message: `#${n} was cancelled; released` };
  }
  const holder = currentClaim(await markedComments(await gh.comments(n), trust));
  if (!holder || holder.host !== host || holder.nonce !== ws.state.nonce) {
    updateState(dir, { phase: 'lost' }, now());
    return { status: 'refused', message: `#${n} is no longer held by this claim (${holder ? `held by ${holder.host}` : 'released'})` };
  }

  let state = updateState(dir, { phase: 'setting-up' }, now());
  const log = join(dir, LOG_FILE);
  const note = (s: string) => appendFileSync(log, `[${now().toISOString()}] ${s}\n`);
  note(`setup of ${gh.repo}#${n} on ${host}, workspace ${dir}`);

  let step = 'setup';
  // `air claim` only takes requests with at most one repo, checked out at a `ref`.
  const repo = request.repos[0];
  try {
    // §6: before running anything for a PR, the issue author must be able to write to the target repo.
    if (request.deliver === 'pr') {
      step = 'the push permission check';
      const target = githubRepo(repo!.url, opts.ghHost ?? ((opts.env ?? process.env).GH_HOST || 'github.com'));
      if ('error' in target) throw new StepError(target.error);
      let role;
      try {
        role = await gh.permission(target.repo, state.author);
      } catch (e) {
        throw new StepError(`could not read ${state.author}'s permission on ${target.repo}: ${e instanceof Error ? e.message : String(e)}`);
      }
      note(`${state.author} has ${role} on ${target.repo}`);
      if (role !== 'admin' && role !== 'write' && role !== 'maintain') {
        throw new StepError(`@${state.author} has ${role} access to ${target.repo}; \`deliver: pr\` needs write or admin`);
      }
    }

    if (request.context) {
      step = 'the context download';
      note(`downloading context ${request.context.url} (${request.context.bytes} bytes)`);
      const zip = join(dir, '.context.zip');
      try {
        const written = await fetchContext(request.context, zip, join(dir, 'context'), opts.download);
        note(`context: extracted ${written} bytes`);
      } catch (e) {
        throw new StepError(e instanceof Error ? e.message : String(e));
      } finally {
        rmSync(zip, { force: true });
      }
    }

    if (repo) {
      step = 'the git clone';
      note(`git clone ${repo.url} at ${repo.ref}`);
      try {
        await cloneAt({
          url: repo.url, ref: repo.ref!, dest: join(dir, 'repo'), cwd: dir, log, env: opts.env ?? process.env, timeoutMs,
        });
      } catch (e) {
        throw new StepError(e instanceof Error ? e.message : String(e));
      }
    }

    const cwd = repo ? join(dir, 'repo') : dir;
    const env = childEnv(airEnv(dir), opts.env ?? process.env);
    const commands = [...request.setup.map((c, i) => ({ c, name: `setup command ${i + 1}` })), ...(request.check === undefined ? [] : [{ c: request.check, name: 'check' }])];
    for (const { c, name } of commands) {
      step = `${name} (${code(c)})`;
      note(`$ ${c}`);
      const r = await exec(['sh', '-c', c], { cwd, env, log, timeoutMs });
      note(`${name} ${describe(r, timeoutMs)}`);
      if (r.timedOut || r.code !== 0) throw new StepError(`${name} ${describe(r, timeoutMs)}`);
    }

    writeFileSync(join(dir, TASK_FILE), taskPrompt(state, request, body, dir));
    note('setup passed');
    state = updateState(dir, { phase: 'ready' }, now());
    return { status: 'ready', dir, state };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    note(`FAILED at ${step}: ${message}`);
    let logText = '';
    try {
      logText = readFileSync(log, 'utf8');
    } catch {
      // nothing logged
    }
    const detail = `${fenced(message)}\n\nLast lines of \`setup.log\`:\n\n${fenced(tail(logText))}`;
    const r = await release({ gh, issue: n, root: opts.root, host, trust, now, nonce: ws.state.nonce, failure: { step, detail } });
    if (r.status !== 'released') updateState(dir, { phase: 'lost', failure: step }, now());
    return { status: 'failed', dir, step, message };
  }
}
