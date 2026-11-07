// Runs one child for setup: argv only (`sh -c` is just argv for setup and check), stdin from /dev/null,
// stdout and stderr appended to the log file, in its own process group, which is killed on timeout and
// again when the command ends, so nothing it started in the background outlives it.
import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';

export const SETUP_TIMEOUT_MS = 30 * 60 * 1000;
/** After SIGTERM to the group on timeout, how long before SIGKILL. */
const KILL_GRACE_MS = 5_000;

export type ExecResult = { code: number | null; signal: NodeJS.Signals | null; timedOut: boolean };

export interface ExecOptions {
  cwd: string;
  env: Record<string, string>;
  /** File that receives stdout and stderr (appended). */
  log: string;
  timeoutMs?: number;
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // group already gone
  }
}

export function exec(argv: string[], opts: ExecOptions): Promise<ExecResult> {
  const [cmd, ...args] = argv;
  if (!cmd) throw new Error('exec: empty argv');
  const stdin = openSync('/dev/null', 'r');
  const out = openSync(opts.log, 'a');
  return new Promise<ExecResult>((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: [stdin, out, out], detached: true });
    } catch (e) {
      reject(e);
      return;
    }
    const pid = child.pid;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      if (pid === undefined) return;
      killGroup(pid, 'SIGTERM');
      killTimer = setTimeout(() => killGroup(pid, 'SIGKILL'), KILL_GRACE_MS);
    }, opts.timeoutMs ?? SETUP_TIMEOUT_MS);
    child.on('error', (e) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      reject(e);
    });
    // 'exit', not 'close': stdio are files, and background children may hold them open.
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (pid !== undefined) killGroup(pid, 'SIGKILL');
      resolve({ code, signal, timedOut });
    });
  }).finally(() => {
    closeSync(stdin);
    closeSync(out);
  });
}
