import { spawn, type ChildProcess } from 'node:child_process';

/** A `.ts`/`.js` bin (a test fake) runs under this node; anything else is executed directly. */
export const command = (bin: string): [string, ...string[]] => /\.[cm]?[tj]s$/.test(bin) ? [process.execPath, bin] : [bin];

/**
 * The environment the usage CLIs get: only what they need to run and find their own login. Never API keys,
 * GitHub tokens or cloud credentials (GH_TOKEN, GITHUB_TOKEN, OPENAI_API_KEY, ANTHROPIC_API_KEY, AWS_*, ...).
 * - PATH, HOME, USER, LOGNAME, TMPDIR, LANG, LC_ALL, TERM, XDG_* dirs: process basics and where logins live.
 * - CLAUDE_CONFIG_DIR, CODEX_HOME: which login (the subscription's own dir is set on top of this).
 * - CLAUDE_CODE_OAUTH_TOKEN: the subscription login of `claude setup-token` users, who have no credentials file.
 * - HTTPS_PROXY, HTTP_PROXY, NO_PROXY (either case), NODE_EXTRA_CA_CERTS, SSL_CERT_FILE, CODEX_CA_CERTIFICATE:
 *   reaching the provider from behind a proxy or a custom CA.
 */
export const CLI_ENV_ALLOW = ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR',
  'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'CLAUDE_CODE_OAUTH_TOKEN',
  'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'CODEX_CA_CERTIFICATE'];

export function cliEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of CLI_ENV_ALLOW) if (base[k] !== undefined) env[k] = base[k];
  return env;
}

/** SIGTERM the child's process group, SIGKILL it 2s later unless the child has exited by then. */
export function killGroup(child: ChildProcess) {
  const pid = child.pid;
  if (!pid) return;
  try { process.kill(-pid, 'SIGTERM'); } catch { return; }
  if (child.exitCode !== null || child.signalCode !== null) return;
  const timer = setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } }, 2000);
  timer.unref();
  child.once('exit', () => clearTimeout(timer));
}

/** Run a CLI to completion with stdin closed, in a process group of its own; reject on non-zero exit or timeout
 *  (which kills the whole group, so no grandchild outlives the read). */
export function run(bin: string, args: string[], o: { env: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number }): Promise<string> {
  const [file, ...pre] = command(bin);
  return new Promise((resolve, reject) => {
    const child = spawn(file, [...pre, ...args], { env: o.env, cwd: o.cwd, detached: true, stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    let bytes = 0, done = false;
    const fail = (e: Error) => { if (done) return; done = true; clearTimeout(timer); killGroup(child); reject(e); };
    const timer = setTimeout(() => fail(new Error('timeout')), o.timeoutMs ?? 20000);
    child.stdout.on('data', (b: Buffer) => {
      if ((bytes += b.length) > 1 << 20) return fail(new Error('oversized output'));
      chunks.push(b);
    });
    child.on('error', fail);
    child.on('close', code => {
      if (done) return;
      done = true; clearTimeout(timer);
      killGroup(child); // reap anything it left in its group
      code === 0 ? resolve(Buffer.concat(chunks).toString('utf8')) : reject(new Error(`exit ${code}`));
    });
    child.stdin.on('error', () => {});
    child.stdin.end();
  });
}

/** Window name and kind from a length in minutes (Codex's `windowDurationMins`). */
export function windowOfMinutes(mins: number | null | undefined, fallback: string): { name: string; kind: string } {
  if (mins === 300) return { name: 'five_hour', kind: 'five_hour' };
  if (mins === 1440) return { name: 'one_day', kind: 'daily' };
  if (mins === 10080) return { name: 'seven_day', kind: 'weekly' };
  // calendar months are 28-31 days; Codex reports whole minutes
  if (mins && mins >= 28 * 1440 && mins <= 31 * 1440) return { name: 'monthly', kind: 'monthly' };
  return mins ? { name: `${mins}_min`, kind: `${mins}_min` } : { name: fallback, kind: fallback };
}

export const isoOrNull = (ms: number | null): string | null =>
  ms == null || !Number.isFinite(ms) || Math.abs(ms) > 8.64e15 ? null : new Date(ms).toISOString();
