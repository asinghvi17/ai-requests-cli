// Thin wrapper around `gh api`: JSON in and out, pagination and error mapping. gh holds the credentials;
// air never reads, stores or logs a token. The process runner is injectable for tests.
import { spawn } from 'node:child_process';

export type RunResult = { code: number; stdout: string; stderr: string };
export type Runner = (args: string[], input?: string) => Promise<RunResult>;

export type GhErrorKind = 'missing_gh' | 'auth' | 'not_found' | 'rate_limited' | 'validation' | 'server' | 'other';

export class GhError extends Error {
  readonly kind: GhErrorKind;
  readonly status: number | undefined;
  constructor(kind: GhErrorKind, message: string, status?: number) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

// Settles once. If gh exits before reading its input (stdin EPIPE), a failing gh still resolves so its own
// error is mapped; a gh that exits 0 without reading the request body rejects.
export const spawnGh: Runner = (args, input) =>
  new Promise((resolve, reject) => {
    let settled = false;
    const settle = (f: () => void) => {
      if (!settled) {
        settled = true;
        f();
      }
    };
    const child = spawn('gh', args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' } });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let stdinError: NodeJS.ErrnoException | undefined;
    child.stdout.on('data', (b: Buffer) => out.push(b));
    child.stderr.on('data', (b: Buffer) => err.push(b));
    child.stdin.on('error', (e: NodeJS.ErrnoException) => { stdinError = e; });
    child.on('error', (e: NodeJS.ErrnoException) =>
      settle(() => reject(e.code === 'ENOENT' ? new GhError('missing_gh', 'gh not found on PATH: install the GitHub CLI and run `gh auth login`') : e)));
    child.on('close', (code, signal) =>
      settle(() => {
        const result = { code: code ?? 1, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') };
        if (stdinError && result.code === 0) {
          reject(new GhError('other', `gh ${args.slice(0, 2).join(' ')} exited without reading its input (${stdinError.code ?? stdinError.message})`));
        } else {
          if (signal && !result.stderr) result.stderr = `gh killed by ${signal}`;
          resolve(result);
        }
      }));
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
    : status === 422 ? 'validation'
    : status !== undefined && status >= 500 ? 'server'
    : 'other';
  return new GhError(kind, message, status);
}

export type Gh = {
  api<T = unknown>(path: string, opts?: ApiOptions): Promise<T>;
  paginate<T = unknown>(path: string, opts?: { headers?: Record<string, string> }): Promise<T[]>;
};

function baseArgs(path: string, headers: Record<string, string> | undefined): string[] {
  if (path.startsWith('-')) throw new GhError('other', `bad API path ${JSON.stringify(path)}`);
  const args = ['api', path];
  for (const [k, v] of Object.entries(headers ?? {})) args.push('-H', `${k}: ${v}`);
  return args;
}

export function createGh(run: Runner = spawnGh): Gh {
  const call = async (args: string[], input?: string): Promise<unknown> => {
    const r = await run(args, input);
    if (r.code !== 0) throw mapError(r);
    if (r.stdout.trim() === '') return undefined; // 204 No Content
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
  };
}
