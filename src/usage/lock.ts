// State-file helpers shared by the cache and the manual ledger: an O_EXCL lockfile around load → modify → save,
// and writes through a unique temp file so concurrent air processes never interleave or lose an update.
import { randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

/** A lock older than this is abandoned even if its pid looks alive (pid reuse). Holders keep it for milliseconds. */
const STALE_LOCK_MS = 30000;
const WAIT_MS = 10000;
const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function alive(pid: number) {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** Remove `lock` if its holder died or it is too old. */
function breakIfStale(lock: string) {
  try {
    const pid = Number(readFileSync(lock, 'utf8').split(' ')[0]);
    if ((Number.isInteger(pid) && pid > 0 && !alive(pid)) || Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) unlinkSync(lock);
  } catch { /* released meanwhile, or half-written: the next try decides */ }
}

/** Run `fn` holding `<file>.lock`. Synchronous so a holder cannot yield mid-update. */
export function withLock<T>(file: string, fn: () => T): T {
  const lock = `${file}.lock`;
  mkdirSync(dirname(file), { recursive: true });
  const deadline = Date.now() + WAIT_MS;
  let fd: number;
  for (;;) {
    try { fd = openSync(lock, 'wx', 0o600); break; } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      breakIfStale(lock);
      if (Date.now() > deadline) throw new Error(`${lock} is held by another air process`);
      sleep(5 + Math.random() * 10);
    }
  }
  try {
    writeSync(fd, `${process.pid} ${Date.now()}`);
    closeSync(fd);
    return fn();
  } finally { try { unlinkSync(lock); } catch { /* broken as stale by another process */ } }
}

export function writeAtomic(file: string, data: string) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  try { renameSync(tmp, file); } catch (e) { try { unlinkSync(tmp); } catch { /* gone */ } throw e; }
}
