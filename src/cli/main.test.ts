import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { COMMANDS, main } from './main.ts';
import { VERSION } from '../version.ts';

async function call(...argv: string[]) {
  let out = '';
  let err = '';
  const code = await main(argv, { out: (s) => { out += s; }, err: (s) => { err += s; } });
  return { code, out, err };
}

test('--version prints the package.json version', async () => {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(VERSION, pkg.version);
  assert.deepEqual(await call('--version'), { code: 0, out: `${VERSION}\n`, err: '' });
});

test('--help lists every command; no args prints help to stderr and fails', async () => {
  const help = await call('--help');
  assert.equal(help.code, 0);
  for (const name of Object.keys(COMMANDS)) assert.match(help.out, new RegExp(`^  ${name}\\b`, 'm'));
  const none = await call();
  assert.equal(none.code, 2);
  assert.equal(none.err, help.out);
});

test('routes the full command set', () => {
  assert.deepEqual(Object.keys(COMMANDS).sort(), [
    'attach', 'claim', 'config', 'doctor', 'fetch', 'lint', 'pause', 'release', 'resume', 'retry', 'run', 'serve', 'setup', 'skill', 'start', 'status', 'stop', 'submit',
    'sweep', 'usage', 'wait',
  ]);
});

test('every command routes through main(): stub exits 2, --help exits 0', async () => {
  for (const [name, cmd] of Object.entries(COMMANDS)) {
    if (cmd.raw) continue; // implemented; parses its own argv (see below)
    if (!cmd.run) {
      const r = await call(name, ...cmd.args.map(() => '1'));
      assert.deepEqual(r, { code: 2, out: '', err: `air ${name}: not implemented yet\n` }, name);
    }
    const help = await call(name, '--help');
    assert.equal(help.code, 0, name);
    assert.equal(help.out, `usage: air ${cmd.usage}\n  ${cmd.summary}\n`);
    const short = await call(name, '-h');
    assert.equal(short.out, help.out, name);
    if (cmd.args.length) assert.equal((await call(name)).code, 2, `${name} without ${cmd.args.join(' ')}`);
  }
});

test('usage is wired to usageCommand and prints its own help', async () => {
  for (const flag of ['--help', '-h']) {
    const r = await call('usage', flag);
    assert.equal(r.code, 0);
    assert.match(r.out, /^usage: air usage \[--refresh\] \[--json\] \[--config FILE\]/);
    assert.match(r.out, /air usage spend NAME AMOUNT[^\n]*\n[^\n]*reset-ledger[^\n]*\n$/);
    assert.equal(r.err, '');
  }
  assert.equal((await call('usage', '--bogus')).code, 2);
});

test('global -h, help and -v', async () => {
  const help = (await call('--help')).out;
  assert.deepEqual(await call('-h'), { code: 0, out: help, err: '' });
  assert.deepEqual(await call('help'), { code: 0, out: help, err: '' });
  assert.deepEqual(await call('-v'), { code: 0, out: `${VERSION}\n`, err: '' });
});

test('names shared with Object.prototype are unknown commands', async () => {
  for (const name of ['toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf']) {
    const r = await call(name);
    assert.equal(r.code, 2, name);
    assert.match(r.err, new RegExp(`^air: unknown command "${name}"`), name);
  }
});

test('usage errors exit 2 with the command usage', async () => {
  assert.equal((await call('frobnicate')).code, 2);
  const missing = await call('stop');
  assert.equal(missing.code, 2);
  assert.match(missing.err, /missing ISSUE\nusage: air stop \[--repo OWNER\/NAME\] ISSUE/);
  const bad = await call('serve', '--auto');
  assert.equal(bad.code, 2);
  assert.match(bad.err, /unknown flag --auto/);
});

test('per-command --help', async () => {
  const r = await call('serve', '--help');
  assert.equal(r.code, 0);
  assert.match(r.out, /usage: air serve \[--repo OWNER\/NAME\] \[--manual\] \[--once \[--once-wait SECONDS\]\]/);
});

test('runs as a script', () => {
  const r = spawnSync(process.execPath, [new URL('./main.ts', import.meta.url).pathname, 'lint', '-'], { encoding: 'utf8', input: '---\nair: 0\n---\n' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^<stdin>:3: error: missing required field/);
});

test('commands on one issue validate ISSUE and --repo', async () => {
  for (const name of ['claim', 'setup', 'release', 'run', 'stop', 'start', 'status', 'wait', 'fetch', 'retry']) {
    const bad = await call(name, 'abc');
    assert.equal(bad.code, 2, name);
    assert.match(bad.err, new RegExp(`^air ${name}: ISSUE must be an issue number`), name);
    const badRepo = await call(name, '--repo', 'nope', '3');
    assert.equal(badRepo.code, 2, name);
    assert.match(badRepo.err, /--repo must be OWNER\/NAME/, name);
  }
});
