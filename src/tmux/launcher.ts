// Launcher scripts keep caller-controlled words (argv, env values, cwd) off the tmux command line, where a
// word equal to or ending in `;` is a command separator (so `x;` `run-shell ...` would run tmux commands).
// tmux only ever sees the fixed `/bin/sh <private dir>/run.sh`; the script quotes every word for sh.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

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

/** The file in a status launcher's dir that holds the job's exit status once it has exited. */
export const STATUS_FILE = 'status';

/**
 * Write a self-deleting launcher that cds to `cwd` and execs `argv`. With `clearEnv`, the environment is
 * exactly `env` (`env -i`); otherwise `env` is added to the inherited one.
 *
 * With `status`, the launcher instead runs `argv` as its child, writes its exit status to `<dir>/status`
 * and exits with it; only the script is removed, and the dir stays until `removeLauncher`. tmux's own
 * `pane_dead_status` can't be relied on: tmux < 3.6 built with utempter (Ubuntu's, Debian's) can lose the
 * SIGCHLD and never reap the pane, which then stays "dead, no status" for good. The launcher's shell holds
 * the pane's pty until it exits, so the pane is never dead before the file is written. It ignores (catches)
 * INT, TERM, HUP and QUIT itself so it outlives the agent; caught signals are reset in the child, so the
 * agent sees C-c as before. A child killed by a signal shows as sh reports it: status 128 + the signal.
 */
export function writeLauncher(opts: { argv: string[]; env?: Record<string, string>; cwd?: string; clearEnv?: boolean; status?: boolean }): Launcher {
  const dir = mkdtempSync(join(tmpdir(), 'air-launch-')); // mode 0700
  const script = join(dir, 'run.sh');
  const words = ['env', ...(opts.clearEnv ? ['-i'] : []), ...Object.entries(opts.env ?? {}).map(([k, v]) => `${k}=${v}`), ...opts.argv];
  let lines: string[];
  if (opts.status) {
    const tmp = shQuote(join(dir, `${STATUS_FILE}.tmp`)), file = shQuote(join(dir, STATUS_FILE));
    lines = ['#!/bin/sh', '# air launcher: removes itself, runs the job, records its exit status', `rm -f -- ${shQuote(script)}`,
      `air_exit() { printf '%s\n' "$1" > ${tmp} && mv -f -- ${tmp} ${file}; exit "$1"; }`];
    if (opts.cwd !== undefined) lines.push(`cd -- ${shQuote(opts.cwd)} || air_exit 126`);
    lines.push(`trap : INT TERM HUP QUIT`, words.map(shQuote).join(' '), 'air_exit "$?"', '');
  } else {
    lines = ['#!/bin/sh', '# air launcher: removes itself, then runs the job', `rm -rf -- ${shQuote(dir)}`];
    if (opts.cwd !== undefined) lines.push(`cd -- ${shQuote(opts.cwd)} || exit 126`);
    lines.push(`exec ${words.map(shQuote).join(' ')}`, '');
  }
  writeFileSync(script, lines.join('\n'), { mode: 0o700 });
  if (script.endsWith(';')) throw new Error(`tmux: unusable launcher path ${script}`);
  return { dir, argv: ['/bin/sh', script], cleanup: () => removeLauncher(dir) };
}

/**
 * Remove a launcher dir that may never have run (e.g. its pane was killed at once). Only our own
 * `air-launch-*` directories directly under tmpdir are touched, whatever a pane option claims.
 */
export function removeLauncher(dir: string | undefined): void {
  if (!ownLauncher(dir)) return;
  rmSync(dir, { recursive: true, force: true });
}

/** Only our own `air-launch-*` directories directly under tmpdir, whatever a pane option claims. */
function ownLauncher(dir: string | undefined): dir is string {
  return !!dir && dirname(dir) === tmpdir() && /^air-launch-[A-Za-z0-9]+$/.test(basename(dir));
}

/** The exit status a status launcher recorded in `dir`, if it has exited. */
export function launcherStatus(dir: string | undefined): number | null {
  if (!ownLauncher(dir)) return null;
  let text: string;
  try {
    text = readFileSync(join(dir, STATUS_FILE), 'utf8');
  } catch {
    return null;
  }
  return /^\d{1,3}\n?$/.test(text) ? Number(text.trim()) : null;
}
