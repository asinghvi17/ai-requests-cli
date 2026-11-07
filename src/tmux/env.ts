// Job environments and command lines. Jobs never inherit the server's environment: the pane runs
// `env -i` with an explicit allowlist, so tokens (GH_TOKEN, AWS_*, SSH_AUTH_SOCK, ...) cannot leak.

/** Copied from the caller's environment when set. Everything else must be passed explicitly. */
export const ALLOWED_VARS = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TZ'];

/** Agents' own config dir variables (Claude Code, Codex CLI). */
export const AGENT_CONFIG_VARS = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME'];

/** Never passed to a job, even when a caller asks. */
const DENIED = [/^GH_/, /^GITHUB_/, /^AWS_/, /^SSH_/, /^GPG_/, /^GOOGLE_APPLICATION_CREDENTIALS$/, /^AZURE_/,
  /^NPM_TOKEN$/, /^NODE_AUTH_TOKEN$/, /^TMUX/, /^LD_PRELOAD$/, /^NODE_OPTIONS$/];

export function isDenied(name: string): boolean {
  return DENIED.some(re => re.test(name));
}

/**
 * The job's whole environment: allowlisted variables from `base`, then `extra` (which may override them).
 * Throws on a denied or malformed name in `extra`; denied names in `base` are simply not copied.
 */
export function jobEnv(extra: Record<string, string> = {}, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of [...ALLOWED_VARS, ...AGENT_CONFIG_VARS]) {
    const v = base[name];
    if (v !== undefined) env[name] = v;
  }
  for (const [name, value] of Object.entries(extra)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`tmux: bad environment variable name ${JSON.stringify(name)}`);
    if (isDenied(name)) throw new Error(`tmux: refusing to pass ${name} to a job`);
    env[name] = value;
  }
  return env;
}

/**
 * The argv tmux runs directly (no shell, so the volunteer's default-shell does not matter):
 * `env -i K=V ... argv...`. With `promptFile`, its contents are appended as the last argument by a
 * `/bin/sh` wrapper, which keeps long prompts out of tmux's size-limited command messages.
 */
export function jobArgv(argv: string[], env: Record<string, string>, promptFile?: string): string[] {
  const [cmd] = argv;
  if (!cmd) throw new Error('tmux: empty job argv');
  // env(1) would read a leading NAME=value word as an assignment.
  if (cmd.includes('=')) throw new Error(`tmux: job command may not contain '=': ${cmd}`);
  const vars = Object.entries(env).map(([k, v]) => `${k}=${v}`);
  const tail = promptFile === undefined ? argv : ['/bin/sh', '-c', 'p=$(cat -- "$0") || exit 1; exec "$@" "$p"', promptFile, ...argv];
  return ['env', '-i', ...vars, ...tail];
}

/** Environment for the tmux client process, so a server we start does not hold the caller's secrets either. */
export function clientEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of [...ALLOWED_VARS, 'TERM', 'TMUX_TMPDIR']) {
    const v = base[name];
    if (v !== undefined) env[name] = v;
  }
  return env;
}
