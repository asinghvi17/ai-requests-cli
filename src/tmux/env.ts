// Job environments and command lines. A job inherits the environment air runs in, the volunteer's: every
// variable is passed through, and the caller only adds or overrides variables (the AIR_* ones, an agent's
// config dir). The tmux client and server get an allowlisted environment of their own.

/** Copied from the caller's environment for the tmux client when set. */
export const ALLOWED_VARS = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TZ'];

/** Set by tmux for the job's own pane: the caller's values would point at another tmux. */
const PANE_VARS = ['TMUX', 'TMUX_PANE'];

/**
 * The job's whole environment: every variable of `base`, then `extra` on top. TMUX and TMUX_PANE are
 * left to tmux. Throws on a malformed name in `extra`.
 */
export function jobEnv(extra: Record<string, string> = {}, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, v] of Object.entries(base)) if (v !== undefined && !PANE_VARS.includes(name)) env[name] = v;
  for (const [name, value] of Object.entries(extra)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`tmux: bad environment variable name ${JSON.stringify(name)}`);
    env[name] = value;
  }
  return env;
}

/**
 * Check a job's argv before it goes into its launcher (`env K=V ... argv...`).
 * stdin stays the pane's TTY, so the agent remains interactive.
 */
export function checkJob(argv: string[]): void {
  const [cmd] = argv;
  if (!cmd) throw new Error('tmux: empty job argv');
  // env(1) would read a leading NAME=value word as an assignment.
  if (cmd.includes('=')) throw new Error(`tmux: job command may not contain '=': ${cmd}`);
}

/** Environment for the tmux client process, so a server we start does not hold the caller's secrets. */
export function clientEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of [...ALLOWED_VARS, 'TERM', 'TMUX_TMPDIR']) {
    const v = base[name];
    if (v !== undefined) env[name] = v;
  }
  return env;
}
