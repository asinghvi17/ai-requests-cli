// The server's own small state file, `<state dir>/serve.json`. Everything about a job lives in its
// workspace's state.json; this only holds what is about the server: whether `air pause` is in effect.
// Only the pause commands write it, so the server never races them.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SERVER_STATE_FILE = 'serve.json';

export interface ServerState {
  version: 1;
  /** `air pause`: take no new work; running jobs continue. */
  paused: boolean;
  pausedAt?: string;
}

export function readServerState(dir: string): ServerState {
  try {
    const s = JSON.parse(readFileSync(join(dir, SERVER_STATE_FILE), 'utf8')) as ServerState;
    if (s && s.version === 1 && typeof s.paused === 'boolean') return s;
  } catch {
    // missing or unreadable: defaults
  }
  return { version: 1, paused: false };
}

export function updateServerState(dir: string, patch: Partial<ServerState>): ServerState {
  mkdirSync(dir, { recursive: true });
  const s: ServerState = { ...readServerState(dir), ...patch, version: 1 };
  const tmp = join(dir, `.${SERVER_STATE_FILE}.${process.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`);
  renameSync(tmp, join(dir, SERVER_STATE_FILE));
  return s;
}

export const LOCK_FILE = 'serve.lock';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * One `air serve` per state dir: an O_EXCL lock file holding our pid. A lock whose process is gone is
 * taken over. Returns the release function.
 */
export function acquireServeLock(dir: string): () => void {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, LOCK_FILE);
  for (let attempt = 0; ; attempt++) {
    try {
      writeFileSync(file, `${process.pid}\n`, { flag: 'wx' });
      return () => {
        try {
          if (readFileSync(file, 'utf8').trim() === String(process.pid)) rmSync(file);
        } catch {
          // already gone
        }
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || attempt > 0) throw e;
      const pid = Number(readFileSync(file, 'utf8').trim());
      if (Number.isSafeInteger(pid) && pid > 0 && alive(pid)) throw new Error(`air serve is already running (pid ${pid}; lock ${file})`);
      rmSync(file, { force: true });
    }
  }
}
