// First run, for `air serve` and `air skill install`: what used to be set up by hand. `ensureGh` checks the
// GitHub CLI's login, `ensureConfig` writes ~/.config/air/config.toml (asking for the requests repo, finding
// the subscriptions itself and asking each one's per-window budget), and `fixTrust` offers each Claude Code folder trust the preflight
// found missing. Trust is never written without a yes.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { ConfigError, configPath, configTemplate, DEFAULT_AGENTS, DEFAULT_RESERVE, DEFAULT_WINDOW_USD } from '../config.ts';
import { hostOs, installHint, resolveBinary, type Os } from '../serve/hints.ts';
import { configState, ghState, type AgentCheck, type GhState } from '../serve/preflight.ts';
import { configFile as subscriptionsFile, loadConfig as loadSubscriptions, readAll, writeClaudeTrust } from '../agents/index.ts';
import type { Io } from '../lib/index.ts';
import { CommandError } from './requests.ts';

/** A claude or codex login, and whether air found a subscription on it it can serve. */
export type Detected = { name: string; harness: 'claude' | 'codex'; found: boolean; why?: string };

/** Injectable for tests. */
export const firstRunDeps = {
  configPath: (): string => configPath(),
  isTTY: (): boolean => Boolean(process.stdin.isTTY),
  /** Opens a prompt session on the terminal; prompts go to stderr so stdout stays clean. */
  prompter: (): { ask: (question: string) => Promise<string>; close: () => void } => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    return { ask: (q) => rl.question(q), close: () => rl.close() };
  },
  gh: (): GhState => ghState(),
  os: (): Os => hostOs(),
  ghLogin: (): number => spawnSync('gh', ['auth', 'login'], { stdio: 'inherit' }).status ?? 1,
  detect: (): Promise<Detected[]> => detectSubscriptions(),
  home: (): string => homedir(),
  writeClaudeTrust: (stateFile: string, dir: string): string => writeClaudeTrust(stateFile, dir),
};

const REPO = /^[\w.-]+\/[\w.-]+$/;

/** The claude and codex logins (subscriptions.json, else the default two): installed, and usage readable. */
async function detectSubscriptions(): Promise<Detected[]> {
  const logins = loadSubscriptions(subscriptionsFile()).filter((s) => s.harness !== 'manual');
  const installed = logins.filter((s) => resolveBinary(s.bin ?? DEFAULT_AGENTS[s.harness].command[0]!, process.env, firstRunDeps.home()));
  const readings = await readAll(installed, { refresh: true });
  return logins.map((s) => {
    const harness = s.harness;
    const r = readings.find((x) => x.name === s.name);
    if (!r) return { name: s.name, harness, found: false, why: 'not installed' };
    if (r.stale || !r.windows.length) return { name: s.name, harness, found: false, why: `no subscription usage air can read${r.note ? `: ${r.note}` : ''}` };
    return { name: s.name, harness, found: true };
  });
}

/** Asks `question` once on a terminal. */
async function ask(question: string): Promise<string> {
  const p = firstRunDeps.prompter();
  try {
    return (await p.ask(question)).trim();
  } finally {
    p.close();
  }
}

/** True when the GitHub CLI is logged in; on a terminal (`interactive`), offers `gh auth login` first. */
export async function ensureGh(io: Io, interactive: boolean): Promise<boolean> {
  let state = firstRunDeps.gh();
  if (state === 'missing') {
    io.err(`air needs the GitHub CLI. Install it, then run this again:\n  ${installHint('gh', firstRunDeps.os()).replace(/\n/g, '\n  ')}\n`);
    return false;
  }
  if (state === 'logged-out' && interactive && !/^n(o)?$/i.test(await ask('The GitHub CLI is not logged in. Run `gh auth login` now? [Y/n] '))) {
    firstRunDeps.ghLogin();
    state = firstRunDeps.gh();
  }
  if (state === 'ok') return true;
  io.err('air needs the GitHub CLI logged in: run `gh auth login`, then run this again\n');
  return false;
}

async function askRepo(): Promise<string> {
  for (let i = 0; i < 3; i++) {
    const repo = await ask('Requests repo, where your team files AI requests (OWNER/NAME): ');
    if (REPO.test(repo)) return repo;
  }
  throw new CommandError('no requests repo given: pass --repo OWNER/NAME');
}

/** What first run says before it asks each login's `window_usd`. */
export const BUDGET_HELP = `What is a whole weekly window of each login worth, in US dollars at API prices? air weighs each request's
effort, priced in the same dollars, against it. A Max plan's week is worth hundreds of dollars to over a thousand;
a Pro or Plus plan's far less. air suggests $${DEFAULT_WINDOW_USD} (Enter takes it), and keeps ${DEFAULT_RESERVE * 100}% of each window for you
whatever you answer. Each job's final comment shows its cost and the share of the window it used, to check this
by; change window_usd in config.toml any time, and a running air serve picks it up.
`;

async function askBudget(d: Detected): Promise<number> {
  for (let i = 0; i < 3; i++) {
    const answer = (await ask(`Per-window budget (window_usd) for ${d.name} (${d.harness}) [${DEFAULT_WINDOW_USD}]: `)).replace(/^\$/, '');
    if (answer === '') return DEFAULT_WINDOW_USD;
    const usd = Number(answer);
    if (Number.isFinite(usd) && usd > 0) return usd;
  }
  throw new CommandError('no per-window budget given: answer with a positive number of US dollars');
}

/**
 * Makes sure the config file exists and names the requests repo: `repo` (a --repo flag), else asked for when
 * `interactive`, else an error saying to pass --repo. A missing file is written with it and one subscription
 * per login air finds, each with its per-window budget (asked for when `interactive`, else
 * DEFAULT_WINDOW_USD); an existing file without a repo gets it added at the top. A repo already in the file
 * is never changed.
 */
export async function ensureConfig(io: Io, repo: string | undefined, interactive: boolean): Promise<void> {
  const path = firstRunDeps.configPath();
  const c = configState(path);
  if (c.state === 'ok') return;
  if (c.state === 'invalid') throw new ConfigError(c.error);
  const text = c.state === 'no-repo' ? readFileSync(path, 'utf8') : undefined;
  if (repo === undefined && !interactive) throw new CommandError(`no requests repo in ${path}, and no terminal to ask on: pass --repo OWNER/NAME`);
  repo ??= await askRepo();
  if (text !== undefined) {
    writeFileSync(path, `repo = "${repo}"\n${text}`);
    io.out(`set repo = "${repo}" in ${path}\n`);
    return;
  }
  io.out('looking for Claude Code and Codex subscriptions...\n');
  const detected = await firstRunDeps.detect();
  for (const d of detected) io.out(`  ${d.name} (${d.harness}): ${d.found ? 'found a subscription' : `${d.why}; not serving it`}\n`);
  const found = detected.filter((x) => x.found);
  if (interactive && found.length) io.out(`\n${BUDGET_HELP}`);
  const subs = [];
  for (const d of found) subs.push({ ...d, windowUsd: interactive ? await askBudget(d) : DEFAULT_WINDOW_USD });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, configTemplate(repo, subs), { flag: 'wx' });
  io.out(`wrote ${path}\n`);
}

/** Asks before writing each folder trust `checks` found missing; true if it wrote any. Needs a terminal. */
export async function fixTrust(io: Io, checks: AgentCheck[]): Promise<boolean> {
  // One question per state file and folder, naming the logins that share it when there are several.
  const fixes = new Map<string, { stateFile: string; dir: string; logins: string[] }>();
  let many = false;
  for (const c of checks) {
    many ||= Object.keys(c.logins).length > 1;
    for (const [login, problems] of Object.entries(c.logins)) {
      for (const { trust } of problems) {
        if (!trust) continue;
        const key = `${trust.stateFile}\0${trust.dir}`;
        if (!fixes.has(key)) fixes.set(key, { ...trust, logins: [] });
        fixes.get(key)!.logins.push(login);
      }
    }
  }
  if (!fixes.size) return false;
  const home = firstRunDeps.home();
  const tilde = (p: string) => (home && (p === home || p.startsWith(`${home}/`)) ? `~${p.slice(home.length)}` : p);
  let wrote = false;
  for (const f of fixes.values()) {
    const answer = await ask(`Trust ${tilde(f.dir)} for Claude Code${many ? ` (login${f.logins.length > 1 ? 's' : ''} ${f.logins.join(', ')}, ${tilde(f.stateFile)})` : ''}? [y/N] `);
    if (!/^y(es)?$/i.test(answer)) continue;
    let key: string;
    try {
      key = firstRunDeps.writeClaudeTrust(f.stateFile, f.dir);
    } catch (e) {
      throw new CommandError((e as Error).message);
    }
    io.out(`wrote projects[${JSON.stringify(key)}].hasTrustDialogAccepted = true in ${f.stateFile}\n`);
    wrote = true;
  }
  return wrote;
}
