// Workspace setup for a claimed request (spec/v0.md §5): context zip, a clone of each repo at the commit it
// resolved to when claimed, the checkpoint of a resumed request, `setup` commands and `check`, then AIR_TASK.md. Any failure sets `air:failed`, comments the failing
// step with the tail of setup.log, and releases the claim, all before an agent starts.
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createGh } from '../gh/gh.ts';
import type { RequestsRepo } from '../gh/issues.ts';
import { CANCEL_LABEL, defaultHost, release } from '../claim/claim.ts';
import { code, fenced, tail } from '../claim/text.ts';
import { createTrust, markedComments, type Trust } from '../claim/trust.ts';
import { lint } from '../spec/lint.ts';
import type { Request } from '../spec/frontmatter.ts';
import { currentClaim } from '../spec/markers.ts';
import { fetchContext, releaseDownload, type Download } from './context.ts';
import { childEnv } from './env.ts';
import { exec, SETUP_TIMEOUT_MS, type ExecResult } from './exec.ts';
import { checkoutCheckpoint, cloneAt } from './git.ts';
import { airEnv } from './launch.ts';
import { activeWorkspace, LOG_FILE, REQUEST_FILE, updateState, type State } from './state.ts';
import { TASK_FILE, taskPrompt } from './task.ts';

export interface SetupOptions {
  gh: RequestsRepo;
  issue: number;
  root: string;
  host?: string;
  /** The requests repo's GitHub host: release assets there are downloaded through gh. */
  ghHost?: string;
  /** How zips are downloaded; default: release assets on `ghHost` through gh (`releaseDownload`). */
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
  const ghHost = opts.ghHost ?? ((opts.env ?? process.env).GH_HOST || 'github.com');
  const download = opts.download ?? releaseDownload(createGh(), ghHost);

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
  try {
    if (request.context) {
      step = 'the context download';
      note(`downloading context ${request.context.url} (${request.context.bytes} bytes)`);
      const zip = join(dir, '.context.zip');
      try {
        const written = await fetchContext(request.context, zip, join(dir, 'context'), download);
        note(`context: extracted ${written} bytes`);
      } catch (e) {
        throw new StepError(e instanceof Error ? e.message : String(e));
      } finally {
        rmSync(zip, { force: true });
      }
    }

    for (const entry of request.repos) {
      step = `the git clone of ${code(entry.path)}`;
      const sha = state.repos.find((r) => r.path === entry.path)?.sha;
      if (!sha) throw new StepError(`the claim recorded no commit for \`repo/${entry.path}\``);
      note(`git clone ${entry.url} at ${sha} into repo/${entry.path}`);
      const dest = join(dir, 'repo', entry.path);
      try {
        mkdirSync(dirname(dest), { recursive: true });
        await cloneAt({ url: entry.url, sha, dest, cwd: dir, log, env: opts.env ?? process.env, timeoutMs });
      } catch (e) {
        throw new StepError(e instanceof Error ? e.message : String(e));
      }
    }

    // §5 Resume: the checkpoint's branches and out/ replace the fresh checkouts and the empty out/.
    for (const b of request.resume?.branches ?? []) {
      step = `the checkpoint checkout of ${code(b.repo)}`;
      note(`checking out checkpoint ${b.sha} as ${b.branch} in repo/${b.repo}`);
      try {
        await checkoutCheckpoint({ dir: join(dir, 'repo', b.repo), sha: b.sha, branch: b.branch, log, env: opts.env ?? process.env, timeoutMs });
      } catch (e) {
        throw new StepError(e instanceof Error ? e.message : String(e));
      }
    }
    if (request.resume?.out) {
      step = 'the checkpoint download';
      note(`downloading checkpoint out/ ${request.resume.out.url} (${request.resume.out.bytes} bytes)`);
      const zip = join(dir, '.resume-out.zip');
      const out = join(dir, 'out');
      rmSync(out, { recursive: true, force: true }); // still empty: nothing has run yet
      try {
        const written = await fetchContext(request.resume.out, zip, out, download, { what: 'checkpoint zip (`resume.out`)', from: 'the request' });
        note(`checkpoint out/: extracted ${written} bytes`);
      } catch (e) {
        throw new StepError(e instanceof Error ? e.message : String(e));
      } finally {
        rmSync(zip, { force: true });
        mkdirSync(out, { recursive: true });
      }
    }

    const env = childEnv(airEnv(dir), opts.env ?? process.env);
    const commands = [...request.setup.map((c, i) => ({ c, name: `setup command ${i + 1}` })), ...(request.check === undefined ? [] : [{ c: request.check, name: 'check' }])];
    for (const { c, name } of commands) {
      step = `${name} (${code(c)})`;
      note(`$ ${c}`);
      const r = await exec(['sh', '-c', c], { cwd: dir, env, log, timeoutMs });
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
