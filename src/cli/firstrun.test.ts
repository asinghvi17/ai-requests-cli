// First run through the router: `air serve` on a terminal (gh login, config, folder trust, then tmux) and
// `air skill install` writing the config.
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configTemplate, loadConfig, parseConfig } from '../config.ts';
import type { ServeContext } from '../serve/context.ts';
import type { AgentCheck } from '../serve/preflight.ts';
import { acquireServeLock } from '../serve/state.ts';
import { firstRunDeps } from './firstrun.ts';
import { jobDeps } from './jobs.ts';
import { main } from './main.ts';
import { skillDeps } from './skill.ts';

const dirs: string[] = [];
const saved = { first: { ...firstRunDeps }, jobs: { ...jobDeps }, skill: { ...skillDeps } };
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  Object.assign(firstRunDeps, saved.first);
  Object.assign(jobDeps, saved.jobs);
  Object.assign(skillDeps, saved.skill);
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'air-firstrun-'));
  dirs.push(d);
  return d;
};

async function call(...argv: string[]) {
  let out = '';
  let err = '';
  const code = await main(argv, { out: (s) => { out += s; }, err: (s) => { err += s; } });
  return { code, out, err };
}

/** A terminal that answers with `answers`, in order, recording the questions. */
function terminal(answers: string[]) {
  const asked: string[] = [];
  firstRunDeps.isTTY = () => true;
  firstRunDeps.prompter = () => ({ ask: async (q) => { asked.push(q); return answers.shift() ?? ''; }, close: () => {} });
  return asked;
}

const ready: AgentCheck[] = [{ harness: 'claude', version: '2.1.311 (Claude Code)', problems: [], logins: { claude: [] } }];
const untrusted = (dir: string): AgentCheck[] => [{
  harness: 'claude', version: '2.1.311 (Claude Code)', problems: [],
  logins: {
    claude: [{ what: 'Claude Code does not trust workspace_root.', fix: 'trust it by hand', trust: { stateFile: '/home/u/.claude.json', dir } }],
    // A second login on the same state file: asked once.
    same: [{ what: 'Claude Code does not trust workspace_root.', fix: 'trust it by hand', trust: { stateFile: '/home/u/.claude.json', dir } }],
    max2: [{ what: 'Claude Code does not trust workspace_root.', fix: 'trust it by hand', trust: { stateFile: '/home/u/c2/.claude.json', dir } }],
  },
}];

type Started = { argv: string[]; env: Record<string, string> };
let path: string;
let started: Started[];
let attached: string[][];
let written: string[];

beforeEach(() => {
  path = join(tmp(), 'config.toml');
  started = [];
  attached = [];
  written = [];
  firstRunDeps.configPath = () => path;
  firstRunDeps.gh = () => 'ok';
  firstRunDeps.ghLogin = () => 0;
  firstRunDeps.home = () => '/home/u';
  firstRunDeps.detect = async () => [
    { name: 'claude', harness: 'claude', found: true },
    { name: 'codex', harness: 'codex', found: false, why: 'not installed' },
  ];
  firstRunDeps.writeClaudeTrust = (file, dir) => { written.push(`${file} ${dir}`); return dir; };
  jobDeps.loadConfig = () => loadConfig(path, '/home/u');
  jobDeps.preflight = () => ready;
  jobDeps.stateDir = () => tmp();
  jobDeps.env = () => ({ PATH: '/bin', HOME: '/home/u', TERM: 'xterm-256color', CLAUDECODE: '1', GIT_AUTHOR_NAME: 'Me' });
  jobDeps.self = () => ['/usr/local/bin/air'];
  jobDeps.attach = (argv) => { attached.push(argv); return 0; };
  const tmux = {
    checkVersion: async () => '3.4',
    startServer: async (argv: string[], env: Record<string, string>) => { started.push({ argv, env }); return '@7'; },
    attachArgs: async (w?: number | string) => ['tmux', '-L', 'air', 'attach-session', '-t', String(w ?? '=air')],
  };
  jobDeps.context = (config, repo) => ({ config, tmux, gh: { repo } }) as unknown as ServeContext;
});

test('first `air serve` on a terminal: asks for the repo, writes the config, then starts itself in tmux and attaches', async () => {
  const asked = terminal(['nope', 'acme/requests']);
  const r = await call('serve');
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(asked, ['Requests repo, where your team files AI requests (OWNER/NAME): ', 'Requests repo, where your team files AI requests (OWNER/NAME): ']);
  assert.equal(readFileSync(path, 'utf8'), configTemplate('acme/requests', [{ name: 'claude', harness: 'claude' }]));
  assert.equal(r.out, `looking for Claude Code and Codex subscriptions...\n  claude (claude): found a subscription\n  codex (codex): not installed; not serving it\nwrote ${path}\n`
    + 'air serve runs in tmux: detach with C-b d and it keeps serving; `air serve` again comes back\n');
  assert.match(r.err, /^claude: 2\.1\.311 \(Claude Code\): ready/);
  assert.equal(started.length, 1);
  const { argv, env } = started[0]!;
  assert.deepEqual(argv.slice(0, 2), ['/bin/sh', '-c']);
  assert.deepEqual(argv.slice(3), ['air', '/usr/local/bin/air', 'serve']);
  // The server gets the volunteer's environment, without a parent agent's markers or the outer TERM.
  assert.deepEqual(env, { PATH: '/bin', HOME: '/home/u', GIT_AUTHOR_NAME: 'Me' });
  assert.deepEqual(attached, [['tmux', '-L', 'air', 'attach-session', '-t', '@7']]);

  // Run again: the config is there, so nothing is asked; the flags go along to the server.
  const again = terminal([]);
  assert.equal((await call('serve', '--manual')).code, 0);
  assert.deepEqual(again, []);
  assert.deepEqual(started[1]!.argv.slice(3), ['air', '/usr/local/bin/air', 'serve', '--manual']);
});

test('`air serve` while a server runs joins it; three bad repos give up', async () => {
  const state = tmp();
  jobDeps.stateDir = () => state;
  writeFileSync(path, 'repo = "acme/requests"\n');
  const unlock = acquireServeLock(state);
  try {
    terminal([]);
    const r = await call('serve');
    assert.deepEqual(r, { code: 0, out: 'air serve is already running; attaching (detach with C-b d)\n', err: '' });
    assert.deepEqual(attached, [['tmux', '-L', 'air', 'attach-session', '-t', '=air']]);
    assert.equal(started.length, 0);
  } finally {
    unlock();
  }
  rmSync(path);
  terminal(['a', 'b', 'c']);
  const bad = await call('serve');
  assert.deepEqual(bad, { code: 1, out: '', err: 'air serve: no requests repo given: pass --repo OWNER/NAME\n' });
});

test('an existing config without a repo gets one; --repo needs no question', async () => {
  writeFileSync(path, 'max_jobs = 2\n');
  const asked = terminal([]);
  assert.equal((await call('serve', '--repo', 'acme/other')).code, 0);
  assert.deepEqual(asked, []);
  assert.equal(readFileSync(path, 'utf8'), 'repo = "acme/other"\nmax_jobs = 2\n');
  // A repo already in the file is never changed.
  assert.equal((await call('serve', '--repo', 'acme/third')).code, 0);
  assert.equal(parseConfig(readFileSync(path, 'utf8')).repo, 'acme/other');
});

test('gh: offers `gh auth login` when logged out; a missing gh stops serve', async () => {
  writeFileSync(path, 'repo = "acme/requests"\n');
  let state: 'ok' | 'logged-out' | 'missing' = 'logged-out';
  let logins = 0;
  firstRunDeps.gh = () => state;
  firstRunDeps.ghLogin = () => { logins++; state = 'ok'; return 0; };
  const asked = terminal(['']);
  assert.equal((await call('serve')).code, 0);
  assert.deepEqual(asked, ['The GitHub CLI is not logged in. Run `gh auth login` now? [Y/n] ']);
  assert.equal(logins, 1);

  state = 'logged-out';
  terminal(['n']);
  assert.deepEqual(await call('serve'), { code: 1, out: '', err: 'air needs the GitHub CLI logged in: run `gh auth login`, then run this again\n' });
  state = 'missing';
  assert.deepEqual(await call('serve'), { code: 1, out: '', err: 'air needs the GitHub CLI: install it from https://cli.github.com, then run this again\n' });
  assert.equal(started.length, 1);
});

test('serve asks before writing each missing folder trust, then checks again', async () => {
  writeFileSync(path, 'repo = "acme/requests"\n');
  let fixed = false;
  jobDeps.preflight = () => (fixed ? [{ ...ready[0]!, logins: { claude: [], same: [], max2: [] } }] : untrusted('/home/u/air'));
  firstRunDeps.writeClaudeTrust = (file, dir) => { written.push(`${file} ${dir}`); fixed = true; return dir; };
  const questions = terminal(['n', 'yes']);
  const r = await call('serve');
  assert.equal(r.code, 0);
  assert.deepEqual(questions, [
    'Trust ~/air for Claude Code (logins claude, same, ~/.claude.json)? [y/N] ',
    'Trust ~/air for Claude Code (login max2, ~/c2/.claude.json)? [y/N] ',
  ]);
  assert.deepEqual(written, ['/home/u/c2/.claude.json /home/u/air']);
  assert.match(r.out, /^wrote projects\["\/home\/u\/air"\]\.hasTrustDialogAccepted = true in \/home\/u\/c2\/\.claude\.json\n/);
  // About to ask, the report gives only the manual way.
  assert.match(r.err, /\n {4}fix: {5}trust it by hand\n/);
  assert.match(r.err, /NOT READY[^]*\n\nclaude: 2\.1\.311 \(Claude Code\): ready \(logins claude, same, max2\)\n$/);

  // A write that fails (say, Claude Code kept rewriting the file) is serve's error.
  fixed = false;
  terminal(['y']);
  firstRunDeps.writeClaudeTrust = () => { throw new Error('/home/u/.claude.json kept changing while air wrote it: close Claude Code, then run `air serve` again'); };
  const failed = await call('serve');
  assert.equal(failed.code, 1);
  assert.match(failed.err, /air serve: \/home\/u\/\.claude\.json kept changing while air wrote it: close Claude Code, then run `air serve` again\n$/);
});

test('skill install writes the config on first run: --repo, or asked on a terminal', async () => {
  const dir = join(tmp(), 'skill');
  skillDeps.defaultDir = () => dir;
  firstRunDeps.isTTY = () => false;
  assert.deepEqual(await call('skill', 'install'), { code: 0, out: `installed the ai-request skill in ${dir}\n`, err: '' });
  assert.throws(() => readFileSync(path));

  const asked = terminal(['acme/requests']);
  const r = await call('skill', 'install');
  assert.equal(r.code, 0);
  assert.equal(asked.length, 1);
  assert.equal(loadConfig(path).repo, 'acme/requests');
  assert.match(r.out, new RegExp(`wrote ${path}\n$`));

  terminal([]);
  rmSync(path);
  firstRunDeps.isTTY = () => false;
  assert.equal((await call('skill', 'install', '--repo', 'acme/x')).code, 0);
  assert.equal(loadConfig(path).repo, 'acme/x');
  assert.equal((await call('skill', 'install', '--repo', 'nope')).code, 2);
});
