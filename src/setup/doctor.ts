// The checks `air doctor` reports: the startup checks `air serve` runs (preflight.ts), and what only an
// installation check needs (the platform, git, `air` on PATH, each login's usage read past air's cache).
// `!` marks a problem that does not stop air: an agent that is broken while another login is ready, or an
// `air` on PATH that is a different copy. The command and its output are cli/doctor.ts.
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Reading, SubscriptionConfig } from '../agents/index.ts';
import { parseConfig, type Config } from './config.ts';
import { installHint, LOGIN_HINT, OS_NAMES, type Os } from './hints.ts';
import { airOnPath, configState, fixOf, loginsOf, workspaceRootProblem, type AgentCheck, type GhState, type Login } from './preflight.ts';

export type Mark = 'ok' | 'warn' | 'fail';
export interface Line {
  mark: Mark;
  what: string;
  /** The command (or setting) that fixes it; may span lines. */
  fix?: string;
}

/** What the checks read from the machine. */
export interface DoctorDeps {
  platform: () => { platform: string; arch: string };
  os: () => Os;
  env: () => Record<string, string | undefined>;
  home: () => string;
  /** This air's executable: the single binary, or the entry script. */
  self: () => string;
  tmux: () => Promise<string>;
  git: () => string | undefined;
  gh: () => GhState;
  configPath: () => string;
  subscriptions: () => SubscriptionConfig[];
  preflight: (config: Config, logins: Login[], os: Os) => AgentCheck[];
  usage: (sub: Exclude<SubscriptionConfig, { harness: 'manual' }>) => Promise<Reading>;
}

const PLATFORMS: Record<string, string> = { darwin: 'macOS', linux: 'Linux' };

/** The shell startup file a PATH line goes in. */
function rcFile(env: Record<string, string | undefined>): string {
  const shell = env.SHELL ?? '';
  return shell.endsWith('/zsh') ? '~/.zshrc' : shell.endsWith('/bash') ? '~/.bashrc' : '~/.profile';
}

/** Every check, in order. */
export async function doctor(d: DoctorDeps): Promise<Line[]> {
  const lines: Line[] = [];
  const ok = (what: string) => lines.push({ mark: 'ok', what });
  const fail = (what: string, fix: string) => lines.push({ mark: 'fail', what, fix });
  const os = d.os();
  const env = d.env();
  const home = d.home();

  const { platform, arch } = d.platform();
  const system = `${PLATFORMS[platform] ?? platform} ${arch} (${OS_NAMES[os]})`;
  if (PLATFORMS[platform] && (arch === 'arm64' || arch === 'x64')) ok(`system: ${system}`);
  else fail(`system: ${system}: air runs on macOS and Linux, on arm64 or x64`, 'use a supported machine');

  const self = d.self();
  const where = airOnPath(self, env, home);
  if (where === 'ok') ok(`air: ${self}, on PATH`);
  else if (where === 'other') lines.push({ mark: 'warn', what: `air: PATH finds another air before this one (${self}), so \`air\` runs that one`, fix: `remove the other copy (\`command -v air\` names it), or put ${dirname(self)} first on PATH` });
  else {
    const dir = home && dirname(self).startsWith(`${home}/`) ? `$HOME${dirname(self).slice(home.length)}` : dirname(self);
    fail(`air: ${dirname(self)} is not on PATH, so \`air\` is not found`, `echo 'export PATH="${dir}:$PATH"' >> ${rcFile(env)}, then open a new terminal`);
  }

  try {
    ok(`tmux: ${await d.tmux()}`);
  } catch (e) {
    fail((e as Error).message, installHint('tmux', os));
  }

  const git = d.git();
  if (git) ok(`git: ${git}`);
  else fail('git: not found on PATH', installHint('git', os));

  const gh = d.gh();
  if (gh === 'ok') ok('gh: logged in');
  else if (gh === 'missing') fail('gh: the GitHub CLI is not installed', installHint('gh', os));
  else fail('gh: the GitHub CLI is not logged in', LOGIN_HINT.gh);

  const path = d.configPath();
  const c = configState(path, home);
  if (c.state === 'ok') ok(`config: ${path}, requests repo ${c.config.repo}`);
  else if (c.state === 'missing') fail(`config: ${path} does not exist`, 'run `air serve` (or `air skill install`, to only request work) in a terminal: its first run writes it');
  else if (c.state === 'invalid') fail(`config: ${c.error}`, `fix that in ${path} (docs/config.md)`);
  else fail(`config: ${path} names no requests repo`, `add repo = "OWNER/NAME" at the top of ${path}`);
  const config = 'config' in c ? c.config : parseConfig('', home);

  const root = config.workspace_root;
  const rootProblem = workspaceRootProblem(root, path);
  if (rootProblem) fail(rootProblem.what, rootProblem.fix);
  else ok(`workspace_root: ${root}${existsSync(root) ? '' : ' (air creates it)'}`);

  lines.push(...(await agentLines(d, config, c.state === 'ok' || c.state === 'no-repo', path, os)));
  return lines;
}

/**
 * The agents, by harness and login, from the same preflight `air serve` runs, plus whether each login's
 * subscription usage reads. Problems fail when no login is ready, and only warn when one is.
 */
async function agentLines(d: DoctorDeps, config: Config, haveConfig: boolean, path: string, os: Os): Promise<Line[]> {
  let subs: SubscriptionConfig[];
  try {
    subs = d.subscriptions();
  } catch (e) {
    return [{ mark: 'fail', what: (e as Error).message, fix: 'fix that file, or remove it to use the default claude and codex logins (docs/config.md)' }];
  }
  const checks = d.preflight(config, loginsOf(subs, config), os);
  if (!checks.length) return [{ mark: 'fail', what: 'agents: no claude or codex login to serve', fix: 'add one to subscriptions.json, or remove it to use the default claude and codex logins (docs/config.md)' }];
  const lines: (Line & { problem?: true })[] = [];
  let ready = 0;
  for (const c of checks) {
    if (c.problems.length) {
      for (const p of c.problems) lines.push({ mark: 'fail', problem: true, what: `${c.harness}: ${p.what}`, fix: fixOf(p) });
      continue;
    }
    lines.push({ mark: 'ok', what: `${c.harness}: ${c.version}` });
    for (const [name, problems] of Object.entries(c.logins)) {
      const who = `${c.harness} login ${name}`;
      for (const p of problems) lines.push({ mark: 'fail', problem: true, what: `${who}: ${p.what}`, fix: fixOf(p) });
      if (problems.length) continue;
      const sub = subs.find((s) => s.name === name)!;
      if (sub.harness !== 'manual') {
        let r: Reading;
        try {
          r = await d.usage(sub);
        } catch (e) {
          r = { windows: [], note: (e as Error).message };
        }
        if (!r.windows.length) {
          lines.push({ mark: 'fail', problem: true, what: `${who}: no subscription usage air can read${r.note ? ` (${r.note})` : ''}, so air serve can't match work to it`, fix: `log in: ${LOGIN_HINT[sub.harness]}` });
          continue;
        }
      }
      if (haveConfig && !Object.hasOwn(config.subscriptions, name)) {
        lines.push({ mark: 'fail', problem: true, what: `${who}: works, but ${path} has no [subscriptions.${name}], so air serve won't use it`, fix: `add [subscriptions.${name}] with harness = "${sub.harness}" to ${path} (docs/config.md)` });
        continue;
      }
      ready++;
      lines.push({ mark: 'ok', what: `${who}: ready${sub.harness === 'manual' ? ' (manual budget)' : ', subscription usage readable'}` });
    }
  }
  return lines.map(({ problem, ...l }) => (problem && ready ? { ...l, mark: 'warn' } : l));
}
