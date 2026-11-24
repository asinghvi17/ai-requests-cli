// Whether a process that wrote a lock or a pid file still runs. One rule for every lock air keeps (the serve
// and delivery locks, the usage cache and ledger locks) and for launcher dirs. Lock files record the host
// with the pid: a state dir may be shared between machines (a network home), and a pid is only meaningful
// on the host that wrote it.
import { hostname } from 'node:os';

/** Whether `pid` runs on this host. EPERM means it runs, as another user. */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** This host, as lock files record it (no whitespace, so it is one word in a lock). */
export function thisHost(): string {
  return hostname().replace(/\s+/g, '_') || 'localhost';
}

/** Whether a lock's writer, `pid` on `host`, is known to be gone: only a process of this host can be judged. */
export function writerGone(pid: number, host: string): boolean {
  return host === thisHost() && !alive(pid);
}
