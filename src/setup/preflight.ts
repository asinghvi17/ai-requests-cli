// The startup checks `air serve` runs and `air doctor` reports: the GitHub CLI's login, the config file,
// workspace_root, air on PATH, git (here), tmux (`checkTmux` in tmux.ts), and the agents (below).
//
// Can each configured agent run unattended? `air serve` checks at startup, offers the folder trust fix on a
// terminal, and refuses new work for any login that still fails. Checks: the binary runs and reports a
// version; its launch args carry an unattended mode (Claude Code `--permission-mode auto`, Codex
// `--ask-for-approval never`, or either one's bypass); Claude Code finished first-run onboarding and trusts `workspace_root`
// through a folder it inherits from. Codex trust needs no check: each launch trusts its job dir with a config
// override (`codexTrust` in agents/harness.ts). Agent state is read from the agents' own files (`.claude.json`,
// `settings.json`), reading only the keys named here; credential files are never opened, and nothing read is
// printed.
import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { AGENT_HARNESSES, DEFAULT_AGENTS, loadConfig, type Config } from './config.ts';
import type { Agent, SubscriptionConfig } from '../agents/index.ts';
import { hostOs, installHint, resolveBinary, type Os } from './hints.ts';

export type Harness = (typeof AGENT_HARNESSES)[number];

export interface Problem {
  /** What is wrong, in one sentence. */
  what: string;
  /** The exact command or setting that fixes it by hand. */
  fix: string;
  /**
   * Folder trust `air serve` can write, after asking: Claude Code's state file, and the folder to trust in it.
   * The report offers `air serve` in a terminal before `fix`, except when `air serve` is about to ask.
   */
  trust?: { stateFile: string; dir: string };
}

/** One local login an agent can run on: a subscription and the agent config dir it selects. */
export interface Login {
  name: string;
  harness: Harness;
  /** Claude Code's CLAUDE_CONFIG_DIR, when the login sets one. */
  configDir?: string;
  /** Codex's CODEX_HOME, when the login sets one. */
  codexHome?: string;
}

export interface AgentCheck {
  harness: Harness;
  /** First line of `<command> --version`, when it ran. */
  version?: string;
  /** Problems that stop every login of this harness: binary, version, launch args. */
  problems: Problem[];
  /** Per login (subscription name): problems with that login's agent state. */
  logins: Record<string, Problem[]>;
}

export interface PreflightDeps {
  home: string;
  /** The server's environment: PATH, and CLAUDE_CONFIG_DIR / CODEX_HOME, which jobs inherit. */
  env: Record<string, string | undefined>;
  /** air's config file, named in fixes. */
  configFile: string;
  /** Picks the install command a fix gives. */
  os: Os;
  /** Runs `argv` (a `--version` call) and returns its exit status and output. */
  run(argv: string[], env: Record<string, string | undefined>): { status: number | null; stdout: string; error?: string };
  readFile(path: string): string | undefined;
}

export const defaultPreflightDeps = (configFile: string): PreflightDeps => ({
  home: process.env.HOME ?? '',
  env: process.env,
  configFile,
  os: hostOs(),
  run(argv, env) {
    const r = spawnSync(argv[0]!, argv.slice(1), { env: env as NodeJS.ProcessEnv, encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'ignore'] });
    return { status: r.status, stdout: r.stdout ?? '', ...(r.error ? { error: r.error.message } : {}) };
  },
  readFile(path) {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return undefined;
    }
  },
});

/**
 * The logins `air serve` may run agents on: claude and codex subscriptions, and manual ones by the harness
 * config.toml gives them, each with its agent's config dir. `agentEnv` starts agents with these dirs.
 */
export function loginsOf(subs: SubscriptionConfig[], config: Config): Login[] {
  const out: Login[] = [];
  for (const s of subs) {
    const harness = s.harness === 'manual' ? config.subscriptions[s.name]?.harness : s.harness;
    if (!(AGENT_HARNESSES as readonly string[]).includes(harness ?? '')) continue;
    const login: Login = { name: s.name, harness: harness as Harness };
    const dirs = s as { configDir?: string; codexHome?: string };
    if (harness === 'claude' && dirs.configDir) login.configDir = dirs.configDir;
    if (harness === 'codex' && dirs.codexHome) login.codexHome = dirs.codexHome;
    out.push(login);
  }
  return out;
}

export type GhState = 'ok' | 'logged-out' | 'missing';

/** Whether the GitHub CLI is installed and logged in (`gh auth status`). */
export function ghState(): GhState {
  const r = spawnSync('gh', ['auth', 'status'], { stdio: 'ignore' });
  return r.error ? 'missing' : r.status === 0 ? 'ok' : 'logged-out';
}

/** `git --version`, or undefined when git can't be run. */
export function gitVersion(): string | undefined {
  const r = spawnSync('git', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return r.status === 0 ? r.stdout.trim() : undefined;
}

export type ConfigState =
  | { state: 'missing' }
  | { state: 'invalid'; error: string }
  | { state: 'no-repo' | 'ok'; config: Config };

/** air's config file at `path`: there, valid, and naming the requests repo. */
export function configState(path: string, home?: string): ConfigState {
  if (!existsSync(path)) return { state: 'missing' };
  let config: Config;
  try {
    config = loadConfig(path, home);
  } catch (e) {
    return { state: 'invalid', error: (e as Error).message };
  }
  return { state: config.repo === undefined ? 'no-repo' : 'ok', config };
}

/**
 * Why air can't make job dirs in workspace_root `root`, or undefined. It need not exist yet (air creates it),
 * but then its nearest existing parent must be a directory air can write.
 */
export function workspaceRootProblem(root: string, configFile: string): Problem | undefined {
  let d = root;
  while (!existsSync(d) && dirname(d) !== d) d = dirname(d);
  const what = d === root ? `workspace_root ${root}` : `${d}, where air would create workspace_root ${root},`;
  const fix = `set workspace_root in ${configFile} to a folder you can write`;
  if (!statSync(d).isDirectory()) return { what: `${what} is not a directory.`, fix };
  try {
    accessSync(d, constants.W_OK | constants.X_OK);
  } catch {
    return { what: `${what} is not writable.`, fix };
  }
  return undefined;
}

/**
 * Whether the `air` a shell finds on `env.PATH` is `self` (this air's executable): 'other' when PATH finds a
 * different one first, 'missing' when it finds none.
 */
export function airOnPath(self: string, env: Record<string, string | undefined>, home: string): 'ok' | 'other' | 'missing' {
  const found = resolveBinary('air', env, home);
  if (!found) return 'missing';
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  return real(found) === real(self) ? 'ok' : 'other';
}

const sh = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
const tomlArray = (xs: string[]) => `[${xs.map((x) => JSON.stringify(x)).join(', ')}]`;

/** The value of `--flag VALUE` or `--flag=VALUE` (any of `names`) in `args`, last one wins. */
function flagValue(args: string[], names: string[]): string | undefined {
  let v: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (names.includes(a)) v = args[i + 1];
    else for (const n of names) if (n.startsWith('--') && a.startsWith(`${n}=`)) v = a.slice(n.length + 1);
  }
  return v;
}

/** The unattended mode `agent` launches in, or undefined if it would ask a person. */
export function unattendedMode(harness: Harness, agent: Agent): 'auto' | 'bypass' | 'never' | undefined {
  const args = [...agent.command.slice(1), ...agent.args];
  if (harness === 'claude') {
    const mode = flagValue(args, ['--permission-mode']);
    return mode === 'auto' ? 'auto' : mode === 'bypassPermissions' ? 'bypass' : undefined;
  }
  if (args.includes('--dangerously-bypass-approvals-and-sandbox')) return 'bypass';
  return flagValue(args, ['--ask-for-approval', '-a']) === 'never' ? 'never' : undefined;
}

function json(text: string | undefined): Record<string, unknown> | undefined | 'invalid' {
  if (text === undefined) return undefined;
  try {
    const v: unknown = JSON.parse(text);
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : 'invalid';
  } catch {
    return 'invalid';
  }
}

/** Whether `dir` is `base` or inside it. */
function within(dir: string, base: string): boolean {
  return dir === base || dir.startsWith(base.endsWith('/') ? base : `${base}/`);
}

/**
 * `path` as Claude Code will see it once it exists: its nearest existing ancestor with symlinks resolved, and
 * the missing rest joined back on. Claude Code keys trust on real paths, and a symlink can lead into a git repo.
 */
export function canonicalPath(path: string): string {
  const abs = resolve(path);
  let d = abs;
  while (!existsSync(d) && dirname(d) !== d) d = dirname(d);
  return join(realpathSync(d), relative(d, abs));
}

/** The git work tree `dir` (or its nearest existing ancestor) lies in, if any. */
export function gitRootOf(dir: string): string | undefined {
  let d = dir;
  while (!existsSync(d) && dirname(d) !== d) d = dirname(d);
  for (;;) {
    if (existsSync(join(d, '.git'))) return d;
    if (dirname(d) === d) return undefined;
    d = dirname(d);
  }
}

function claudeChecks(login: Login, mode: 'auto' | 'bypass', config: Config, deps: PreflightDeps): Problem[] {
  const dir = login.configDir ?? deps.env.CLAUDE_CONFIG_DIR;
  const stateFile = dir ? join(dir, '.claude.json') : join(deps.home, '.claude.json');
  const settingsFile = dir ? join(dir, 'settings.json') : join(deps.home, '.claude', 'settings.json');
  const root = config.workspace_root;
  const prefix = dir ? `CLAUDE_CONFIG_DIR=${sh(dir)} ` : '';
  const startThere = `mkdir -p ${sh(root)} && cd ${sh(root)} && ${prefix}claude`;
  const problems: Problem[] = [];
  const state = json(deps.readFile(stateFile));
  if (state === undefined || state === 'invalid') {
    return [{
      what: state === undefined ? `Claude Code has not been set up with this config: ${stateFile} does not exist.` : `${stateFile} is not valid JSON.`,
      fix: `run \`${startThere}\`, finish the first-run screens and log in, answer "Yes, I trust this folder", then /exit`,
    }];
  }
  if (state.hasCompletedOnboarding !== true) {
    problems.push({
      what: `Claude Code's first-run onboarding is not finished (${stateFile}: hasCompletedOnboarding is not true), so it would wait on its setup screens.`,
      fix: `run \`${startThere}\`, finish the first-run screens and log in, answer "Yes, I trust this folder", then /exit`,
    });
  }
  // Claude Code looks for a trusted folder from the job dir upwards, but not above the git repo the job dir is in.
  const real = canonicalPath(root);
  const repo = gitRootOf(real);
  const projects = state.projects !== null && typeof state.projects === 'object' ? (state.projects as Record<string, unknown>) : {};
  const trustedAbove = Object.entries(projects).filter(([path, p]) => isAbsolute(path) && within(real, path) &&
    p !== null && typeof p === 'object' && (p as Record<string, unknown>).hasTrustDialogAccepted === true).map(([path]) => path);
  if (!trustedAbove.some((path) => !repo || within(path, repo))) {
    const outside = repo ? trustedAbove.find((path) => !within(path, repo)) : undefined;
    problems.push({
      what: outside
        ? `workspace_root ${root} is inside the git repo ${repo}, and Claude Code does not carry the trust of ${outside} into a git repo below it, so each job would stop at "Quick safety check: Is this a project you created or one you trust?".`
        : `Claude Code does not trust workspace_root ${root} (nor a folder above it), so each job would stop at "Quick safety check: Is this a project you created or one you trust?".`,
      fix: `run \`${startThere}\`, answer "Yes, I trust this folder", then /exit (folders below it inherit the trust)`,
      trust: { stateFile, dir: real },
    });
  }
  if (mode === 'bypass') {
    const settings = json(deps.readFile(settingsFile));
    if (settings === undefined || settings === 'invalid' || settings.skipDangerousModePermissionPrompt !== true) {
      problems.push({
        what: `Claude Code would stop at "WARNING: Claude Code running in Bypass Permissions mode": it was never accepted with this config (${settingsFile}: skipDangerousModePermissionPrompt is not true).`,
        fix: `run \`${startThere} --permission-mode bypassPermissions\` and choose "Yes, I accept", or use auto mode: args = ${tomlArray(DEFAULT_AGENTS.claude.args)} under [agents.claude] in ${deps.configFile}`,
      });
    }
  }
  return problems;
}

/** Checks every harness that has a login. */
export function preflight(config: Config, logins: Login[], deps: PreflightDeps): AgentCheck[] {
  const out: AgentCheck[] = [];
  for (const harness of AGENT_HARNESSES) {
    const mine = logins.filter((l) => l.harness === harness);
    if (!mine.length) continue;
    const agent = config.agents[harness] ?? DEFAULT_AGENTS[harness];
    const check: AgentCheck = { harness, problems: [], logins: Object.fromEntries(mine.map((l) => [l.name, []])) };
    out.push(check);
    const bin = resolveBinary(agent.command[0]!, deps.env, deps.home);
    if (!bin) {
      check.problems.push({
        what: `\`${agent.command[0]}\` was not found${agent.command[0]!.includes('/') ? '' : ' on PATH'} (or is not executable).`,
        fix: `${installHint(harness, deps.os)}\nor set command = ${tomlArray(['/path/to/' + harness])} under [agents.${harness}] in ${deps.configFile}`,
      });
      continue;
    }
    const r = deps.run([bin, ...agent.command.slice(1), '--version'], deps.env);
    const first = r.stdout.trim().split('\n')[0]?.trim() ?? '';
    if (r.status !== 0 || !/\d+\.\d+/.test(first)) {
      check.problems.push({
        what: `\`${[bin, ...agent.command.slice(1), '--version'].join(' ')}\` did not report a version (${r.error ?? `exit ${r.status}`}).`,
        fix: `run that command by hand to see why; if it fails, reinstall ${harness}:\n${installHint(harness, deps.os)}`,
      });
      continue;
    }
    check.version = first;
    const mode = unattendedMode(harness, agent);
    if (!mode) {
      check.problems.push({
        what: `[agents.${harness}] launches ${harness} without an unattended mode (args = ${tomlArray(agent.args)}), so it would stop at its first ${harness === 'claude' ? 'permission' : 'approval'} prompt.`,
        fix: `set args = ${tomlArray(DEFAULT_AGENTS[harness].args)} under [agents.${harness}] in ${deps.configFile}`,
      });
      continue;
    }
    if (harness === 'claude') for (const login of mine) check.logins[login.name] = claudeChecks(login, mode as 'auto' | 'bypass', config, deps);
  }
  return out;
}

/** Login name -> why `air serve` won't run new work on it. */
export function refusals(checks: AgentCheck[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of checks) {
    for (const [name, problems] of Object.entries(c.logins)) {
      const first = c.problems[0] ?? problems[0];
      if (first) out[name] = `${c.harness} can't run unattended: ${first.what}`;
    }
  }
  return out;
}

/** `p`'s fix as printed; `fixing` when `air serve` is about to offer the trust fixes itself. */
export function fixOf(p: Problem, fixing = false): string {
  return p.trust && !fixing ? `run \`air serve\` in a terminal, or ${p.fix}` : p.fix;
}

/** The report `air serve` prints at startup; `fixing` when it is about to offer the trust fixes. */
export function formatPreflight(checks: AgentCheck[], fixing = false): string {
  if (!checks.length) return 'no claude or codex logins to serve: config.toml has no [subscriptions.NAME] for one (docs/config.md)\n';
  const lines: string[] = [];
  const problem = (p: Problem) => {
    lines.push(`    problem: ${p.what}`);
    const [head, ...rest] = fixOf(p, fixing).split('\n');
    lines.push(`    fix:     ${head}`, ...rest.map((l) => `             ${l}`));
  };
  for (const c of checks) {
    const names = Object.keys(c.logins);
    const bad = c.problems.length > 0 || names.some((n) => c.logins[n]!.length > 0);
    lines.push(`${c.harness}: ${c.version ?? 'version unknown'}: ${bad ? 'NOT READY' : 'ready'} (login${names.length === 1 ? '' : 's'} ${names.join(', ')})`);
    for (const p of c.problems) problem(p);
    if (c.problems.length) continue;
    for (const n of names) {
      const ps = c.logins[n]!;
      if (!ps.length) continue;
      if (names.length > 1) lines.push(`  login ${n}:`);
      for (const p of ps) problem(p);
    }
  }
  return `${lines.join('\n')}\n`;
}
