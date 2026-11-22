// The server's own small state file, `<state dir>/serve.json`. Everything about a job lives in its
// workspace's state.json; this only holds what is about the server: whether `air pause` is in effect, and
// when the daily sweep last ran. The pause commands write `paused`; the server writes only `lastSweepAt`,
// once a day, re-reading the file just before it writes.
// `pidLock` (serve.lock here, a workspace's delivery lock in jobs.ts) keeps a step to one process at a time.
import { randomBytes } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { thisHost, writerGone } from '../pid.ts';

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

/** A lock file whose content isn't a pid and host is someone's lock being written, until it is this old. */
export const LOCK_GRACE_MS = 30_000;
/**
 * A lock another host wrote can't be judged by its pid: it is stale only once it is this old. Its holder
 * refreshes it (`refresh`) while it holds it for long, as `air serve` does its serve lock.
 */
export const FOREIGN_LOCK_MS = 15 * 60_000;

/** A `pidLock` file's writer: `<pid> <host>\n`. */
function lockOwner(content: string): { pid: number; host: string } | undefined {
  const m = /^(\d+) (\S+)\n$/.exec(content);
  const pid = Number(m?.[1]);
  return m && Number.isSafeInteger(pid) && pid > 0 ? { pid, host: m[2]! } : undefined;
}

/**
 * Whether a `pidLock` file with `content`, last written `age` ms ago, is stale: its writer on this host is
 * dead; or another host wrote it and it is older than FOREIGN_LOCK_MS; or it is unreadable past LOCK_GRACE_MS.
 */
function isStale(content: string, age: number): boolean {
  const owner = lockOwner(content);
  if (!owner) return age > LOCK_GRACE_MS;
  return owner.host === thisHost() ? writerGone(owner.pid, owner.host) : age > FOREIGN_LOCK_MS;
}

const describe = (content: string) => {
  const owner = lockOwner(content);
  return owner ? `pid ${owner.pid}${owner.host === thisHost() ? '' : ` on ${owner.host}`}` : 'lock being written';
};

/** Whether `file` is a stale `pidLock` (read-only; false when there is none). */
export function staleLock(file: string, now = () => Date.now()): boolean {
  try {
    return isStale(readFileSync(file, 'utf8'), now() - statSync(file).mtimeMs);
  } catch {
    return false;
  }
}

/** Whether `file` is a `pidLock` that a live process holds (read-only). */
export function liveLock(file: string, now = () => Date.now()): boolean {
  return existsSync(file) && !staleLock(file, now);
}

/**
 * Removes `file` if it is a stale `pidLock`, the way a new holder takes one over (so a live holder's lock is
 * never removed). Returns whether it was removed.
 */
export function clearStaleLock(file: string, now = () => Date.now()): boolean {
  if (!staleLock(file, now)) return false;
  const lock = pidLock(file, now);
  if ('held' in lock) return false;
  lock.release();
  return true;
}

/** A lock `pidLock` took: give it back, or mark it fresh (for a holder that keeps it longer than FOREIGN_LOCK_MS). */
export interface PidLock { release: () => void; refresh: () => void }

/**
 * An exclusive lock file holding our pid and host. It is written to a private temp file and hard-linked into
 * place, so the lock never exists half-written and two processes can't both create it. A lock is taken over
 * only when it is stale (`isStale`). Returns the lock, or what holds it (`pid N [on HOST]`, or `lock being
 * written`). The holder's own process holds it too: a second take in the same process is refused. The lock's
 * directory must exist: a lock never creates it (so a delivery lock never brings back a removed workspace).
 */
export function pidLock(file: string, now = () => Date.now()): PidLock | { held: string } {
  const dir = dirname(file);
  const mine = `${process.pid} ${thisHost()}\n`;
  const tmp = join(dir, `.${basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}`);
  writeFileSync(tmp, mine, { flag: 'wx' });
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        linkSync(tmp, file); // atomic, and fails if the lock exists
        const ours = () => {
          try {
            return readFileSync(file, 'utf8') === mine;
          } catch {
            return false; // already gone
          }
        };
        return {
          release: () => { if (ours()) rmSync(file, { force: true }); },
          refresh: () => { if (ours()) utimesSync(file, new Date(), new Date()); },
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
      if (!isStale(content, age)) return { held: describe(content) };
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
        return { held: 'just taken' };
      }
      rmSync(aside, { force: true });
    }
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Whether an `air serve` holds this state dir's lock now (tried and released at once). */
export function serving(dir: string): boolean {
  mkdirSync(dir, { recursive: true });
  const lock = pidLock(join(dir, LOCK_FILE));
  if ('held' in lock) return true;
  lock.release();
  return false;
}

/** One `air serve` per state dir (`pidLock` on `serve.lock`). */
export function acquireServeLock(dir: string, now = () => Date.now()): PidLock {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, LOCK_FILE);
  const lock = pidLock(file, now);
  if ('held' in lock) throw new Error(`air serve is already running (${lock.held}; lock ${file})`);
  return lock;
}
