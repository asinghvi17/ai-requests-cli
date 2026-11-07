// tmux control on the private `air` socket: one session, window 0 for the server log, one window per job.
// Every job pane carries pane options @air_job=<issue> and @air_nonce=<random>; those tags are the only
// source of truth, so a restarted server re-adopts its jobs and never touches the volunteer's own windows.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { clientEnv, jobArgv, jobEnv } from './env.ts';

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
  /** Appended to argv as the last argument (the prompt). */
  promptFile?: string;
}

export interface StopOptions {
  /** How long to wait for the agent to exit after the interrupt keys (default 5000). */
  graceMs?: number;
  /** Keys sent first (default C-c twice: Claude Code and Codex exit on a second C-c). */
  keys?: string[];
}

const SEP = '\t';
const LIST_FORMAT = ['#{@air_job}', '#{@air_nonce}', '#{window_id}', '#{pane_id}', '#{window_name}',
  '#{pane_pid}', '#{pane_dead}', '#{pane_dead_status}'].join(SEP);

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

export function windowName(issue: number): string {
  return `#${issue}`;
}

function checkIssue(issue: number) {
  if (!Number.isSafeInteger(issue) || issue <= 0) throw new Error(`tmux: bad issue number ${issue}`);
}

export function parseJobs(out: string): Job[] {
  const jobs: Job[] = [];
  for (const line of out.split('\n')) {
    const [job, nonce, windowId, paneId, name, pid, dead, status] = line.split(SEP);
    if (!job || !nonce || !/^\d+$/.test(job) || !windowId || !paneId) continue;
    const isDead = dead === '1';
    jobs.push({
      issue: Number(job), nonce, windowId, paneId, windowName: name ?? '', pid: Number(pid),
      dead: isDead, exitStatus: isDead && status !== undefined && /^\d+$/.test(status) ? Number(status) : null,
    });
  }
  return jobs;
}

export function createTmux(options: TmuxOptions = {}) {
  const socket = options.socket ?? 'air';
  const session = options.session ?? 'air';
  const run = options.run ?? defaultRunner(socket);
  const target = `=${session}`;

  async function tmux(args: string[]): Promise<string> {
    const r = await run(args);
    if (r.code !== 0) throw new Error(`tmux ${args[0]}: ${r.stderr.trim() || `exit ${r.code}`}`);
    return r.stdout.replace(/\n$/, '');
  }

  /** Run `command` only if `paneId` still carries `nonce`, checked in the same tmux command queue. */
  async function guarded(job: Job, command: string[]): Promise<boolean> {
    const cond = `#{==:#{@air_nonce},${job.nonce}}`;
    const branch = [command, ['display-message', '-p', 'air-ok']].map(c => c.map(quoteTmux).join(' ')).join(' ; ');
    const r = await run(['if-shell', '-F', '-t', job.paneId, cond, branch]);
    if (r.code !== 0) {
      if (/can't find pane|no server running/i.test(r.stderr)) return false;
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
    await tmux(args);
    return true;
  }

  /** All job panes on the server, found by their tags alone (this is also re-adoption after a restart). */
  async function listJobs(): Promise<Job[]> {
    const r = await run(['list-panes', '-a', '-F', LIST_FORMAT]);
    if (r.code !== 0) {
      if (noServer(r.stderr)) return [];
      throw new Error(`tmux list-panes: ${r.stderr.trim()}`);
    }
    return parseJobs(r.stdout);
  }

  async function findJob(issue: number): Promise<Job | undefined> {
    const matches = (await listJobs()).filter(j => j.issue === issue);
    if (matches.length > 1) throw new Error(`tmux: ${matches.length} panes claim job #${issue}`);
    return matches[0];
  }

  /**
   * Start job `issue` in a new window `#<issue>` and return its window id. The window starts with a
   * placeholder so remain-on-exit and the tags are in place before the agent runs (a command that exits
   * at once would otherwise take its window, and exit status, with it).
   */
  async function startJob(input: StartJobInput): Promise<string> {
    checkIssue(input.issue);
    if (await findJob(input.issue)) throw new Error(`tmux: job #${input.issue} already has a window`);
    const env = jobEnv(input.env);
    await ensureSession();
    if (env.TERM === undefined) env.TERM = (await run(['show-options', '-sv', 'default-terminal'])).stdout.trim() || 'tmux-256color';
    const argv = jobArgv(input.argv, env, input.promptFile);
    const created = await tmux(['new-window', '-d', '-P', '-F', '#{window_id} #{pane_id}', '-t', `${target}:`,
      '-n', windowName(input.issue), '-c', input.cwd, '--', 'sleep', '2147483647']);
    const [windowId, paneId] = created.trim().split(' ');
    if (!windowId?.startsWith('@') || !paneId?.startsWith('%')) throw new Error(`tmux new-window: unexpected output ${created}`);
    const nonce = randomBytes(12).toString('hex');
    try {
      await tmux(['set-option', '-w', '-t', windowId, 'remain-on-exit', 'on', ';',
        'set-option', '-w', '-t', windowId, 'automatic-rename', 'off', ';',
        'set-option', '-w', '-t', windowId, 'allow-rename', 'off', ';',
        'set-option', '-p', '-t', paneId, '@air_job', String(input.issue), ';',
        'set-option', '-p', '-t', paneId, '@air_nonce', nonce]);
      await tmux(['respawn-pane', '-k', '-t', paneId, '-c', input.cwd, '--', ...argv]);
    } catch (e) {
      await run(['kill-window', '-t', windowId]);
      throw e;
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
    return tmux(['capture-pane', '-p', '-J', '-t', job.paneId, '-S', String(-Math.max(1, Math.floor(lines)))]);
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
   * argv that puts the user's terminal on the air session (and the job's window, if given): switch-client
   * when already inside a tmux client on this socket, otherwise attach (unsetting TMUX to allow nesting).
   */
  async function attachArgs(issue?: number, env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
    let select: string[] = [];
    if (issue !== undefined) {
      const job = await findJob(issue);
      if (!job) throw new Error(`tmux: no window for job #${issue}`);
      select = [';', 'select-window', '-t', job.windowId];
    }
    const inside = env.TMUX?.split(',')[0];
    if (inside && inside.split('/').pop() === socket) return ['tmux', '-L', socket, 'switch-client', '-t', target, ...select];
    const attach = ['tmux', '-L', socket, 'attach-session', '-t', target, ...select];
    return inside ? ['env', '-u', 'TMUX', ...attach] : attach;
  }

  /** Kill the whole tmux server on this socket (tests, `air serve --stop`). */
  async function killServer(): Promise<void> {
    await run(['kill-server']);
  }

  return { socket, session, ensureSession, startJob, listJobs, stopJob, isAlive, capture, attachArgs, killServer };
}

export type Tmux = ReturnType<typeof createTmux>;
