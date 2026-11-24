// `air skill install` through the router: flags, output and exit codes.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { skillFiles } from '../request/skill/install.ts';
import { firstRunDeps } from './firstrun.ts';
import { main } from './main.ts';
import { skillDeps } from './skill.ts';

const dirs: string[] = [];
const saved = { skill: { ...skillDeps }, first: { ...firstRunDeps } };
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  Object.assign(skillDeps, saved.skill);
  Object.assign(firstRunDeps, saved.first);
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'air-skill-cli-'));
  dirs.push(d);
  return d;
}

// A config that names the requests repo, so installing asks nothing (firstrun.test.ts covers first run).
const config = join(tmp(), 'config.toml');
writeFileSync(config, 'repo = "acme/requests"\n');
firstRunDeps.configPath = () => config;
firstRunDeps.isTTY = () => false;

async function call(...argv: string[]) {
  let out = '';
  let err = '';
  const code = await main(argv, { out: (s) => { out += s; }, err: (s) => { err += s; } });
  return { code, out, err };
}

test('installs into the default directory', async () => {
  const dir = join(tmp(), '.claude', 'skills', 'ai-request');
  skillDeps.defaultDir = () => dir;
  assert.deepEqual(await call('skill', 'install'), { code: 0, out: `installed the ai-request skill in ${dir}\n`, err: '' });
  assert.equal(readFileSync(join(dir, 'SKILL.md'), 'utf8'), skillFiles()['SKILL.md']);
});

test('--dir installs there; --print only prints the destination', async () => {
  skillDeps.defaultDir = () => '/nonexistent/default';
  assert.deepEqual(await call('skill', 'install', '--print'), { code: 0, out: '/nonexistent/default\n', err: '' });
  const dir = join(tmp(), 'proj', '.claude', 'skills', 'ai-request');
  assert.deepEqual(await call('skill', 'install', '--dir', dir, '--print'), { code: 0, out: `${dir}\n`, err: '' });
  assert.equal((await call('skill', 'install', '--dir', dir)).code, 0);
  assert.equal(readFileSync(join(dir, 'template.md'), 'utf8'), skillFiles()['template.md']);
  assert.deepEqual(await call('skill', 'install', '--dir', 'rel', '--print'), { code: 0, out: `${resolve('rel')}\n`, err: '' });
});

test('a directory that is not the skill exits 1 and is left alone', async () => {
  const dir = tmp();
  writeFileSync(join(dir, 'notes.txt'), 'keep');
  const r = await call('skill', 'install', '--dir', dir);
  assert.equal(r.code, 1);
  assert.equal(r.err, `air skill: ${dir} exists and is not an ai-request skill; not replacing it\n`);
  assert.equal(readFileSync(join(dir, 'notes.txt'), 'utf8'), 'keep');
});

test('usage errors exit 2', async () => {
  for (const argv of [['skill'], ['skill', 'remove'], ['skill', 'install', 'extra'], ['skill', 'install', '--bogus'], ['skill', 'install', '--dir'], ['skill', 'install', '--dir=']]) {
    const r = await call(...argv);
    assert.equal(r.code, 2, argv.join(' '));
    assert.equal(r.out, '');
    assert.match(r.err, /\nusage: air skill install \[--repo OWNER\/NAME\] \[--dir DIR\] \[--print\]\n$/, argv.join(' '));
  }
});
