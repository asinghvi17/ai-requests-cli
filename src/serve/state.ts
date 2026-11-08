// The server's own small state file, `<state dir>/serve.json`. Everything about a job lives in its
// workspace's state.json; this only holds what is about the server: whether `air pause` is in effect, and
// when the daily sweep last ran. The pause commands write `paused`; the server writes only `lastSweepAt`,
// once a day, re-reading the file just before it writes.
import { randomBytes } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SERVER_STATE_FILE = 'serve.json';

export interface ServerState {
  version: 1;
  /** `air pause`: take no new work; running jobs continue. */
  paused: boolean;
  pausedAt?: string;
  /** When `air serve` last started its daily `air sweep` (spec §7). */
  lastSweepAt?: string;
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

/** A lock file whose content isn't a pid is someone's lock being written, until it is this old. */
export const LOCK_GRACE_MS = 30_000;

/**
 * One `air serve` per state dir: a lock file holding our pid. It is written to a private temp file and
 * hard-linked into place, so the lock never exists half-written and two servers can't both create it. A
 * lock is taken over only when its pid is dead, or when its content is unreadable and older than
 * LOCK_GRACE_MS. Returns the release function.
 */
export function acquireServeLock(dir: string, now = () => Date.now()): () => void {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, LOCK_FILE);
  const mine = `${process.pid}\n`;
  const tmp = join(dir, `.${LOCK_FILE}.${process.pid}.${randomBytes(6).toString('hex')}`);
  writeFileSync(tmp, mine, { flag: 'wx' });
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        linkSync(tmp, file); // atomic, and fails if the lock exists
        return () => {
          try {
            if (readFileSync(file, 'utf8') === mine) rmSync(file);
          } catch {
            // already gone
          }
        };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || attempt > 2) throw e;
      }
      let content: string, age: number;
      try {
        content = readFileSync(file, 'utf8');
        age = now() - statSync(file).mtimeMs;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; // released meanwhile: try again
        throw e;
      }
      const pid = /^\d+\n$/.test(content) ? Number(content) : NaN;
      const stale = Number.isSafeInteger(pid) && pid > 0 ? !alive(pid) : age > LOCK_GRACE_MS;
      if (!stale) throw new Error(`air serve is already running (${Number.isNaN(pid) ? 'lock being written' : `pid ${pid}`}; lock ${file})`);
      // Take the stale lock aside by rename (only one contender wins it), and make sure it was the one we judged.
      const aside = `${tmp}.stale`;
      try {
        renameSync(file, aside);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw e;
      }
      if (readFileSync(aside, 'utf8') !== content) {
        // A fresh lock replaced the stale one between our read and the rename: put it back.
        try {
          linkSync(aside, file);
        } catch {
          // someone else holds it now anyway
        }
        rmSync(aside, { force: true });
        throw new Error(`air serve is already running (lock ${file} was just taken)`);
      }
      rmSync(aside, { force: true });
    }
  } finally {
    rmSync(tmp, { force: true });
  }
}
