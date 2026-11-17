// Thin wrapper around `gh api`: JSON in and out, pagination and error mapping. gh holds the credentials;
// air never reads, stores or logs a token. The process runner is injectable for tests.
import { spawn } from 'node:child_process';
import { closeSync, openSync, writeSync } from 'node:fs';

export type RunResult = { code: number; stdout: string; stderr: string };
/** Where a download's stdout goes instead of `stdout`: a new file, at most `maxBytes` long. */
export type OutFile = { path: string; maxBytes: number };
/**
 * Runs gh. `signal` aborting means the call timed out: kill gh and reject. With `out`, gh's stdout is
 * written to that file (created, never overwritten) instead, and gh is killed and the call rejects as soon
 * as more than `out.maxBytes` arrive.
 */
export type Runner = (args: string[], input?: string, signal?: AbortSignal, out?: OutFile) => Promise<RunResult>;

export type GhErrorKind = 'missing_gh' | 'auth' | 'not_found' | 'rate_limited' | 'forbidden' | 'validation' | 'server' | 'timeout' | 'other';

/** Default limit for one gh call; uploads pass a longer one. */
export const GH_TIMEOUT_MS = 2 * 60_000;
/** After SIGTERM on abort, how long before SIGKILL. */
const KILL_GRACE_MS = 2_000;

export class GhError extends Error {
  readonly kind: GhErrorKind;
  readonly status: number | undefined;
  constructor(kind: GhErrorKind, message: string, status?: number) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

// Settles once. With `outFile`, stdout goes to that file and passing its limit kills gh and rejects. If gh exits before reading its input (a stdin write error: EPIPE, or ENOTCONN on macOS), a failing gh still resolves so its own
// error is mapped; a gh that exits 0 without reading the request body rejects. An aborted `signal` kills gh
// (SIGTERM, then SIGKILL) and rejects with a `timeout` error at once, without waiting for it to exit.
export const spawnGh: Runner = (args, input, signal, outFile) =>
  new Promise((resolve, reject) => {
    let settled = false;
    const settle = (f: () => void) => {
      if (!settled) {
        settled = true;
        f();
      }
    };
    let fd: number | undefined;
    try {
      if (outFile) fd = openSync(outFile.path, 'wx', 0o600);
    } catch (e) {
      reject(e);
      return;
    }
    // Its own process group, so a timeout kills gh and anything it started (a credential helper, a pager).
    const child = spawn('gh', args, { stdio: ['pipe', 'pipe', 'pipe'], detached: true, env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' } });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let stdinError: NodeJS.ErrnoException | undefined;
    let written = 0;
    const closeOut = () => {
      if (fd !== undefined) closeSync(fd);
      fd = undefined;
    };
    child.stdout.on('data', (b: Buffer) => {
      if (!outFile) return void out.push(b);
      if (fd === undefined) return;
      written += b.length;
      if (written > outFile.maxBytes) {
        closeOut();
        stop(new GhError('other', `download passed the ${outFile.maxBytes} bytes declared; aborted`));
        return;
      }
      for (let off = 0; off < b.length;) off += writeSync(fd, b, off);
    });
    child.stderr.on('data', (b: Buffer) => err.push(b));
    // A read error on a pipe must not become an uncaught 'error' event; 'close' still follows.
    child.stdout.on('error', () => {});
    child.stderr.on('error', () => {});
    child.stdin.on('error', (e: NodeJS.ErrnoException) => { stdinError = e; });
    let killTimer: NodeJS.Timeout | undefined;
    const killGroup = (sig: NodeJS.Signals) => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, sig);
      } catch {
        child.kill(sig);
      }
    };
    const stop = (e: Error) => {
      killGroup('SIGTERM');
      killTimer = setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS);
      killTimer.unref();
      // Don't let a child that ignores the signals keep our pipes, or the event loop, alive.
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      closeOut();
      settle(() => reject(e));
    };
    const onAbort = () => stop(new GhError('timeout', `gh ${args.slice(0, 2).join(' ')} timed out`));
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e: NodeJS.ErrnoException) => {
      closeOut();
      settle(() => reject(e.code === 'ENOENT' ? new GhError('missing_gh', 'gh not found on PATH: install the GitHub CLI and run `gh auth login`') : e));
    });
    child.on('close', (code, sig) => {
      closeOut();
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', onAbort);
      settle(() => {
        const result = { code: code ?? 1, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') };
        if (stdinError && result.code === 0) {
          reject(new GhError('other', `gh ${args.slice(0, 2).join(' ')} exited without reading its input (${stdinError.code ?? stdinError.message})`));
        } else {
          if (sig && !result.stderr) result.stderr = `gh killed by ${sig}`;
          resolve(result);
        }
      });
    });
    child.stdin.end(input ?? '');
  });

export type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
export type ApiOptions = { method?: Method; body?: unknown; headers?: Record<string, string> };

function mapError(r: RunResult): GhError {
  const stderr = r.stderr.trim();
  const status = Number(/\(HTTP (\d{3})\)/.exec(stderr)?.[1]) || undefined;
  let message = stderr.replace(/^gh: /, '') || `gh exited ${r.code}`;
  try {
    const body = JSON.parse(r.stdout) as { message?: string; errors?: { message?: string }[] };
    const details = (body.errors ?? []).map((e) => e.message).filter(Boolean);
    if (body.message) message = [body.message, ...details].join(': ') + (status ? ` (HTTP ${status})` : '');
  } catch {
    // not JSON: keep stderr
  }
  const kind: GhErrorKind =
    /gh auth login|not logged in|authentication/i.test(stderr) || status === 401 ? 'auth'
    : status === 404 ? 'not_found'
    : status === 429 || (status === 403 && /rate limit/i.test(message)) ? 'rate_limited'
    : status === 403 ? 'forbidden'
    : status === 422 ? 'validation'
    : status !== undefined && status >= 500 ? 'server'
    : 'other';
  return new GhError(kind, message, status);
}

export type Gh = {
  api<T = unknown>(path: string, opts?: ApiOptions): Promise<T>;
  paginate<T = unknown>(path: string, opts?: { headers?: Record<string, string> }): Promise<T[]>;
  /** POSTs the bytes of `file` (gh reads it; air never holds the token) to `url`, e.g. a release upload URL. */
  upload<T = unknown>(url: string, file: string, contentType: string, opts?: { timeoutMs?: number }): Promise<T>;
  /**
   * GETs `path` with `Accept: application/octet-stream` (a release asset's bytes, private repos included)
   * into the new file `dest`, failing as soon as more than `maxBytes` arrive.
   */
  download(path: string, dest: string, maxBytes: number, opts?: { timeoutMs?: number }): Promise<void>;
};

function baseArgs(path: string, headers: Record<string, string> | undefined): string[] {
  if (path.startsWith('-')) throw new GhError('other', `bad API path ${JSON.stringify(path)}`);
  const args = ['api', path];
  for (const [k, v] of Object.entries(headers ?? {})) args.push('-H', `${k}: ${v}`);
  return args;
}

/**
 * `timeoutMs` bounds every call: on expiry the runner is aborted (spawnGh kills gh) and the call rejects with
 * a `timeout` GhError, even if the runner ignores the signal.
 */
export function createGh(run: Runner = spawnGh, opts: { timeoutMs?: number } = {}): Gh {
  const limit = opts.timeoutMs ?? GH_TIMEOUT_MS;
  const call = async (args: string[], input?: string, timeoutMs = limit, out?: OutFile): Promise<unknown> => {
    const ctl = new AbortController();
    const timedOut = () => new GhError('timeout', `gh ${args.slice(0, 2).join(' ')} timed out after ${Math.round(timeoutMs / 1000)} s`);
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(timedOut());
        ctl.abort();
      }, timeoutMs);
    });
    let r: RunResult;
    try {
      r = await Promise.race([run(args, input, ctl.signal, out), expired]);
    } catch (e) {
      throw ctl.signal.aborted ? timedOut() : e;
    } finally {
      clearTimeout(timer);
    }
    if (r.code !== 0) throw mapError(r);
    if (out || r.stdout.trim() === '') return undefined; // a download, or 204 No Content
    try {
      return JSON.parse(r.stdout);
    } catch {
      throw new GhError('other', `gh ${args.slice(0, 2).join(' ')}: response is not JSON`);
    }
  };
  return {
    async api<T>(path: string, opts: ApiOptions = {}): Promise<T> {
      const args = baseArgs(path, opts.headers);
      args.push('--method', opts.method ?? 'GET');
      if (opts.body === undefined) return (await call(args)) as T;
      args.push('--input', '-');
      return (await call(args, JSON.stringify(opts.body))) as T;
    },
    // GET every page and concatenate. List endpoints return arrays; search-style endpoints wrap them
    // ({ total_count, items }), in which case the `items` are concatenated.
    async paginate<T>(path: string, opts: { headers?: Record<string, string> } = {}): Promise<T[]> {
      const pages = await call([...baseArgs(path, opts.headers), '--paginate', '--slurp']);
      if (!Array.isArray(pages)) throw new GhError('other', `gh api ${path}: expected a list of pages`);
      return pages.flatMap((p: unknown) =>
        Array.isArray(p) ? p : p && typeof p === 'object' && Array.isArray((p as { items?: unknown }).items) ? (p as { items: T[] }).items : [p]) as T[];
    },
    async upload<T>(url: string, file: string, contentType: string, o: { timeoutMs?: number } = {}): Promise<T> {
      if (file.startsWith('-')) throw new GhError('other', `bad upload file ${JSON.stringify(file)}`);
      const args = [...baseArgs(url, { 'Content-Type': contentType }), '--method', 'POST', '--input', file];
      return (await call(args, undefined, o.timeoutMs ?? limit)) as T;
    },
    async download(path, dest, maxBytes, o = {}) {
      const args = [...baseArgs(path, { Accept: 'application/octet-stream' }), '--method', 'GET'];
      await call(args, undefined, o.timeoutMs ?? limit, { path: dest, maxBytes });
    },
  };
}
