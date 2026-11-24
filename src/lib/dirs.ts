// Where air keeps its files on a machine: the one place that says so (docs/config.md, "Where air keeps its files").
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

type Env = Record<string, string | undefined>;

const BASE = { config: ['XDG_CONFIG_HOME', '.config'], state: ['XDG_STATE_HOME', '.local/state'] } as const;

/**
 * air's config directory (config.toml, subscriptions.json) or state directory (serve lock and log, usage cache,
 * manual ledger): `$XDG_CONFIG_HOME/air` or `$XDG_STATE_HOME/air`, else `~/.config/air` or `~/.local/state/air`.
 * An empty or relative XDG value is ignored, as the XDG Base Directory spec says.
 */
export function airDir(kind: keyof typeof BASE, env: Env = process.env, home = homedir()): string {
  const [name, fallback] = BASE[kind];
  const xdg = env[name];
  return join(xdg && isAbsolute(xdg) ? xdg : join(home, fallback), 'air');
}
