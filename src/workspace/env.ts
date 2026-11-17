// Environments for `setup` and `check`: an allowlist copied from the server's environment plus the
// spec's AIR_* variables, never the server's credentials. (The agent itself inherits the whole
// environment: see src/tmux/env.ts.)

/** Copied from the server's environment when set. Everything else is dropped. */
export const ALLOWED_VARS = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TZ', 'TERM'];

/** Never passed to a child, even when a caller asks: tokens, cloud keys, agent sockets, shell hooks. */
const DENIED = [/^GH_/, /^GITHUB_/, /^AWS_/, /^SSH_/, /^GPG_/, /^GOOGLE_/, /^GCLOUD_/, /^CLOUDSDK_/, /^AZURE_/, /^ARM_/,
  /^NPM_TOKEN$/, /^NODE_AUTH_TOKEN$/, /^ANTHROPIC_/, /^OPENAI_/, /^CLAUDE_CODE_OAUTH_TOKEN$/, /^TMUX/, /^LD_/, /^DYLD_/,
  /^NODE_OPTIONS$/, /^BASH_ENV$/, /^ENV$/, /^GIT_/];

export function isDenied(name: string): boolean {
  return DENIED.some((re) => re.test(name));
}

/** Allowlisted variables from `base`, then `extra`. A denied or malformed name in `extra` throws. */
export function childEnv(extra: Record<string, string>, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ALLOWED_VARS) {
    const v = base[name];
    if (v !== undefined) env[name] = v;
  }
  for (const [name, value] of Object.entries(extra)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`bad environment variable name ${JSON.stringify(name)}`);
    if (isDenied(name)) throw new Error(`refusing to pass ${name} to a child process`);
    env[name] = value;
  }
  return env;
}
