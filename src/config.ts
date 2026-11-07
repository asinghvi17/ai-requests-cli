// ~/.config/air/config.toml (or $XDG_CONFIG_HOME/air/config.toml): which requests repo to serve, where
// workspaces live, how many jobs run at once, the local subscriptions and each harness's model tiers.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { parseToml, type TomlTable, type TomlValue } from './toml.ts';

export const TIERS = ['small', 'medium', 'large'] as const;
export type Tier = (typeof TIERS)[number];
export type Models = Record<Tier, string>;

export type Subscription = {
  harness: string;
  scale: number; // multiplier on effort units this subscription can absorb (e.g. a 20x plan vs a 5x one)
  reserve: number; // fraction of the quota window kept for the owner, 0 <= reserve < 1
  budget?: number; // manual effort budget per window, for subscriptions whose usage can't be read
};

export type Config = {
  repo?: string;
  workspace_root: string;
  max_jobs: number;
  subscriptions: Record<string, Subscription>;
  models: Record<string, Models>;
};

export const DEFAULT_MODELS: Record<string, Models> = {
  claude: { small: 'haiku', medium: 'sonnet', large: 'opus' },
};

export class ConfigError extends Error {}

type Env = Record<string, string | undefined>;

export function configPath(env: Env = process.env, home = homedir()): string {
  const xdg = env.XDG_CONFIG_HOME;
  return join(xdg && isAbsolute(xdg) ? xdg : join(home, '.config'), 'air', 'config.toml');
}

function expandHome(p: string, home: string): string {
  return p === '~' ? home : p.startsWith('~/') ? join(home, p.slice(2)) : p;
}

function table(v: TomlValue | undefined, where: string): TomlTable {
  if (v === undefined) return {};
  if (typeof v !== 'object' || Array.isArray(v)) throw new ConfigError(`${where} must be a table`);
  return v;
}

function str(v: TomlValue | undefined, where: string): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || v === '') throw new ConfigError(`${where} must be a non-empty string`);
  return v;
}

function num(v: TomlValue | undefined, where: string, ok: (n: number) => boolean, rule: string): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v) || !ok(v)) throw new ConfigError(`${where} must be ${rule}`);
  return v;
}

function only(t: TomlTable, keys: readonly string[], where: string): void {
  for (const k of Object.keys(t)) if (!keys.includes(k)) throw new ConfigError(`unknown key ${where}${k}`);
}

export function parseConfig(src: string, home = homedir()): Config {
  let doc: TomlTable;
  try {
    doc = parseToml(src);
  } catch (e) {
    throw new ConfigError(e instanceof Error ? e.message : String(e));
  }
  only(doc, ['repo', 'workspace_root', 'max_jobs', 'subscriptions', 'models'], '');
  const repo = str(doc.repo, 'repo');
  if (repo !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new ConfigError('repo must be OWNER/NAME');
  const root = expandHome(str(doc.workspace_root, 'workspace_root') ?? '~/air', home);
  if (!isAbsolute(root)) throw new ConfigError('workspace_root must be an absolute path or start with ~/');

  const subscriptions: Record<string, Subscription> = {};
  for (const [name, raw] of Object.entries(table(doc.subscriptions, 'subscriptions'))) {
    const w = `subscriptions.${name}`;
    const t = table(raw, w);
    only(t, ['harness', 'scale', 'reserve', 'budget'], `${w}.`);
    const harness = str(t.harness, `${w}.harness`);
    if (harness === undefined) throw new ConfigError(`${w}.harness is required`);
    const sub: Subscription = {
      harness,
      scale: num(t.scale, `${w}.scale`, (n) => n > 0, 'a positive number') ?? 1,
      reserve: num(t.reserve, `${w}.reserve`, (n) => n >= 0 && n < 1, 'a number in [0, 1)') ?? 0,
    };
    const budget = num(t.budget, `${w}.budget`, (n) => n >= 0, 'a non-negative number');
    if (budget !== undefined) sub.budget = budget;
    subscriptions[name] = sub;
  }

  const models: Record<string, Models> = structuredClone(DEFAULT_MODELS);
  for (const [harness, raw] of Object.entries(table(doc.models, 'models'))) {
    const w = `models.${harness}`;
    const t = table(raw, w);
    only(t, TIERS, `${w}.`);
    const tiers: Partial<Models> = Object.hasOwn(models, harness) ? { ...models[harness] } : {};
    for (const tier of TIERS) {
      const m = str(t[tier], `${w}.${tier}`);
      if (m !== undefined) tiers[tier] = m;
    }
    const missing = TIERS.filter((tier) => tiers[tier] === undefined);
    if (missing.length) throw new ConfigError(`${w} is missing ${missing.join(', ')}`);
    models[harness] = tiers as Models;
  }

  const config: Config = {
    workspace_root: root,
    max_jobs: num(doc.max_jobs, 'max_jobs', (n) => Number.isInteger(n) && n >= 1, 'a positive integer') ?? 1,
    subscriptions,
    models,
  };
  if (repo !== undefined) config.repo = repo;
  return config;
}

// A missing file is the all-defaults config; a malformed one is an error naming the file.
export function loadConfig(path = configPath(), home = homedir()): Config {
  let src: string;
  try {
    src = readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return parseConfig('', home);
    throw e;
  }
  try {
    return parseConfig(src, home);
  } catch (e) {
    if (e instanceof ConfigError) throw new ConfigError(`${path}: ${e.message}`);
    throw e;
  }
}
