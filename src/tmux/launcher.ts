// Launcher scripts keep caller-controlled words (argv, env values, cwd) off the tmux command line, where a
// word equal to or ending in `;` is a command separator (so `x;` `run-shell ...` would run tmux commands).
// tmux only ever sees the fixed `/bin/sh <private dir>/run.sh`; the script quotes every word for sh.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

/**
 * Write a self-deleting launcher that cds to `cwd` and execs `argv`. With `clearEnv`, the environment is
 * exactly `env` (`env -i`); otherwise `env` is added to the inherited one.
 */
export function writeLauncher(opts: { argv: string[]; env?: Record<string, string>; cwd?: string; clearEnv?: boolean }): Launcher {
  const dir = mkdtempSync(join(tmpdir(), 'air-launch-')); // mode 0700
  const script = join(dir, 'run.sh');
  const words = ['env', ...(opts.clearEnv ? ['-i'] : []), ...Object.entries(opts.env ?? {}).map(([k, v]) => `${k}=${v}`), ...opts.argv];
  const lines = ['#!/bin/sh', '# air launcher: removes itself, then runs the job', `rm -rf -- ${shQuote(dir)}`];
  if (opts.cwd !== undefined) lines.push(`cd -- ${shQuote(opts.cwd)} || exit 126`);
  lines.push(`exec ${words.map(shQuote).join(' ')}`, '');
  writeFileSync(script, lines.join('\n'), { mode: 0o700 });
  if (script.endsWith(';')) throw new Error(`tmux: unusable launcher path ${script}`);
  return { dir, argv: ['/bin/sh', script], cleanup: () => removeLauncher(dir) };
}

/**
 * Remove a launcher dir that may never have run (e.g. its pane was killed at once). Only our own
 * `air-launch-*` directories directly under tmpdir are touched, whatever a pane option claims.
 */
export function removeLauncher(dir: string | undefined): void {
  if (!dir || dirname(dir) !== tmpdir() || !/^air-launch-[A-Za-z0-9]+$/.test(basename(dir))) return;
  rmSync(dir, { recursive: true, force: true });
}
