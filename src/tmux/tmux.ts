// tmux control on the private `air` socket: one session, window 0 for the server log, one window per job.
// Every job pane carries pane options @air_job=<issue> and @air_nonce=<random>; those tags are the only
// source of truth, so a restarted server re-adopts its jobs and never touches the volunteer's own windows.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { clientEnv, jobArgv, jobEnv } from './env.ts';

/** The file in the workspace that holds the full task; the agent's argv only points at it. */
export const TASK_FILE = 'AIR_TASK.md';
export const TASK_INSTRUCTION = `Read ${TASK_FILE} in this directory and do the task it describes.`;

export interface RunResult { code: number; stdout: string; stderr: string }
/** Runs `tmux -L <socket> ...args`. Injectable for unit tests. */
export type TmuxRunner = (args: string[]) => Promise<RunResult>;

export interface TmuxOptions {
  /** Socket name for `tmux -L` (default `air`); tests use a throwaway one. */
  socket?: string;
  /** Session name (default `air`). */
  session?: string;
  run?: TmuxRunner;
}

export interface Job {
  issue: number;
  nonce: string;
  windowId: string;
  paneId: string;
  windowName: string;
  /** PID of the pane's process (the agent, as `env` execs it). */
  pid: number;
  dead: boolean;
  /** Exit status once the pane is dead (null while alive or when killed by a signal). */
  exitStatus: number | null;
}

export interface StartJobInput {
  issue: number;
  cwd: string;
  argv: string[];
  /** Added to the allowlisted environment; denied names (GH_TOKEN, AWS_*, ...) throw. */
  env?: Record<string, string>;
  /**
   * The full task. Written to `<cwd>/AIR_TASK.md`; argv gets TASK_INSTRUCTION as its last argument, so a long
   * task never reaches argv (E2BIG) or tmux's size-limited command messages.
   */
  task?: string;
}

export interface StopOptions {
  /** How long to wait for the agent to exit after the interrupt keys (default 5000). */
  graceMs?: number;
  /** Keys sent first (default C-c twice: Claude Code and Codex exit on a second C-c). */
  keys?: string[];
}

const SEP = '\t';
const LIST_FORMAT = ['#{@air_job}', '#{@air_nonce}', '#{window_id}', '#{pane_id}', '#{window_name}',
  '#{pane_pid}', '#{pane_dead}', '#{pane_dead_status}', '#{@air_state}'].join(SEP);

export function defaultRunner(socket: string): TmuxRunner {
  return (args) => new Promise((resolve, reject) => {
    const child = spawn('tmux', ['-L', socket, ...args], { env: clientEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', d => { stdout += d; });
    child.stderr.setEncoding('utf8').on('data', d => { stderr += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => { clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }); });
  });
}

/** Quote one word for tmux's command parser (used for commands nested in if-shell). */
export function quoteTmux(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

function noServer(stderr: string): boolean {
  return /no server running|error connecting to|can't find session|no such session/i.test(stderr);
}

/** The target (pane, window or server) went away under us. */
function vanished(stderr: string): boolean {
  return /can't find (pane|window|session)|no such (pane|window)|no server running|error connecting to|server exited/i.test(stderr);
}

/** Where `tmux -L <socket>` puts its socket. */
export function socketPath(socket: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(env.TMUX_TMPDIR || '/tmp', `tmux-${process.getuid?.() ?? 0}`, socket);
}

export function windowName(issue: number): string {
  return `#${issue}`;
}

function checkIssue(issue: number) {
  if (!Number.isSafeInteger(issue) || issue <= 0) throw new Error(`tmux: bad issue number ${issue}`);
}

/** Tagged panes still in `starting`: a start that never completed (the chain failed, or we crashed). */
export interface Stale { issue: number; nonce: string; windowId: string; paneId: string }

export function parseJobs(out: string): Job[] {
  return parsePanes(out).jobs;
}

export function parsePanes(out: string): { jobs: Job[]; stale: Stale[] } {
  const jobs: Job[] = [], stale: Stale[] = [];
  for (const line of out.split('\n')) {
    const [job, nonce, windowId, paneId, name, pid, dead, status, state] = line.split(SEP);
    if (!job || !nonce || !/^\d+$/.test(job) || !windowId || !paneId) continue;
    if (state !== 'running') {
      stale.push({ issue: Number(job), nonce, windowId, paneId });
      continue;
    }
    const isDead = dead === '1';
    jobs.push({
      issue: Number(job), nonce, windowId, paneId, windowName: name ?? '', pid: Number(pid),
      dead: isDead, exitStatus: isDead && status !== undefined && /^\d+$/.test(status) ? Number(status) : null,
    });
  }
  return { jobs, stale };
}

const paneNumber = (id: string) => Number(id.slice(1));

export function createTmux(options: TmuxOptions = {}) {
  const socket = options.socket ?? 'air';
  const session = options.session ?? 'air';
  const run = options.run ?? defaultRunner(socket);
  const target = `=${session}`;
  /** Per-issue start lock (in-process). */
  const starting = new Map<number, Promise<unknown>>();

  /** Run `command` only if `paneId` still carries `nonce`, checked in the same tmux command queue. */
  async function guarded(job: Pick<Job, 'nonce' | 'paneId'>, command: string[]): Promise<boolean> {
    const cond = `#{==:#{@air_nonce},${job.nonce}}`;
    const branch = [command, ['display-message', '-p', 'air-ok']].map(c => c.map(quoteTmux).join(' ')).join(' ; ');
    const r = await run(['if-shell', '-F', '-t', job.paneId, cond, branch]);
    if (r.code !== 0) {
      if (vanished(r.stderr)) return false;
      throw new Error(`tmux if-shell: ${r.stderr.trim() || `exit ${r.code}`}`);
    }
    return r.stdout.trim() === 'air-ok';
  }

  /**
   * Create the `air` session if missing, with window 0 named `log` running `argv` (default: a shell).
   * `env` adds variables to window 0 only. Returns true when the session was created.
   */
  async function ensureSession(opts: { argv?: string[]; cwd?: string; env?: Record<string, string> } = {}): Promise<boolean> {
    const has = await run(['has-session', '-t', target]);
    if (has.code === 0) return false;
    if (!noServer(has.stderr)) throw new Error(`tmux has-session: ${has.stderr.trim()}`);
    const args = ['new-session', '-d', '-s', session, '-n', 'log'];
    if (opts.cwd) args.push('-c', opts.cwd);
    for (const [k, v] of Object.entries(opts.env ?? {})) args.push('-e', `${k}=${v}`);
    if (opts.argv?.length) args.push('--', ...opts.argv);
    const r = await run(args);
    if (r.code === 0) return true;
    if (/duplicate session/i.test(r.stderr)) return false; // lost a race with another ensureSession
    throw new Error(`tmux new-session: ${r.stderr.trim() || `exit ${r.code}`}`);
  }

  /**
   * All running job panes on the server, found by their tags alone (this is also re-adoption after a
   * restart). Panes left in `starting` (a start that never finished) are killed, never adopted; a start in
   * progress is never seen there, since it tags and respawns in one tmux command queue.
   */
  async function listJobs(): Promise<Job[]> {
    const r = await run(['list-panes', '-a', '-F', LIST_FORMAT]);
    if (r.code !== 0) {
      if (noServer(r.stderr)) return [];
      throw new Error(`tmux list-panes: ${r.stderr.trim()}`);
    }
    const { jobs, stale } = parsePanes(r.stdout);
    for (const p of stale) await guarded(p, ['kill-window', '-t', p.windowId]);
    return jobs;
  }

  /** The job's pane. Should duplicates exist anyway, keep the oldest (lowest pane id) and kill the rest. */
  async function findJob(issue: number): Promise<Job | undefined> {
    const matches = (await listJobs()).filter(j => j.issue === issue).sort((a, b) => paneNumber(a.paneId) - paneNumber(b.paneId));
    for (const extra of matches.slice(1)) await guarded(extra, ['kill-window', '-t', extra.windowId]);
    return matches[0];
  }

  /**
   * Start job `issue` in a new window `#<issue>` and return its window id. One tmux invocation creates the
   * window on a placeholder, sets remain-on-exit and the tags (`@air_state=starting`), respawns the real
   * command and marks it `running`: a command that exits at once keeps its window and exit status, and no
   * one ever adopts the placeholder. Starts of the same issue are serialized within this process.
   */
  async function startJob(input: StartJobInput): Promise<string> {
    checkIssue(input.issue);
    const prev = starting.get(input.issue) ?? Promise.resolve();
    const mine = prev.catch(() => {}).then(() => startUnlocked(input));
    const tail = mine.catch(() => {});
    starting.set(input.issue, tail);
    try { return await mine; } finally { if (starting.get(input.issue) === tail) starting.delete(input.issue); }
  }

  async function startUnlocked(input: StartJobInput): Promise<string> {
    if (!existsSync(input.cwd) || !statSync(input.cwd).isDirectory()) throw new Error(`tmux: workspace ${input.cwd} is not a directory`);
    if (await findJob(input.issue)) throw new Error(`tmux: job #${input.issue} already has a window`);
    const env = jobEnv(input.env);
    let argv = input.argv;
    if (input.task !== undefined) {
      writeFileSync(join(input.cwd, TASK_FILE), input.task);
      argv = [...argv, TASK_INSTRUCTION];
    }
    await ensureSession();
    if (env.TERM === undefined) env.TERM = (await run(['show-options', '-sv', 'default-terminal'])).stdout.trim() || 'tmux-256color';
    const command = jobArgv(argv, env);
    const nonce = randomBytes(12).toString('hex');
    // Commands later in a chain default to the session's current pane, not the new one: target the
    // new window by an exact, unique temporary name.
    const tmp = `air-new-${nonce}`, w = `${target}:=${tmp}`;
    const r = await run(['new-window', '-d', '-P', '-F', '#{window_id} #{pane_id}', '-t', `${target}:`, '-n', tmp,
      '-c', input.cwd, '--', 'sleep', '2147483647', ';',
      'set-option', '-p', '-t', w, '@air_job', String(input.issue), ';',
      'set-option', '-p', '-t', w, '@air_nonce', nonce, ';',
      'set-option', '-p', '-t', w, '@air_state', 'starting', ';',
      'set-option', '-w', '-t', w, 'remain-on-exit', 'on', ';',
      'set-option', '-w', '-t', w, 'automatic-rename', 'off', ';',
      'set-option', '-w', '-t', w, 'allow-rename', 'off', ';',
      'respawn-pane', '-k', '-t', w, '-c', input.cwd, '--', ...command, ';',
      'set-option', '-p', '-t', w, '@air_state', 'running', ';',
      'rename-window', '-t', w, windowName(input.issue)]);
    const [windowId, paneId] = r.stdout.trim().split('\n')[0]!.split(' ');
    if (r.code !== 0 || !windowId?.startsWith('@') || !paneId?.startsWith('%')) {
      if (windowId?.startsWith('@') && paneId?.startsWith('%')) await guarded({ nonce, paneId }, ['kill-window', '-t', windowId]);
      throw new Error(`tmux new-window: ${r.stderr.trim() || `unexpected output ${r.stdout}`}`);
    }
    return windowId;
  }

  async function isAlive(issue: number): Promise<boolean> {
    const job = await findJob(issue);
    return !!job && !job.dead;
  }

  /** The last `lines` lines of the job's pane (scrollback included), or null if there is no such job. */
  async function capture(issue: number, lines = 50): Promise<string | null> {
    const job = await findJob(issue);
    if (!job) return null;
    const r = await run(['capture-pane', '-p', '-J', '-t', job.paneId, '-S', String(-Math.max(1, Math.floor(lines)))]);
    if (r.code === 0) return r.stdout.replace(/\n$/, '');
    if (vanished(r.stderr)) return null; // the pane or server went away after findJob
    throw new Error(`tmux capture-pane: ${r.stderr.trim()}`);
  }

  /**
   * Interrupt the agent, wait up to `graceMs` for it to exit, then kill the window. Returns the exit status
   * if the agent exited (null when it had to be killed), or undefined if there was no such job.
   */
  async function stopJob(issue: number, opts: StopOptions = {}): Promise<{ exitStatus: number | null } | undefined> {
    const graceMs = opts.graceMs ?? 5000;
    let job = await findJob(issue);
    if (!job) return undefined;
    if (!job.dead) {
      for (const key of opts.keys ?? ['C-c', 'C-c']) {
        if (!await guarded(job, ['send-keys', '-t', job.paneId, key])) break;
        await sleep(100);
      }
      const deadline = Date.now() + graceMs;
      for (;;) {
        const now = await findJob(issue);
        if (!now || now.nonce !== job.nonce) return { exitStatus: null };
        job = now;
        if (job.dead || Date.now() >= deadline) break;
        await sleep(Math.min(100, Math.max(0, deadline - Date.now())));
      }
    }
    await guarded(job, ['kill-window', '-t', job.windowId]);
    return { exitStatus: job.dead ? job.exitStatus : null };
  }

  /**
   * argv that puts the user's terminal on the air session, on the job's window if given: switch-client
   * when already inside a client of this server, otherwise attach (unsetting TMUX to allow nesting).
   * The window id is the target itself: attach-session blocks until detach, so nothing may be chained after it.
   */
  async function attachArgs(issue?: number, env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
    let to = target;
    if (issue !== undefined) {
      const job = await findJob(issue);
      if (!job) throw new Error(`tmux: no window for job #${issue}`);
      to = job.windowId;
    }
    const inside = env.TMUX?.split(',')[0];
    if (inside && inside === socketPath(socket, env)) return ['tmux', '-L', socket, 'switch-client', '-t', to];
    const attach = ['tmux', '-L', socket, 'attach-session', '-t', to];
    return inside ? ['env', '-u', 'TMUX', ...attach] : attach;
  }

  /** Kill the whole tmux server on this socket (tests, `air serve --stop`). */
  async function killServer(): Promise<void> {
    await run(['kill-server']);
  }

  return { socket, session, ensureSession, startJob, listJobs, stopJob, isAlive, capture, attachArgs, killServer };
}

export type Tmux = ReturnType<typeof createTmux>;
