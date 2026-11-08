// `air serve` and the job commands: run, attach, stop, start, pause, resume. They share the serve context
// (requests repo, tmux, usage, log), and act on the job record in the workspace's state.json, so they work
// whether or not a server is running.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, type Config } from '../config.ts';
import { createServer } from '../serve/server.ts';
import { serveContext, type ServeContext } from '../serve/context.ts';
import { claimHolds, ensureJob, jobOf, startOrDeliver, stopAgent } from '../serve/jobs.ts';
import { acquireServeLock, readServerState, updateServerState } from '../serve/state.ts';
import { stateDir as usageStateDir } from '../usage/index.ts';
import { clientEnv } from '../tmux/env.ts';
import { socketPath } from '../tmux/tmux.ts';
import { activeWorkspace, allWorkspaces, readState } from '../workspace/state.ts';
import type { Invocation } from './main.ts';
import { UsageError } from './requests.ts';

/** Injectable for tests. */
export const jobDeps = {
  loadConfig: (): Config => loadConfig(),
  context: (config: Config, repo: string, echo: (line: string) => void): ServeContext => serveContext(config, repo, { echo }),
  attach: (argv: string[]): number => spawnSync(argv[0]!, argv.slice(1), { stdio: 'inherit' }).status ?? 1,
  stateDir: (): string => usageStateDir(),
};

function contextFor(inv: Invocation): ServeContext {
  const flag = typeof inv.flags.repo === 'string' ? inv.flags.repo : undefined;
  if (flag !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(flag)) throw new UsageError('--repo must be OWNER/NAME');
  const config = jobDeps.loadConfig();
  const repo = flag ?? config.repo;
  if (!repo) throw new UsageError('no requests repo: pass --repo OWNER/NAME or set `repo` in the config');
  return jobDeps.context(config, repo, (line) => inv.io.err(`${line}\n`));
}

function issueArg(raw: string | undefined): number {
  const m = /^#?(\d+)$/.exec(raw ?? '');
  if (!m || Number(m[1]) < 1 || !Number.isSafeInteger(Number(m[1]))) throw new UsageError(`ISSUE must be an issue number, got ${JSON.stringify(raw)}`);
  return Number(m[1]);
}

function workspace(ctx: ServeContext, n: number): string {
  const ws = activeWorkspace(ctx.root, ctx.gh.repo, n);
  if (!ws) throw new UsageError(`no claim of ${ctx.gh.repo}#${n} on this machine`);
  return ws.dir;
}

export async function serveCommand(inv: Invocation): Promise<number> {
  const raw = inv.flags['once-wait'];
  if (raw !== undefined && inv.flags.once !== true) throw new UsageError('--once-wait needs --once');
  if (raw !== undefined && (typeof raw !== 'string' || !/^\d+$/.test(raw))) throw new UsageError(`--once-wait must be a number of seconds, got ${JSON.stringify(raw)}`);
  const onceWaitMs = typeof raw === 'string' ? Number(raw) * 1000 : undefined;
  const ctx = contextFor(inv);
  const unlock = acquireServeLock(ctx.stateDir);
  const server = createServer(ctx, { manual: inv.flags.manual === true });
  if (ctx.logFile) {
    try {
      await ctx.tmux.ensureSession({ argv: ['tail', '-n', '200', '-F', ctx.logFile] });
    } catch (e) {
      ctx.log(`tmux: ${(e as Error).message}`);
    }
  }
  const ctl = new AbortController();
  const stop = () => {
    ctx.log('stopping: running agents keep going in tmux and are re-adopted on the next `air serve`');
    ctl.abort();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await server.run({ once: inv.flags.once === true, signal: ctl.signal, ...(onceWaitMs !== undefined ? { onceWaitMs } : {}) });
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    unlock();
  }
  return 0;
}

export async function runCommand(inv: Invocation): Promise<number> {
  const n = issueArg(inv.positionals[0]);
  const ctx = contextFor(inv);
  const dir = workspace(ctx, n);
  const job = await ensureJob(ctx, dir);
  if (job.status !== 'ready') throw new UsageError(`#${n} is ${job.status}, not waiting to run${job.status === 'paused' ? ` (use \`air start ${n}\`)` : ''}`);
  if (!(await claimHolds(ctx, readState(dir)))) throw new UsageError(`#${n} is no longer held by this machine's claim`);
  if ((await startOrDeliver(ctx, dir)) === 'delivered') return delivered(inv, dir, n);
  inv.io.out(`started #${n}; watch it with \`air attach ${n}\`\n`);
  return 0;
}

export async function attachCommand(inv: Invocation): Promise<number> {
  const n = inv.positionals[0] === undefined ? undefined : issueArg(inv.positionals[0]);
  const ctx = contextFor(inv);
  return jobDeps.attach(await ctx.tmux.attachArgs(n));
}

export async function stopCommand(inv: Invocation): Promise<number> {
  const n = issueArg(inv.positionals[0]);
  const ctx = contextFor(inv);
  const dir = workspace(ctx, n);
  if (!(await stopAgent(ctx, dir, 'operator'))) throw new UsageError(`#${n} is not running`);
  inv.io.out(`stopped #${n}; claim and workspace kept. \`air start ${n}\` resumes it\n`);
  return 0;
}

export async function startCommand(inv: Invocation): Promise<number> {
  const n = issueArg(inv.positionals[0]);
  const ctx = contextFor(inv);
  const dir = workspace(ctx, n);
  const state = readState(dir);
  const job = jobOf(state);
  if (job.status !== 'paused') throw new UsageError(`#${n} is ${job.status}, not paused`);
  if (!(await claimHolds(ctx, state))) throw new UsageError(`#${n} is no longer held by this machine's claim`);
  if ((await startOrDeliver(ctx, dir)) === 'delivered') return delivered(inv, dir, n);
  inv.io.out(`started #${n}\n`);
  return 0;
}

/** Reports a delivery `startOrDeliver` made in place of a start (AIR_DONE was already there). */
function delivered(inv: Invocation, dir: string, n: number): number {
  const state = readState(dir);
  const job = state.job;
  if (job?.status === 'done') {
    inv.io.out(`#${n} had already finished (AIR_DONE); delivered it\n`);
    return 0;
  }
  if (job?.status === 'delivering') {
    inv.io.err(`#${n} had already finished (AIR_DONE), but its delivery failed: ${job.lastError ?? 'unknown error'}; \`air serve\` retries it\n`);
  } else if (state.phase === 'lost') {
    inv.io.err(`#${n} is no longer held by this machine's claim; nothing was delivered\n`);
  } else {
    inv.io.err(`#${n} had already finished (AIR_DONE), but delivery failed${job?.failure ? ` at ${job.failure.step}` : ''}; the request is released as failed\n`);
  }
  return 1;
}

export function pauseCommand(inv: Invocation): number {
  const stateDir = jobDeps.stateDir();
  if (readServerState(stateDir).paused) inv.io.out('already paused\n');
  else updateServerState(stateDir, { paused: true, pausedAt: new Date().toISOString() });
  inv.io.out('air serve takes no new work until `air resume`; running jobs continue\n');
  return 0;
}

export function resumeCommand(inv: Invocation): number {
  const stateDir = jobDeps.stateDir();
  updateServerState(stateDir, { paused: false, pausedAt: undefined });
  inv.io.out('air serve takes new work again\n');
  return 0;
}

/**
 * `air debug panes` (not in the help): what tmux reports and what air makes of it, to diagnose a job whose
 * window air cannot see. Rows are JSON strings so tabs show as \\t (a `_` in their place is the locale bug).
 */
export async function debugCommand(inv: Invocation): Promise<number> {
  if (inv.positionals[0] !== 'panes') throw new UsageError('the only debug topic is `panes`');
  const ctx = contextFor(inv);
  const out = (s: string) => inv.io.out(`${s}\n`);
  const env = clientEnv();
  const version = spawnSync('tmux', ['-V'], { env, encoding: 'utf8' });
  out(`tmux: ${(version.stdout ?? '').trim() || `not runnable (${version.error?.message ?? version.stderr})`}`);
  out(`socket: ${socketPath(ctx.tmux.socket)} (-L ${ctx.tmux.socket}), session ${ctx.tmux.session}`);
  out(`client locale: LC_ALL=${JSON.stringify(process.env.LC_ALL ?? '')} LC_CTYPE=${JSON.stringify(process.env.LC_CTYPE ?? '')} LANG=${JSON.stringify(process.env.LANG ?? '')}`);
  const raw = await ctx.tmux.listPanesRaw();
  out(`format: ${JSON.stringify(raw.format)}`);
  out(`list-panes -a, as air runs it (tmux -u): exit ${raw.code}${raw.stderr.trim() ? `, stderr ${JSON.stringify(raw.stderr.trim())}` : ''}`);
  for (const line of raw.stdout.split('\n').filter(Boolean)) out(`  ${JSON.stringify(line)}`);
  const plain = spawnSync('tmux', ['-L', ctx.tmux.socket, 'list-panes', '-a', '-F', raw.format], { env, encoding: 'utf8' });
  out(`list-panes -a without -u (the old way): exit ${plain.status}`);
  for (const line of (plain.stdout ?? '').split('\n').filter(Boolean)) out(`  ${JSON.stringify(line)}`);
  let jobs: Awaited<ReturnType<ServeContext['tmux']['listJobs']>> = [];
  try {
    jobs = await ctx.tmux.listJobs();
    out(`jobs air parses: ${jobs.length}`);
    for (const j of jobs) out(`  #${j.issue} nonce ${j.nonce} window ${j.windowId} pane ${j.paneId} pid ${j.pid} ${j.dead ? `dead (status ${j.exitStatus ?? '-'}, signal ${j.exitSignal ?? '-'})` : 'alive'}`);
  } catch (e) {
    out(`jobs air parses: listJobs failed: ${(e as Error).message}`);
  }
  const held = allWorkspaces(ctx.root, ctx.gh.repo).filter((w) => w.state.job && !['done', 'failed', 'cancelled'].includes(w.state.job.status));
  out(`jobs air holds (${ctx.root}): ${held.length}`);
  for (const { dir, state } of held) {
    const job = state.job!;
    const found = jobs.find((j) => j.issue === state.issue && j.nonce === job.paneNonce);
    out(`  #${state.issue} ${state.phase}/${job.status} paneNonce ${job.paneNonce ?? '(none)'}: ${found ? `window ${found.windowId}` : 'NO MATCHING PANE'}${existsSync(join(dir, 'AIR_DONE')) ? ', AIR_DONE present' : ''} (${dir})`);
  }
  return 0;
}
