// Launcher scripts keep caller-controlled words (argv, env values, cwd) off the tmux command line, where a
// word equal to or ending in `;` is a command separator (so `x;` `run-shell ...` would run tmux commands).
// tmux only ever sees the fixed `/bin/sh <private dir>/run.sh`; the script quotes every word for sh.
import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { alive } from '../pid.ts';

/** Quote one word for POSIX sh. */
export function shQuote(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

export interface Launcher {
  /** Private directory holding the script. */
  dir: string;
  /** argv for tmux: fixed words only. */
  argv: string[];
  /** Remove the launcher if it never ran (it deletes itself when it does). */
  cleanup(): void;
}

/** Files in a status launcher's dir: the job's exit status once it has exited, and the agent's pid. */
export const STATUS_FILE = 'status';
export const PID_FILE = 'pid';
/** How long the reaper waits after TERM before it KILLs what is left of the job. */
export const REAP_GRACE_SECONDS = 3;

/**
 * Write a self-deleting launcher that cds to `cwd` and execs `argv`, with `env` added to the inherited
 * environment.
 *
 * With `status` (job panes), the launcher shell stays: it is the pane's process, session and process group
 * leader, and it runs the agent in the foreground of that group (so C-c and the terminal reach the agent as
 * before), records the agent's pid in `<dir>/pid` (a tiny `sh -c` writes `$$` and execs it), and writes its
 * exit status to `<dir>/status` before exiting with it. The script removes itself; the dir stays until
 * `removeLauncher`. Why: tmux < 3.6 built with utempter (Ubuntu's, Debian's) can lose the SIGCHLD and never
 * reap the pane, which then stays "dead, no status" for good. The shell holds the pty until it exits, so the
 * pane is never dead before the file is written. It catches INT, QUIT and TERM (to outlive the agent and
 * record its status; caught signals are reset in the child). It does not catch HUP: a killed window or tmux
 * server hangs up the pty, which signals only the session leader, so the shell dies.
 *
 * Nothing of the job may outlive the launcher: a background reaper in the same process group holds the read
 * end of a FIFO whose only writer is the launcher shell. When the shell is gone (exited, or killed by the
 * hangup; even as a zombie tmux never reaps, its fds are closed), the reaper sends the whole group TERM, and
 * KILL after REAP_GRACE_SECONDS. An agent killed by a signal exits as sh reports it: status 128 + N.
 */
export function writeLauncher(opts: { argv: string[]; env?: Record<string, string>; cwd?: string; status?: boolean }): Launcher {
  const dir = mkdtempSync(join(tmpdir(), 'air-launch-')); // mode 0700
  const script = join(dir, 'run.sh');
  const words = ['env', ...Object.entries(opts.env ?? {}).map(([k, v]) => `${k}=${v}`), ...opts.argv];
  let lines: string[];
  if (opts.status) {
    const q = (f: string) => shQuote(join(dir, f));
    const fifo = q('alive');
    lines = ['#!/bin/sh', '# air launcher: removes itself, runs the job, records its pid and exit status, reaps what it leaves',
      `rm -f -- ${shQuote(script)}`,
      `air_exit() { printf '%s\\n' "$1" > ${q(`${STATUS_FILE}.tmp`)} && mv -f -- ${q(`${STATUS_FILE}.tmp`)} ${q(STATUS_FILE)}; exit "$1"; }`];
    if (opts.cwd !== undefined) lines.push(`cd -- ${shQuote(opts.cwd)} || air_exit 126`);
    lines.push(
      'me=$$',
      `if mkfifo -m 600 ${fifo}; then`,
      `  ( trap '' HUP TERM; read -r _ || :; kill -s TERM -- "-$me" 2>/dev/null; sleep ${REAP_GRACE_SECONDS}; kill -s KILL -- "-$me" 2>/dev/null ) < ${fifo} > /dev/null 2>&1 &`,
      `  exec 9> ${fifo}`,
      `  rm -f -- ${fifo}`,
      'fi',
      'trap : INT QUIT TERM',
      `${['/bin/sh', '-c', 'printf "%s\\n" "$$" > "$1"; shift; exec "$@"', 'air-agent', join(dir, PID_FILE), ...words].map(shQuote).join(' ')} 9>&-`,
      'air_exit "$?"', '');
  } else {
    lines = ['#!/bin/sh', '# air launcher: removes itself, then runs the job', `rm -rf -- ${shQuote(dir)}`];
    if (opts.cwd !== undefined) lines.push(`cd -- ${shQuote(opts.cwd)} || exit 126`);
    lines.push(`exec ${words.map(shQuote).join(' ')}`, '');
  }
  writeFileSync(script, lines.join('\n'), { mode: 0o700 });
  if (script.endsWith(';')) throw new Error(`tmux: unusable launcher path ${script}`);
  return { dir, argv: ['/bin/sh', script], cleanup: () => removeLauncher(dir) };
}

/** Remove a launcher dir that may never have run (e.g. its pane was killed at once), if it is our own (`ownLauncher`). */
export function removeLauncher(dir: string | undefined): void {
  if (!ownLauncher(dir)) return;
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Only our own launcher dirs, whatever a pane option claims: an `air-launch-*` directory directly under
 * tmpdir, not a symlink, owned by this user (tmpdir may be a shared /tmp).
 */
function ownLauncher(dir: string | undefined): dir is string {
  if (!dir || dirname(dir) !== tmpdir() || !/^air-launch-[A-Za-z0-9]+$/.test(basename(dir))) return false;
  try {
    const st = lstatSync(dir);
    return st.isDirectory() && st.uid === process.getuid?.();
  } catch {
    return false;
  }
}

/** A launcher dir no pane uses is left over once it is this old (a launcher runs, or is cleaned up, within seconds). */
export const LAUNCHER_STALE_MS = 24 * 3600_000;

/**
 * Our launcher dirs (`ownLauncher`) left behind: older than
 * LAUNCHER_STALE_MS, that no pane in `used` names, and whose agent (if one was recorded) has exited. They
 * are left when a job's window went without air closing it (closed by hand, or the tmux server died).
 */
export function staleLaunchers(used: ReadonlySet<string>, now = Date.now()): string[] {
  const out: string[] = [];
  let names: string[];
  try {
    names = readdirSync(tmpdir());
  } catch {
    return out;
  }
  for (const name of names) {
    const dir = join(tmpdir(), name);
    if (!ownLauncher(dir) || used.has(dir)) continue;
    try {
      if (now - lstatSync(dir).mtimeMs < LAUNCHER_STALE_MS) continue;
    } catch {
      continue;
    }
    const pid = launcherPid(dir);
    if (pid !== null && alive(pid)) continue;
    out.push(dir);
  }
  return out;
}

function readNumber(dir: string | undefined, file: string, max: number): number | null {
  if (!ownLauncher(dir)) return null;
  let text: string;
  try {
    text = readFileSync(join(dir, file), 'utf8');
  } catch {
    return null;
  }
  return /^\d+\n?$/.test(text) && Number(text.trim()) <= max ? Number(text.trim()) : null;
}

/** The exit status a status launcher recorded in `dir`, if it has exited. */
export function launcherStatus(dir: string | undefined): number | null {
  return readNumber(dir, STATUS_FILE, 255);
}

/** The agent's pid a status launcher recorded in `dir`, once it has started it. */
export function launcherPid(dir: string | undefined): number | null {
  const pid = readNumber(dir, PID_FILE, 2 ** 31);
  return pid && pid > 1 ? pid : null;
}
