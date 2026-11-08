// `air serve` and the job commands: run, attach, stop, start, pause, resume. They share the serve context
// (requests repo, tmux, usage, log), and act on the job record in the workspace's state.json, so they work
// whether or not a server is running.
import { spawnSync } from 'node:child_process';
import { loadConfig, type Config } from '../config.ts';
import { createServer } from '../serve/server.ts';
import { serveContext, type ServeContext } from '../serve/context.ts';
import { claimHolds, ensureJob, jobOf, startAgent, stopAgent } from '../serve/jobs.ts';
import { acquireServeLock, readServerState, updateServerState } from '../serve/state.ts';
import { stateDir as usageStateDir } from '../usage/index.ts';
import { activeWorkspace, readState } from '../workspace/state.ts';
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
    await server.run({ once: inv.flags.once === true, signal: ctl.signal });
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
  await startAgent(ctx, dir);
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
  await startAgent(ctx, dir);
  inv.io.out(`started #${n}\n`);
  return 0;
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
