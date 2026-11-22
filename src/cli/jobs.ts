// `air serve` and the job commands: run, attach, stop, start, pause, resume. They share the serve context
// (requests repo, tmux, usage, log), and act on the job record in the workspace's state.json, so they work
// whether or not a server is running.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { configPath, loadConfig, type Config } from '../config.ts';
import { createServer } from '../serve/server.ts';
import { serveContext, type ServeContext } from '../serve/context.ts';
import { claimHolds, ensureJob, jobOf, startOrDeliver, stopAgent } from '../serve/jobs.ts';
import { acquireServeLock, readServerState, serving, updateServerState } from '../serve/state.ts';
import { configFile as subscriptionsFile, loadConfig as loadSubscriptions, stateDir as usageStateDir } from '../usage/index.ts';
import { defaultPreflightDeps, formatPreflight, loginsOf, preflight, refusals, type AgentCheck } from '../serve/preflight.ts';
import { clientEnv, jobEnv } from '../tmux/env.ts';
import { attachTo, socketPath } from '../tmux/tmux.ts';
import { activeWorkspace, allWorkspaces, ENDED, readState } from '../workspace/state.ts';
import { ensureConfig, ensureGh, firstRunDeps, fixTrust } from './firstrun.ts';
import type { Invocation } from './main.ts';
import { CommandError, UsageError } from './requests.ts';

/** Injectable for tests. */
export const jobDeps = {
  loadConfig: (): Config => loadConfig(),
  context: (config: Config, repo: string, echo: (line: string) => void): ServeContext => serveContext(config, repo, { echo }),
  attach: (argv: string[]): number => spawnSync(argv[0]!, argv.slice(1), { stdio: 'inherit' }).status ?? 1,
  stateDir: (): string => usageStateDir(),
  /** Checks the logins config.toml serves. */
  preflight: (config: Config): AgentCheck[] => preflight(config, loginsOf(loadSubscriptions(subscriptionsFile()).filter((s) => Object.hasOwn(config.subscriptions, s.name)), config), defaultPreflightDeps(configPath())),
  env: (): NodeJS.ProcessEnv => process.env,
  /** argv that runs this air: the single binary, or node and the entry script. */
  self: (): string[] => (process.argv[1]?.startsWith('/$bunfs/') ? [process.execPath] : [process.execPath, ...process.execArgv, process.argv[1]!]),
};

/**
 * Wraps the server in its tmux window: a no-op INT trap keeps this shell up while air shuts down on C-c, and
 * after a failure the window stays open until Enter, so its last words can be read.
 */
const HOLD = ['/bin/sh', '-c', 'trap : INT; "$@"; s=$?; [ "$s" -eq 0 ] || { printf "\\nair serve exited with status %s; press Enter to close this window\\n" "$s"; read -r _; }; exit "$s"', 'air'];

function repoFlag(inv: Invocation): string | undefined {
  const flag = typeof inv.flags.repo === 'string' ? inv.flags.repo : undefined;
  if (flag !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(flag)) throw new UsageError('--repo must be OWNER/NAME');
  return flag;
}

function contextFor(inv: Invocation): ServeContext {
  const flag = repoFlag(inv);
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
  if (!ws) throw new CommandError(`no claim of ${ctx.gh.repo}#${n} on this machine`);
  return ws.dir;
}

export async function serveCommand(inv: Invocation): Promise<number> {
  const raw = inv.flags['once-wait'];
  if (raw !== undefined && inv.flags.once !== true) throw new UsageError('--once-wait needs --once');
  if (raw !== undefined && (typeof raw !== 'string' || !/^\d+$/.test(raw))) throw new UsageError(`--once-wait must be a number of seconds, got ${JSON.stringify(raw)}`);
  const onceWaitMs = typeof raw === 'string' ? Number(raw) * 1000 : undefined;
  const env = jobDeps.env();
  const once = inv.flags.once === true;
  const inAir = env.TMUX?.split(',')[0] === socketPath('air', env);
  // On a terminal, a running server is joined: its `serve` window from inside air's tmux, else the session.
  // `--once` never joins: it serves in place, and the serve lock refuses it.
  if (!once && firstRunDeps.isTTY() && serving(jobDeps.stateDir())) {
    inv.io.out(inAir
      ? 'air serve is already running in this tmux session; switching to its `serve` window\n'
      : 'air serve is already running; attaching (detach with C-b d)\n');
    return jobDeps.attach(attachTo('air', inAir ? '=air:=serve' : '=air', env));
  }
  // On the volunteer's own terminal: set up what's missing and start the server in tmux. In air's tmux
  // (where that server runs) and off a terminal, just serve.
  const interactive = firstRunDeps.isTTY() && !inAir;
  if (interactive) {
    if (!(await ensureGh(inv.io, true))) return 1;
    await ensureConfig(inv.io, repoFlag(inv), true);
  }
  const ctx = contextFor(inv);
  if (!(await tmuxUsable(ctx, inv))) return 1;
  // An agent that can't run unattended would sit at a prompt with the claim held: take no work for it.
  let checks = jobDeps.preflight(ctx.config);
  inv.io.err(formatPreflight(checks, interactive));
  if (interactive && (await fixTrust(inv.io, checks))) {
    checks = jobDeps.preflight(ctx.config);
    inv.io.err(`\n${formatPreflight(checks, true)}`);
  }
  if (interactive && !env.TMUX && !once) {
    const serverEnv = jobEnv({}, env);
    delete serverEnv.TERM; // the window's is tmux's
    const { window, joined } = await ctx.tmux.startServer([...HOLD, ...jobDeps.self(), 'serve', ...inv.argv], serverEnv);
    if (joined) inv.io.out('joining an existing air tmux session (from an earlier run)\n');
    inv.io.out('air serve runs in tmux: detach with C-b d and it keeps serving; `air serve` again comes back\n');
    return jobDeps.attach(await ctx.tmux.attachArgs(window, env));
  }
  ctx.refused = refusals(checks);
  for (const [name, why] of Object.entries(ctx.refused)) ctx.log(`not serving ${name}: ${why} (the startup report gives the fix)`);
  let unlock: () => void;
  try {
    unlock = acquireServeLock(ctx.stateDir);
  } catch (e) {
    throw new CommandError((e as Error).message);
  }
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
    // With no job window left, air's tmux session and server end with it (from its `serve` window: as it closes).
    try {
      if (await ctx.tmux.closeIfIdle(inAir ? env.TMUX_PANE : undefined)) ctx.log('stopped; no job windows were left, so the air tmux session ends');
    } catch (e) {
      ctx.log(`tmux: ${(e as Error).message}`);
    }
  }
  return 0;
}

/** Checks tmux (present, new enough) before anything starts an agent; prints why not. */
async function tmuxUsable(ctx: ServeContext, inv: Invocation): Promise<boolean> {
  try {
    await ctx.tmux.checkVersion();
    return true;
  } catch (e) {
    inv.io.err(`air: ${(e as Error).message}\n`);
    return false;
  }
}

export async function runCommand(inv: Invocation): Promise<number> {
  const n = issueArg(inv.positionals[0]);
  const ctx = contextFor(inv);
  if (!(await tmuxUsable(ctx, inv))) return 1;
  const dir = workspace(ctx, n);
  const job = await ensureJob(ctx, dir);
  if (job.status !== 'ready') throw new CommandError(`#${n} is ${job.status}, not waiting to run${job.status === 'paused' ? ` (use \`air start ${n}\`)` : ''}`);
  if (!(await claimHolds(ctx, readState(dir)))) throw new CommandError(`#${n} is no longer held by this machine's claim`);
  const how = await startOrDeliver(ctx, dir);
  if (how !== 'started') return delivered(inv, dir, n, how);
  inv.io.out(`started #${n}; watch it with \`air attach ${n}\`\n`);
  return 0;
}

export async function attachCommand(inv: Invocation): Promise<number> {
  const n = issueArg(inv.positionals[0]);
  const ctx = contextFor(inv);
  return jobDeps.attach(await ctx.tmux.attachArgs(n));
}

export async function stopCommand(inv: Invocation): Promise<number> {
  const n = issueArg(inv.positionals[0]);
  const ctx = contextFor(inv);
  const dir = workspace(ctx, n);
  if (!(await stopAgent(ctx, dir, 'operator'))) throw new CommandError(`#${n} is not running`);
  inv.io.out(`stopped #${n}; claim and workspace kept. \`air start ${n}\` resumes it\n`);
  return 0;
}

export async function startCommand(inv: Invocation): Promise<number> {
  const n = issueArg(inv.positionals[0]);
  const ctx = contextFor(inv);
  if (!(await tmuxUsable(ctx, inv))) return 1;
  const dir = workspace(ctx, n);
  const state = readState(dir);
  const job = jobOf(state);
  if (job.status !== 'paused') throw new CommandError(`#${n} is ${job.status}, not paused`);
  if (!(await claimHolds(ctx, state))) throw new CommandError(`#${n} is no longer held by this machine's claim`);
  const how = await startOrDeliver(ctx, dir);
  if (how !== 'started') return delivered(inv, dir, n, how);
  inv.io.out(`started #${n}\n`);
  return 0;
}

/** Reports a delivery `startOrDeliver` made (or left to another process) in place of a start (AIR_DONE was already there). */
function delivered(inv: Invocation, dir: string, n: number, how: Exclude<Awaited<ReturnType<typeof startOrDeliver>>, 'started'>): number {
  if (how === 'delivering-elsewhere') {
    inv.io.out(`#${n} had already finished (AIR_DONE); another air process (such as \`air serve\`) is delivering it\n`);
    return 0;
  }
  if (how === 'delivered') {
    inv.io.out(`#${n} had already finished (AIR_DONE); delivered it and removed its workspace\n`);
    return 0;
  }
  const state = readState(dir);
  const job = state.job;
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
    for (const j of jobs) out(`  #${j.issue} nonce ${j.nonce} window ${j.windowId} pane ${j.paneId} agent pid ${j.pid} (group ${j.panePid}) ${j.dead ? `dead (status ${j.exitStatus ?? '-'}, signal ${j.exitSignal ?? '-'})` : 'alive'}`);
  } catch (e) {
    out(`jobs air parses: listJobs failed: ${(e as Error).message}`);
  }
  const held = allWorkspaces(ctx.root, ctx.gh.repo).filter((w) => w.state.job && !ENDED.includes(w.state.job.status));
  out(`jobs air holds (${ctx.root}): ${held.length}`);
  for (const { dir, state } of held) {
    const job = state.job!;
    const found = jobs.find((j) => j.issue === state.issue && j.nonce === job.paneNonce);
    out(`  #${state.issue} ${state.phase}/${job.status} paneNonce ${job.paneNonce ?? '(none)'}: ${found ? `window ${found.windowId}` : 'NO MATCHING PANE'}${existsSync(join(dir, 'AIR_DONE')) ? ', AIR_DONE present' : ''} (${dir})`);
  }
  return 0;
}
