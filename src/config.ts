// ~/.config/air/config.toml (or $XDG_CONFIG_HOME/air/config.toml): which requests repo to serve, where
// workspaces live, how many jobs run at once, the local subscriptions and each harness's model tiers.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { parseToml, type TomlTable, type TomlValue } from './lib/index.ts';

export const TIERS = ['small', 'medium', 'large'] as const;
export type Tier = (typeof TIERS)[number];
export type Models = Record<Tier, string>;

export type Subscription = {
  harness: string;
  /** US dollars at API prices a full primary window (weekly, else monthly) of this plan is worth, so its percent
   *  meter compares with efforts in dollars. Not used for a manual subscription, whose budget is in dollars. */
  window_usd?: number;
  reserve: number; // fraction of the quota window kept for the owner, 0 <= reserve < 1
};

/** `[agents.<harness>]`: how `air serve` starts that harness's agent. A missing key takes its DEFAULT_AGENTS value. */
export type Agent = {
  /** argv prefix for the agent, e.g. `["claude"]`. */
  command: string[];
  /** Arguments after air's own: the mode that lets the agent run unattended. */
  args: string[];
};

export type Config = {
  repo?: string;
  workspace_root: string;
  max_jobs: number;
  /** Seconds between `air serve` ticks. */
  tick_seconds: number;
  subscriptions: Record<string, Subscription>;
  models: Record<string, Models>;
  agents: Record<string, Agent>;
};

/**
 * The `window_usd` first run suggests (and writes without a terminal): the low end of what a Max plan's weekly
 * window is worth at API prices, which runs from hundreds of dollars to over a thousand. At $500 an effort S
 * ($3) is 0.6% of a week and XL ($100) 20%. See docs/decisions.md.
 */
export const DEFAULT_WINDOW_USD = 500;
/**
 * The share of each window kept for the owner when a subscription sets no `reserve`: air takes no new work
 * once the window is 70% used, until the last 24 hours before it resets, when the reserve tapers to 0.
 */
export const DEFAULT_RESERVE = 0.3;

export const AGENT_HARNESSES = ['claude', 'codex'] as const;

export const DEFAULT_MODELS: Record<string, Models> = {
  claude: { small: 'haiku', medium: 'sonnet', large: 'opus' },
};

/**
 * How each harness runs unattended (checked against Claude Code 2.1.311 and Codex CLI 0.164.0; see
 * docs/decisions.md). Claude Code: auto mode, where a classifier approves safe tool calls and blocks risky
 * ones instead of asking. Codex: never ask for approval, in the workspace-write sandbox with network access.
 */
export const DEFAULT_AGENTS: Record<(typeof AGENT_HARNESSES)[number], Agent> = {
  claude: { command: ['claude'], args: ['--permission-mode', 'auto'] },
  codex: { command: ['codex'], args: ['--ask-for-approval', 'never', '--sandbox', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=true'] },
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

function strings(v: TomlValue | undefined, where: string): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new ConfigError(`${where} must be an array of strings`);
  return v as string[];
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
  only(doc, ['repo', 'workspace_root', 'max_jobs', 'tick_seconds', 'subscriptions', 'models', 'agents'], '');
  const repo = str(doc.repo, 'repo');
  if (repo !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new ConfigError('repo must be OWNER/NAME');
  const root = expandHome(str(doc.workspace_root, 'workspace_root') ?? '~/air', home);
  if (!isAbsolute(root)) throw new ConfigError('workspace_root must be an absolute path or start with ~/');

  const subscriptions: Record<string, Subscription> = {};
  for (const [name, raw] of Object.entries(table(doc.subscriptions, 'subscriptions'))) {
    const w = `subscriptions.${name}`;
    const t = table(raw, w);
    only(t, ['harness', 'window_usd', 'reserve'], `${w}.`);
    const harness = str(t.harness, `${w}.harness`);
    if (harness === undefined) throw new ConfigError(`${w}.harness is required`);
    const sub: Subscription = {
      harness,
      reserve: num(t.reserve, `${w}.reserve`, (n) => n >= 0 && n < 1, 'a number in [0, 1)') ?? DEFAULT_RESERVE,
    };
    const windowUsd = num(t.window_usd, `${w}.window_usd`, (n) => n > 0, 'a positive number (US dollars)');
    if (windowUsd !== undefined) sub.window_usd = windowUsd;
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

  const agents: Record<string, Agent> = structuredClone(DEFAULT_AGENTS);
  for (const [harness, raw] of Object.entries(table(doc.agents, 'agents'))) {
    const w = `agents.${harness}`;
    if (!(AGENT_HARNESSES as readonly string[]).includes(harness)) throw new ConfigError(`${w}: harness must be one of ${AGENT_HARNESSES.join(', ')}`);
    const t = table(raw, w);
    only(t, ['command', 'args'], `${w}.`);
    const def = DEFAULT_AGENTS[harness as keyof typeof DEFAULT_AGENTS];
    const command = strings(t.command, `${w}.command`) ?? def.command;
    if (command.length === 0 || command[0] === '') throw new ConfigError(`${w}.command must not be empty`);
    agents[harness] = { command, args: strings(t.args, `${w}.args`) ?? def.args };
  }

  const config: Config = {
    workspace_root: root,
    max_jobs: num(doc.max_jobs, 'max_jobs', (n) => Number.isInteger(n) && n >= 1, 'a positive integer') ?? 1,
    tick_seconds: num(doc.tick_seconds, 'tick_seconds', (n) => n >= 1, 'a number >= 1') ?? 60,
    subscriptions,
    models,
    agents,
  };
  if (repo !== undefined) config.repo = repo;
  return config;
}

const tomlArray = (xs: string[]) => `[${xs.map((x) => JSON.stringify(x)).join(', ')}]`;

/**
 * The config air writes on first run (`ensureConfig`): the requests repo, a subscription per login it found
 * (`subscriptions`, named as in subscriptions.json, each with its per-window budget), and both harnesses' model
 * tiers and unattended agent commands. Every value is spelled out, so the file shows what air runs. See
 * docs/config.md.
 */
export function configTemplate(repo: string | undefined, subscriptions: { name: string; harness: string; windowUsd: number }[]): string {
  const agent = (h: keyof typeof DEFAULT_AGENTS) => `command = ${tomlArray(DEFAULT_AGENTS[h].command)}\nargs = ${tomlArray(DEFAULT_AGENTS[h].args)}`;
  const key = (name: string) => (/^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name));
  const subs = subscriptions.map((s) => `[subscriptions.${key(s.name)}]\nharness = "${s.harness}"\nwindow_usd = ${s.windowUsd}\nreserve = ${DEFAULT_RESERVE}      # share of each window kept for yourself\n`);
  return `# air's config, written by its first run; docs/config.md explains each key.
${repo ? `repo = "${repo}"` : '# repo = "OWNER/NAME"   # the requests repo (or pass --repo)'}
workspace_root = "~/air"   # each job gets a fresh directory under it
max_jobs = 1               # jobs running at once
tick_seconds = 60          # how often air serve polls; a job's time limit is its request's \`timeout\`

# One table per login air serves, named as in subscriptions.json. Budgets are US dollars at API prices.
# window_usd is what air counts a login's whole weekly window as worth: it sets how big a share of the week a
# request's effort is (S is $3). A Max plan's week is worth hundreds of dollars to over a thousand; a Pro or
# Plus plan's far less. reserve is the share you keep: air takes no new work past (1 - reserve) of the
# window used. Each job's final comment gives its cost and the share of the window it used, to check
# window_usd against. air serve rereads this file every tick.
${subs.length ? subs.join('\n') : '# (no subscription found when this was written)\n'}
# Request tier -> model. A request never runs below its tier.
[models.claude]
small = "haiku"
medium = "sonnet"
large = "opus"

[models.codex]
small = "gpt-6-luna"
medium = "gpt-6.1-sol"
large = "gpt-6-astra"

# How air starts each agent: air adds the session, model and prompt; \`args\` is what lets it run unattended.
# Claude Code in auto mode: a classifier approves safe actions and blocks risky ones, without asking.
[agents.claude]
${agent('claude')}

# Codex never asks for approval; commands run in its workspace-write sandbox, with network access.
[agents.codex]
${agent('codex')}
`;
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
