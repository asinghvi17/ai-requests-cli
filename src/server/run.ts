// `air serve`'s lifecycle around the loop (`server.ts`): its tmux window, the serve lock and its refresh,
// SIGINT and SIGTERM, and closing air's tmux session when it stops.
import { CommandError } from '../lib/index.ts';
import type { ServeContext } from './context.ts';
import { createServer } from './server.ts';
import { acquireServeLock, serving, type PidLock } from './state.ts';
import { jobEnv } from './tmux/env.ts';

/**
 * Wraps the server in its tmux window: a no-op INT trap keeps this shell up while air shuts down on C-c, and
 * after a failure the window stays open until Enter, so its last words can be read.
 */
const HOLD = ['/bin/sh', '-c', 'trap : INT; "$@"; s=$?; [ "$s" -eq 0 ] || { printf "\\nair serve exited with status %s; press Enter to close this window\\n" "$s"; read -r _; }; exit "$s"', 'air'];

/** Starts `argv` (an `air serve`) in its own window of air's tmux session, with the environment `env` gives a job. */
export async function startServerWindow(ctx: ServeContext, argv: string[], env: NodeJS.ProcessEnv): Promise<{ window: string; joined: boolean }> {
  const serverEnv = jobEnv({}, env);
  delete serverEnv.TERM; // the window's is tmux's
  return ctx.tmux.startServer([...HOLD, ...argv], serverEnv);
}

export interface RunOptions {
  manual: boolean;
  once: boolean;
  onceWaitMs?: number | undefined;
  /** The tmux pane this server runs in, when it is in air's session: closing the idle session spares it. */
  pane?: string | undefined;
}

/**
 * Serves in this process until SIGINT or SIGTERM (or one pass, with `once`), holding the serve lock. Throws
 * CommandError when another server holds it.
 */
export async function runServer(ctx: ServeContext, opts: RunOptions): Promise<void> {
  let lock: PidLock;
  try {
    lock = acquireServeLock(ctx.stateDir);
  } catch (e) {
    throw new CommandError((e as Error).message);
  }
  // Kept fresh, so a server on another host sharing this state dir never takes it for stale (FOREIGN_LOCK_MS).
  const fresh = setInterval(() => lock.refresh(), 60_000);
  fresh.unref();
  const server = createServer(ctx, { manual: opts.manual });
  if (ctx.logFile) {
    try {
      await ctx.tmux.ensureSession({ argv: ['tail', '-n', '200', '-F', ctx.logFile] });
    } catch (e) {
      ctx.log(`tmux: ${(e as Error).message}`);
    }
  }
  const ctl = new AbortController();
  const stop = () => {
    ctx.log('stopping: running agents keep going in tmux and are re-adopted on the next `air serve`');
    ctl.abort();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await server.run({ once: opts.once, signal: ctl.signal, ...(opts.onceWaitMs !== undefined ? { onceWaitMs: opts.onceWaitMs } : {}) });
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    clearInterval(fresh);
    lock.release();
    // With no job window left, air's tmux session ends with it (from its `serve` window: as that closes), unless
    // another server took the lock meanwhile.
    try {
      if (!serving(ctx.stateDir) && (await ctx.tmux.closeIfIdle(opts.pane))) ctx.log('stopped; no job windows were left, so the air tmux session ends');
    } catch (e) {
      ctx.log(`tmux: ${(e as Error).message}`);
    }
  }
}
