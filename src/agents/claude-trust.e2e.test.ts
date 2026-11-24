// End to end: the installed Claude Code and Codex, started by air's tmux layer with the argv `air serve` builds,
// in job dirs like the ones setup makes, each with a throwaway config dir and a fake API key. Nothing reaches a
// model: the agents get no prompt, and the test only reads their first screen. Skipped for a CLI (or tmux) that
// is not installed. What it pins down (docs/decisions.md, "Folder trust"):
// - a fresh job dir under a workspace_root trusted by `air serve`, holding a git clone in repo/, never
//   asks to be trusted;
// - Codex asks in a git repo unless told to trust the dir, and `agentArgv` tells it;
// - Claude Code asks when the job dir is itself a git repo, and stuck-prompt detection sees that screen.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { DEFAULT_AGENTS } from '../setup/config.ts';
import { createTmux, socketPath } from '../server/tmux/tmux.ts';
import { leftoverPaneProcesses } from '../server/tmux/testing/leaks.ts';
import { makeBareRepo } from '../lib/git-fixture.ts';
import { agentArgv, type Agent, type Harness } from './harness.ts';
import { matchPrompt } from './prompts.ts';
import { writeClaudeTrust } from './claude-trust.ts';

const has = (cmd: string, arg: string) => spawnSync(cmd, [arg], { stdio: 'ignore' }).status === 0;
const hasTmux = has('tmux', '-V');
const installed: Record<Harness, boolean> = { claude: has('claude', '--version'), codex: has('codex', '--version') };

const base = realpathSync(mkdtempSync(join(tmpdir(), 'air-trust-'))); // real path: both CLIs key trust on it
const socket = `air-trust-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const t = createTmux({ repo: 'o/requests', socket });
after(async () => {
  await t.killServer().catch(() => {});
  rmSync(socketPath(socket), { force: true });
  rmSync(base, { recursive: true, force: true });
  assert.deepEqual(await leftoverPaneProcesses(socket), [], 'pane processes outlived the tmux server');
});

const root = join(base, 'air');
const source = makeBareRepo(join(base, 'source'));
const KEY = 'sk-fake-air-trust-test-0123456789abcdef';
let issue = 0;
let jobs = 0;

/** A new job dir under workspace_root, as setup leaves it: AIR_TASK.md and a clone in repo/o/r. */
function jobDir(opts: { gitRoot?: boolean } = {}): string {
  const dir = join(root, 'o__requests', `${++jobs}-abc`);
  mkdirSync(join(dir, 'repo'), { recursive: true });
  writeFileSync(join(dir, 'AIR_TASK.md'), 'nothing to do\n');
  execFileSync('git', ['clone', '-q', source.bare, join(dir, 'repo', 'o', 'r')], { stdio: 'ignore' });
  if (opts.gitRoot) execFileSync('git', ['init', '-q', dir]); // what an agent's `git init` in the job dir leaves
  return dir;
}

/** The agent's command, in an environment of its own: the throwaway login only, nothing of the caller's. */
function hermetic(harness: Harness, env: Record<string, string>): Agent {
  const vars = { PATH: process.env.PATH ?? '', HOME: join(base, 'home'), TERM: 'xterm-256color', LANG: 'C.UTF-8', ...env };
  return { command: ['env', '-i', ...Object.entries(vars).map(([k, v]) => `${k}=${v}`), harness], args: DEFAULT_AGENTS[harness].args };
}

/** The argv `air serve` starts `harness` with in `dir` (a fresh start: no prompt), so nothing reaches a model. */
function argvFor(harness: Harness, agent: Agent, dir: string): string[] {
  const sessionId = harness === 'claude' ? randomUUID() : undefined;
  return agentArgv({ harness, agent, model: harness === 'claude' ? 'sonnet' : 'gpt-5', sessionId, dir });
}

/** Starts `argv` in `dir` as a job; resolves to the prompt on its first settled screen, if any. */
async function firstPrompt(harness: Harness, argv: string[], dir: string, ready: RegExp): Promise<string | undefined> {
  const n = ++issue;
  await t.startJob({ issue: n, cwd: dir, argv });
  try {
    const end = Date.now() + 45_000;
    for (;;) {
      const screen = (await t.screen(n)) ?? '';
      if (matchPrompt(harness, screen) || ready.test(screen)) {
        // A trust screen comes before the main one, never after: settle, then read once more.
        await sleep(1500);
        return matchPrompt(harness, (await t.screen(n)) ?? '')?.id;
      }
      if (Date.now() > end) throw new Error(`${harness} showed neither its main screen nor a prompt:\n${screen}`);
      await sleep(250);
    }
  } finally {
    await t.stopJob(n, { graceMs: 2000 });
  }
}

describe('folder trust, with the installed agents in tmux', { skip: hasTmux ? false : 'tmux not installed' }, () => {
  mkdirSync(join(base, 'home'), { recursive: true });

  test('Claude Code: a job dir inherits workspace_root\'s trust, clone inside or not; a job dir that is a git repo does not', { skip: installed.claude ? false : 'claude not installed', timeout: 180_000 }, async () => {
    // Onboarded, the API key approved (as a login would be), and workspace_root trusted by `air serve`.
    const config = join(base, 'claude-config');
    mkdirSync(config);
    writeFileSync(join(config, '.claude.json'), JSON.stringify({
      hasCompletedOnboarding: true, theme: 'dark', customApiKeyResponses: { approved: [KEY.slice(-20)], rejected: [] },
    }));
    writeClaudeTrust(join(config, '.claude.json'), root);
    const agent = hermetic('claude', { CLAUDE_CONFIG_DIR: config, ANTHROPIC_API_KEY: KEY, DISABLE_AUTOUPDATER: '1' });
    const ready = /auto mode on/;
    const fresh = jobDir();
    assert.equal(await firstPrompt('claude', argvFor('claude', agent, fresh), fresh, ready), undefined);
    // Claude Code saved the job dir untrusted on the way out; a resume or restart there still inherits.
    assert.equal(await firstPrompt('claude', argvFor('claude', agent, fresh), fresh, ready), undefined);
    // The backstop: the agent made its job dir a git repo before a restart. A git root doesn't inherit trust.
    const repo = jobDir({ gitRoot: true });
    assert.equal(await firstPrompt('claude', argvFor('claude', agent, repo), repo, ready), 'claude-trust');
  });

  test('Codex: air trusts each job dir at launch, which a git repo needs', { skip: installed.codex ? false : 'codex not installed', timeout: 180_000 }, async () => {
    const home = join(base, 'codex-home');
    mkdirSync(home);
    execFileSync('codex', ['login', '--with-api-key'], { input: KEY, env: { ...process.env, CODEX_HOME: home }, stdio: ['pipe', 'ignore', 'ignore'] });
    const agent = hermetic('codex', { CODEX_HOME: home });
    agent.args = [...agent.args, '-c', 'check_for_update_on_startup=false'];
    const ready = /Ask Codex to do anything/;
    const fresh = jobDir();
    assert.equal(await firstPrompt('codex', argvFor('codex', agent, fresh), fresh, ready), undefined);
    const repo = jobDir({ gitRoot: true });
    const argv = argvFor('codex', agent, repo);
    assert.equal(await firstPrompt('codex', argv, repo, ready), undefined);
    // Without air's override the same dir asks: the check above is not vacuous.
    const i = argv.findIndex((a) => a.startsWith('projects='));
    assert.equal(await firstPrompt('codex', argv.filter((_, j) => j !== i - 1 && j !== i), repo, ready), 'codex-trust');
  });
});
