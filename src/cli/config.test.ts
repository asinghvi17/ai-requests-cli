// `air config init` and `air doctor` through the router.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configTemplate, parseConfig } from '../config.ts';
import { configDeps } from './config.ts';
import type { AgentCheck } from '../serve/preflight.ts';
import { jobDeps } from './jobs.ts';
import { main } from './main.ts';

const dirs: string[] = [];
const saved = { config: { ...configDeps }, jobs: { ...jobDeps } };
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  Object.assign(configDeps, saved.config);
  Object.assign(jobDeps, saved.jobs);
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'air-config-cli-'));
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
  jobDeps.isTTY = () => true;
  jobDeps.prompter = () => ({ ask: async (q) => { asked.push(q); return answers.shift() ?? ''; }, close: () => {} });
  return asked;
}

test('config init writes the template once, and never over an existing file', async () => {
  const path = join(tmp(), 'air', 'config.toml');
  configDeps.path = () => path;
  jobDeps.isTTY = () => false;
  assert.deepEqual(await call('config', 'init', '--repo', 'acme/requests'), {
    code: 0, out: `wrote ${path}\nnext: \`air doctor\` checks that each agent can run unattended (\`air doctor --fix\` also offers to set up folder trust)\n`, err: '',
  });
  assert.equal(readFileSync(path, 'utf8'), configTemplate('acme/requests'));
  writeFileSync(path, 'repo = "mine/kept"\n');
  const again = await call('config', 'init');
  assert.equal(again.code, 1);
  assert.equal(again.err, `air config: ${path} already exists; edit it, or move it away and run \`air config init\` again\n`);
  assert.equal(readFileSync(path, 'utf8'), 'repo = "mine/kept"\n');
});

test('config init --print prints the template; usage errors exit 2', async () => {
  configDeps.path = () => '/nonexistent/config.toml';
  const r = await call('config', 'init', '--print');
  assert.equal(r.code, 0);
  assert.equal(r.out, configTemplate());
  assert.equal(parseConfig(r.out, '/home/u').agents.claude!.args.join(' '), '--permission-mode auto');
  for (const argv of [['config'], ['config', 'show'], ['config', 'init', 'x'], ['config', 'init', '--repo', 'nope']]) {
    assert.equal((await call(...argv)).code, 2, argv.join(' '));
  }
});

test('doctor prints the preflight and exits 1 when an agent is not ready', async () => {
  jobDeps.loadConfig = () => parseConfig('', '/home/u');
  jobDeps.preflight = (): AgentCheck[] => [
    { harness: 'claude', version: '2.1.311 (Claude Code)', problems: [], logins: { claude: [] } },
    { harness: 'codex', problems: [{ what: '`codex` was not found on PATH (or is not executable).', fix: 'install it' }], logins: { codex: [] } },
  ];
  assert.deepEqual(await call('doctor'), {
    code: 1, err: '',
    out: 'claude: 2.1.311 (Claude Code): ready (login claude)\ncodex: version unknown: NOT READY (login codex)\n    problem: `codex` was not found on PATH (or is not executable).\n    fix:     install it\n',
  });
  jobDeps.preflight = () => [{ harness: 'claude', version: '2.1.311 (Claude Code)', problems: [], logins: { claude: [] } }];
  assert.equal((await call('doctor')).code, 0);
});

const untrusted = (dir: string): AgentCheck[] => [{
  harness: 'claude', version: '2.1.311 (Claude Code)', problems: [],
  logins: {
    claude: [{ what: 'Claude Code does not trust workspace_root.', fix: 'trust it by hand', trust: { stateFile: '/home/u/.claude.json', dir } }],
    // A second login on the same state file: asked once.
    same: [{ what: 'Claude Code does not trust workspace_root.', fix: 'trust it by hand', trust: { stateFile: '/home/u/.claude.json', dir } }],
    max2: [{ what: 'Claude Code does not trust workspace_root.', fix: 'trust it by hand', trust: { stateFile: '/home/u/c2/.claude.json', dir } }],
  },
}];

test('doctor --fix asks before writing each missing folder trust, then checks again; plain doctor writes nothing', async () => {
  jobDeps.loadConfig = () => parseConfig('', '/home/u');
  jobDeps.home = () => '/home/u';
  const written: string[] = [];
  jobDeps.writeClaudeTrust = (file, dir) => { written.push(`${file} ${dir}`); return dir; };
  let fixed = false;
  jobDeps.preflight = () => (fixed ? [{ harness: 'claude', version: '2.1.311 (Claude Code)', problems: [], logins: { claude: [], same: [], max2: [] } }] : untrusted('/home/u/air'));

  const asked = terminal(['y']);
  const plain = await call('doctor');
  assert.equal(plain.code, 1);
  assert.equal(asked.length + written.length, 0);
  assert.match(plain.out, /\n {4}fix: {5}run `air doctor --fix`, or trust it by hand\n/);

  jobDeps.isTTY = () => false;
  const r = await call('doctor', '--fix');
  assert.equal(r.code, 1);
  assert.equal(r.err, 'air doctor: --fix asks before each change: run it in a terminal\n');
  assert.equal(written.length, 0);

  const questions = terminal(['n', 'yes']);
  jobDeps.writeClaudeTrust = (file, dir) => { written.push(`${file} ${dir}`); fixed = true; return dir; };
  const out = await call('doctor', '--fix');
  assert.deepEqual(questions, [
    'Trust ~/air for Claude Code (logins claude, same, ~/.claude.json)? [y/N] ',
    'Trust ~/air for Claude Code (login max2, ~/c2/.claude.json)? [y/N] ',
  ]);
  assert.deepEqual(written, ['/home/u/c2/.claude.json /home/u/air']);
  assert.equal(out.code, 0);
  // Already running --fix, the hint before each question is the manual way only.
  assert.match(out.out, /\n {4}fix: {5}trust it by hand\n/);
  assert.doesNotMatch(out.out, /air doctor --fix/);
  assert.match(out.out, /NOT READY[^]*wrote projects\["\/home\/u\/air"\]\.hasTrustDialogAccepted = true in \/home\/u\/c2\/\.claude\.json\n\nclaude: 2\.1\.311 \(Claude Code\): ready \(logins claude, same, max2\)\n$/);

  // A write that fails (say, Claude Code kept rewriting the file) is reported as doctor's error.
  fixed = false;
  terminal(['y']);
  jobDeps.writeClaudeTrust = () => { throw new Error('/home/u/.claude.json kept changing while air wrote it: close Claude Code, then run `air doctor --fix` again'); };
  const failed = await call('doctor', '--fix');
  assert.equal(failed.code, 1);
  assert.equal(failed.err, 'air doctor: /home/u/.claude.json kept changing while air wrote it: close Claude Code, then run `air doctor --fix` again\n');

  // Nothing to write: no question, and a note only when something else is wrong.
  const none = terminal([]);
  jobDeps.preflight = () => [{ harness: 'codex', problems: [{ what: '`codex` was not found on PATH (or is not executable).', fix: 'install it' }], logins: { codex: [] } }];
  assert.match((await call('doctor', '--fix')).out, /\n--fix: no folder trust is missing; the problems above need the fixes they name\n$/);
  assert.deepEqual(none, []);
});

test('config init offers doctor --fix on a terminal', async () => {
  jobDeps.loadConfig = () => parseConfig('', '/home/u');
  jobDeps.home = () => '/home/u';
  const written: string[] = [];
  jobDeps.writeClaudeTrust = (file, dir) => { written.push(`${file} ${dir}`); return dir; };
  jobDeps.preflight = () => untrusted('/home/u/air').map((c) => ({ ...c, logins: { claude: c.logins.claude! } }));
  const path = join(tmp(), 'config.toml');
  configDeps.path = () => path;
  const asked = terminal(['', 'y']);
  const r = await call('config', 'init');
  assert.deepEqual(asked, ['Check that each agent can run unattended, and fix folder trust (`air doctor --fix`)? [Y/n] ', 'Trust ~/air for Claude Code? [y/N] ']);
  assert.deepEqual(written, ['/home/u/.claude.json /home/u/air']);
  assert.match(r.out, new RegExp(`^wrote ${path}; set \`repo\` in it\nclaude: `));

  rmSync(path);
  const declined = terminal(['n']);
  assert.deepEqual(await call('config', 'init'), { code: 0, err: '', out: `wrote ${path}; set \`repo\` in it\nnext: \`air doctor --fix\` checks that each agent can run unattended\n` });
  assert.equal(declined.length, 1);
});
