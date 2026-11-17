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

test('config init writes the template once, and never over an existing file', async () => {
  const path = join(tmp(), 'air', 'config.toml');
  configDeps.path = () => path;
  assert.deepEqual(await call('config', 'init', '--repo', 'acme/requests'), {
    code: 0, out: `wrote ${path}\nnext: \`air doctor\` checks that each agent can run unattended\n`, err: '',
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
