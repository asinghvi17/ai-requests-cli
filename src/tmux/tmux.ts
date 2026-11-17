// tmux control on the private `air` socket: one session, window 0 for the server log, one window per job.
// Every job pane carries pane options @air_repo=<owner/name>, @air_job=<issue> and @air_nonce=<random>; those
// tags are the only source of truth, so a restarted server re-adopts its own jobs and never touches the
// volunteer's windows or the jobs of a server for another requests repo on the same socket.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { constants } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { checkRepo } from '../gh/issues.ts';
import { checkJob, clientEnv, jobEnv } from './env.ts';
import { launcherPid, launcherStatus, removeLauncher, writeLauncher } from './launcher.ts';

/** The file in the workspace that holds the full task; the agent's argv only points at it. */
export const TASK_FILE = 'AIR_TASK.md';
export const TASK_INSTRUCTION = `Read ${TASK_FILE} in this directory and do the task it describes.`;

export interface RunResult { code: number; stdout: string; stderr: string }
/** Runs `tmux -L <socket> ...args`. Injectable for unit tests. */
export type TmuxRunner = (args: string[]) => Promise<RunResult>;

export interface TmuxOptions {
  /** The requests repo (`owner/name`) whose jobs this client starts and sees: panes are tagged `@air_repo`. */
  repo: string;
  /** Socket name for `tmux -L` (default `air`); tests use a throwaway one. */
  socket?: string;
  /** Session name (default `air`). */
  session?: string;
  run?: TmuxRunner;
  /** `process.kill` (throws when there is no such process); unit tests with made-up pane pids replace it. */
  kill?: (pid: number, signal: NodeJS.Signals | 0) => void;
}

export interface Job {
  /** `@air_repo`: the requests repo the job belongs to. */
  repo: string;
  issue: number;
  nonce: string;
  windowId: string;
  paneId: string;
  windowName: string;
  /** PID of the agent (from the launcher's pid file); the pane's own pid until the launcher has written it. */
  pid: number;
  /**
   * PID of the pane's process: air's launcher shell, which is the session and process group leader of the
   * job (the agent and whatever it starts, unless they make their own group). Stops signal this group.
   */
  panePid: number;
  /**
   * The agent has exited: tmux closed the pane's pty (`pane_dead`) and its exit status is known, from tmux
   * (`pane_dead_status`/`_signal`, once it has reaped the child) or from the launcher's status file. A pane
   * that is `pane_dead` with no status from either counts as alive. tmux < 3.6 with utempter may never
   * reap it (see launcher.ts); the status file covers that.
   */
  dead: boolean;
  /**
   * Exit status once the pane is dead (null while alive). The launcher shell reports an agent killed by
   * signal N as sh does, status 128 + N (see `signalOf`).
   */
  exitStatus: number | null;
  /** Signal that killed the pane's process itself (rare: the launcher catches the usual ones), as tmux reports it. */
  exitSignal: number | null;
  /** The job's launcher dir, removed with its window if the launcher never ran. */
  launcher?: string;
}

export interface StartJobInput {
  issue: number;
  cwd: string;
  argv: string[];
  /** Added to (or overriding) the caller's environment, which the job inherits whole. */
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
  '#{pane_pid}', '#{pane_dead}', '#{pane_dead_status}', '#{@air_state}', '#{@air_launcher}', '#{pane_dead_signal}', '#{@air_repo}'].join(SEP);

/**
 * `-u`: the client is UTF-8 whatever the caller's locale. A client tmux thinks is not UTF-8 (no `UTF-8` in
 * LC_ALL, LC_CTYPE or LANG, as in a Mac shell without a locale) gets its output sanitised, and every tab
 * of a `-F` format becomes `_`: then no list-panes line parses and every job looks gone.
 */
export function defaultRunner(socket: string, env: NodeJS.ProcessEnv = process.env): TmuxRunner {
  return (args) => new Promise((resolve, reject) => {
    const child = spawn('tmux', ['-u', '-L', socket, ...args], { env: clientEnv(env), stdio: ['ignore', 'pipe', 'pipe'] });
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

/**
 * No server (so no jobs). "server exited unexpectedly" is a client that connected to a server on its way out:
 * `kill-server` returns before the server process is gone, and its panes are gone with it.
 */
function noServer(stderr: string): boolean {
  return /no server running|can't find session|no such session|server exited unexpectedly/i.test(stderr) || noSocket(stderr);
}

/** "error connecting to <socket> (<reason>)" means no server only when the socket is missing or refuses. */
function noSocket(stderr: string): boolean {
  return /error connecting to .*\((No such file or directory|Connection refused)\)/i.test(stderr);
}

const exiting = (stderr: string) => /server exited unexpectedly/i.test(stderr);

/** The target (pane, window or server) went away under us. */
function vanished(stderr: string): boolean {
  return /can't find (pane|window|session)|no such (pane|window)|no server running|server exited/i.test(stderr) || noSocket(stderr);
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
export interface Stale { repo: string; issue: number; nonce: string; windowId: string; paneId: string; panePid: number; launcher?: string }

type LauncherRead = (launcher: string | undefined) => number | null;

export function parseJobs(out: string, statusOf: LauncherRead = launcherStatus, pidOf: LauncherRead = launcherPid): Job[] {
  return parsePanes(out, statusOf, pidOf).jobs;
}

/**
 * The signal an exit status of the launcher shell stands for: sh reports a child killed by signal N as
 * 128 + N. (An agent that exits 128 + N on purpose looks the same; only tmux's `exitSignal` is certain.)
 */
export function signalOf(status: number | null): number | null {
  return status !== null && status > 128 && status <= 128 + 64 ? status - 128 : null;
}

/** "SIGINT" for 2, or undefined for an unknown number. */
export function signalName(n: number): string | undefined {
  return Object.entries(constants.signals).find(([, v]) => v === n)?.[0];
}

/** `pane_dead_signal`: a number on Linux, a name (`int`, `KILL`) where tmux has sys_signame (macOS, BSDs). */
function signalNumber(raw: string | undefined): number | null {
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Number(raw);
  const n = (constants.signals as Record<string, number | undefined>)[`SIG${raw.toUpperCase().replace(/^SIG/, '')}`];
  return n ?? null;
}

export function parsePanes(out: string, statusOf: LauncherRead = launcherStatus, pidOf: LauncherRead = launcherPid): { jobs: Job[]; stale: Stale[] } {
  const jobs: Job[] = [], stale: Stale[] = [];
  for (const line of out.split('\n')) {
    // Every row has separators; a row without any is tmux's sanitised output (see defaultRunner), and
    // reading it as "no panes" would close every job.
    if (line.trim() && !line.includes(SEP)) throw new Error(`tmux list-panes: unparseable row ${JSON.stringify(line.slice(0, 200))} (tabs replaced: is the tmux client UTF-8?)`);
    const [job, nonce, windowId, paneId, name, pid, dead, status, state, launcher, signal, repo = ''] = line.split(SEP);
    if (!job || !nonce || !/^\d+$/.test(job) || !windowId || !paneId) continue;
    const extra = launcher ? { launcher } : {};
    if (state !== 'running') {
      stale.push({ repo, issue: Number(job), nonce, windowId, paneId, panePid: Number(pid), ...extra });
      continue;
    }
    let code = status !== undefined && /^\d+$/.test(status) ? Number(status) : null;
    const sig = signalNumber(signal);
    // Dead only with a known status (see Job.dead): a closed pty alone is not an exit.
    if (dead === '1' && code === null && sig === null) code = statusOf(launcher);
    const isDead = dead === '1' && (code !== null || sig !== null);
    jobs.push({
      repo, issue: Number(job), nonce, windowId, paneId, windowName: name ?? '', pid: pidOf(launcher) ?? Number(pid), panePid: Number(pid),
      dead: isDead, exitStatus: isDead ? code : null, exitSignal: isDead ? sig : null, ...extra,
    });
  }
  return { jobs, stale };
}

const paneNumber = (id: string) => Number(id.slice(1));

/** How long a stop waits after TERM to the job's process group before it sends KILL. */
export const KILL_GRACE_MS = 2000;

type Kill = NonNullable<TmuxOptions['kill']>;

/** Whether `pid` (or, negative, a process group) still exists. A group of another user counts as gone. */
function exists(kill: Kill, pid: number): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signal(kill: Kill, pid: number, sig: NodeJS.Signals): void {
  try {
    kill(pid, sig);
  } catch {
    // gone already
  }
}

/** TERM process group `pgid`, wait until `agent` (if known) has exited or KILL_GRACE_MS, then KILL the group. */
async function killGroup(kill: Kill, pgid: number, agent: number | undefined): Promise<void> {
  if (!Number.isSafeInteger(pgid) || pgid <= 1 || !exists(kill, -pgid)) return;
  signal(kill, -pgid, 'SIGTERM');
  const end = Date.now() + KILL_GRACE_MS;
  const waitFor = agent && agent > 1 && agent !== pgid ? agent : -pgid;
  while (exists(kill, waitFor) && Date.now() < end) await sleep(50);
  signal(kill, -pgid, 'SIGKILL');
}

/** The oldest tmux air supports: pane user options (`set-option -p`, the job tags) came in 3.0. */
export const MIN_TMUX = { major: 3, minor: 0 };

/**
 * Why `tmux -V` output `v` is unusable, or undefined if it is fine. Versions are `tmux 3.4`, `tmux 3.0a`,
 * `tmux next-3.6`, or `tmux openbsd-7.5` (a current tmux); one that doesn't parse is given the benefit of the doubt.
 */
export function tmuxVersionProblem(v: string): string | undefined {
  const m = /(?:^|[\s-])(\d+)\.(\d+)/.exec(v);
  if (!m || /openbsd/i.test(v)) return undefined;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  if (major > MIN_TMUX.major || (major === MIN_TMUX.major && minor >= MIN_TMUX.minor)) return undefined;
  return `${v.trim()} is too old: air needs tmux ${MIN_TMUX.major}.${MIN_TMUX.minor} or newer (tested with 3.0a to 3.8). Install a newer tmux.`;
}

export function createTmux(options: TmuxOptions) {
  const repo = options.repo;
  checkRepo(repo); // goes on the tmux command line: owner/name only, never a separator
  const socket = options.socket ?? 'air';
  const session = options.session ?? 'air';
  const run = options.run ?? defaultRunner(socket);
  const kill: Kill = options.kill ?? ((pid, sig) => { process.kill(pid, sig); });
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
   * Kill one of our windows (nonce-guarded) with everything the job runs, and the launcher dir. Closing the
   * window alone only hangs up the session leader (the launcher shell): the job's process group gets TERM,
   * then (once the agent is gone, or after KILL_GRACE_MS) KILL, before the window goes.
   */
  async function killOwned(p: Pick<Job, 'nonce' | 'paneId' | 'windowId' | 'launcher' | 'panePid'> & { pid?: number }): Promise<void> {
    if (!(await guarded(p, ['display-message', '-p', '']))) return; // not ours (any more)
    await killGroup(kill, p.panePid, p.pid);
    if (await guarded(p, ['kill-window', '-t', p.windowId])) removeLauncher(p.launcher);
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
    // Caller words go through a launcher, never onto the tmux command line (see launcher.ts).
    const custom = !!(opts.argv?.length || opts.cwd || (opts.env && Object.keys(opts.env).length));
    const launcher = custom
      ? writeLauncher({ argv: opts.argv?.length ? opts.argv : [process.env.SHELL || '/bin/sh'], env: opts.env, cwd: opts.cwd })
      : undefined;
    if (launcher) args.push('--', ...launcher.argv);
    let r = await run(args);
    // A server still shutting down took our connection: wait for it to go, then start a fresh one.
    for (let i = 0; i < 20 && r.code !== 0 && exiting(r.stderr); i++) {
      await sleep(50);
      r = await run(args);
    }
    if (r.code === 0) return true;
    launcher?.cleanup();
    if (/duplicate session/i.test(r.stderr)) return false; // lost a race with another ensureSession
    throw new Error(`tmux new-session: ${r.stderr.trim() || `exit ${r.code}`}`);
  }

  /**
   * This repo's running job panes on the server, found by their tags alone (this is also re-adoption after a
   * restart): `@air_repo` must be this client's repo, so a server for another requests repo on the same socket
   * and ours never see (or adopt, stop or kill) each other's jobs. Our panes left in `starting` (a start that
   * never finished) are killed, never adopted; a start in progress is never seen there, since it tags and
   * respawns in one tmux command queue.
   */
  async function listJobs(): Promise<Job[]> {
    const r = await run(['list-panes', '-a', '-F', LIST_FORMAT]);
    if (r.code !== 0) {
      if (noServer(r.stderr)) return [];
      throw new Error(`tmux list-panes: ${r.stderr.trim()}`);
    }
    const { jobs, stale } = parsePanes(r.stdout);
    for (const p of stale) if (p.repo === repo) await killOwned(p);
    return jobs.filter(j => j.repo === repo);
  }

  /** `tmux -V`, e.g. "tmux 3.4". Throws if tmux can't be run. */
  async function version(): Promise<string> {
    const r = await run(['-V']);
    if (r.code !== 0) throw new Error(`tmux -V: ${r.stderr.trim() || `exit ${r.code}`}`);
    return r.stdout.trim();
  }

  /** Throws unless tmux runs and is new enough (see MIN_TMUX). */
  async function checkVersion(): Promise<string> {
    let v: string;
    try {
      v = await version();
    } catch (e) {
      throw new Error(`tmux is not usable: ${(e as Error).message}. air needs tmux ${MIN_TMUX.major}.${MIN_TMUX.minor} or newer.`);
    }
    const problem = tmuxVersionProblem(v);
    if (problem) throw new Error(problem);
    return v;
  }

  /** The raw `list-panes -a` result in air's format, for `air debug panes`. */
  async function listPanesRaw(): Promise<RunResult & { format: string }> {
    return { ...(await run(['list-panes', '-a', '-F', LIST_FORMAT])), format: LIST_FORMAT };
  }

  /** The job's pane. Should duplicates exist anyway, keep the oldest (lowest pane id) and kill the rest. */
  async function findJob(issue: number): Promise<Job | undefined> {
    const matches = (await listJobs()).filter(j => j.issue === issue).sort((a, b) => paneNumber(a.paneId) - paneNumber(b.paneId));
    for (const extra of matches.slice(1)) await killOwned(extra);
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
    // The pane is a tmux terminal, whatever terminal air itself runs in.
    env.TERM = (await run(['show-options', '-sv', 'default-terminal'])).stdout.trim() || 'tmux-256color';
    checkJob(argv);
    // argv, env and cwd go into a launcher script; the tmux command line below holds only our own words.
    const launcher = writeLauncher({ argv, env, cwd: input.cwd, status: true });
    const nonce = randomBytes(12).toString('hex');
    // Commands later in a chain default to the session's current pane, not the new one: target the
    // new window by an exact, unique temporary name.
    const tmp = `air-new-${nonce}`, w = `${target}:=${tmp}`;
    const r = await run(['new-window', '-d', '-P', '-F', '#{window_id} #{pane_id}', '-t', `${target}:`, '-n', tmp,
      '--', 'sleep', '2147483647', ';',
      'set-option', '-p', '-t', w, '@air_repo', repo, ';',
      'set-option', '-p', '-t', w, '@air_job', String(input.issue), ';',
      'set-option', '-p', '-t', w, '@air_nonce', nonce, ';',
      'set-option', '-p', '-t', w, '@air_state', 'starting', ';',
      'set-option', '-p', '-t', w, '@air_launcher', launcher.dir, ';',
      'set-option', '-w', '-t', w, 'remain-on-exit', 'on', ';',
      'set-option', '-w', '-t', w, 'automatic-rename', 'off', ';',
      'set-option', '-w', '-t', w, 'allow-rename', 'off', ';',
      'respawn-pane', '-k', '-t', w, '--', ...launcher.argv, ';',
      'set-option', '-p', '-t', w, '@air_state', 'running', ';',
      'rename-window', '-t', w, windowName(input.issue)]);
    const [windowId, paneId] = r.stdout.trim().split('\n')[0]!.split(' ');
    if (r.code !== 0 || !windowId?.startsWith('@') || !paneId?.startsWith('%')) {
      launcher.cleanup();
      if (windowId?.startsWith('@') && paneId?.startsWith('%')) await guarded({ nonce, paneId }, ['kill-window', '-t', windowId]);
      throw new Error(`tmux new-window: ${r.stderr.trim() || `unexpected output ${r.stdout}`}`);
    }
    return windowId;
  }

  async function isAlive(issue: number): Promise<boolean> {
    const job = await findJob(issue);
    return !!job && !job.dead;
  }

  /**
   * The last `lines` lines of the job's pane (scrollback included, blank screen rows below the output
   * dropped), or null if there is no such job. A non-finite or non-positive `lines` means 50.
   */
  async function capture(issue: number, lines = 50): Promise<string | null> {
    const n = Number.isFinite(lines) && lines >= 1 ? Math.floor(lines) : 50;
    const job = await findJob(issue);
    if (!job) return null;
    const r = await run(['capture-pane', '-p', '-J', '-t', job.paneId, '-S', String(-n)]);
    if (r.code === 0) {
      const rows = r.stdout.replace(/\n$/, '').split('\n');
      while (rows.length && rows.at(-1)!.trim() === '') rows.pop();
      return rows.slice(-n).join('\n');
    }
    if (vanished(r.stderr)) return null; // the pane or server went away after findJob
    throw new Error(`tmux capture-pane: ${r.stderr.trim()}`);
  }

  /** The job pane's visible screen (`tmux capture-pane -p -J`: wrapped lines joined), or null if there is no such job. */
  async function screen(issue: number): Promise<string | null> {
    const job = await findJob(issue);
    if (!job) return null;
    const r = await run(['capture-pane', '-p', '-J', '-t', job.paneId]);
    if (r.code === 0) return r.stdout;
    if (vanished(r.stderr)) return null;
    throw new Error(`tmux capture-pane: ${r.stderr.trim()}`);
  }

  /**
   * Show `text` in the session's status line (right side) to whoever attaches, or clear it. It goes in as
   * one argv word with `#` doubled, so tmux shows it verbatim.
   */
  async function setNotice(text: string | undefined): Promise<void> {
    const t = `${target}:`;
    const r = text === undefined
      ? await run(['set-option', '-u', '-t', t, 'status-right'])
      : await run(['set-option', '-t', t, 'status-right-length', '200', ';', 'set-option', '-t', t, 'status-right', text.replaceAll('#', '##')]);
    if (r.code !== 0 && !noServer(r.stderr) && !vanished(r.stderr)) throw new Error(`tmux set-option: ${r.stderr.trim()}`);
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
    await killOwned(job);
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

  return { socket, session, version, checkVersion, ensureSession, startJob, listJobs, listPanesRaw, stopJob, isAlive, capture, screen, setNotice, attachArgs, killServer };
}

export type Tmux = ReturnType<typeof createTmux>;
