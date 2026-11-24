import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { alive, thisHost, writerGone } from './pid.ts';
import { withLock } from './usage/lock.ts';

const deadPid = () => Number(spawnSync('sh', ['-c', 'echo $$']).stdout.toString().trim());

test('alive: our own process, and another user\'s (EPERM) are alive; an exited one is not', () => {
  assert.equal(alive(process.pid), true);
  assert.equal(alive(1), true, 'pid 1 runs as root: kill(1, 0) is EPERM for a user, which means it runs');
  assert.equal(alive(deadPid()), false);
});

test('writerGone: only a process of this host can be judged gone', () => {
  const dead = deadPid();
  assert.equal(writerGone(dead, thisHost()), true);
  assert.equal(writerGone(dead, 'another.host'), false);
  assert.equal(writerGone(process.pid, thisHost()), false);
  assert.doesNotMatch(thisHost(), /\s/);
});

test('usage locks record the host: a dead writer here is broken at once; another host\'s only once it is old', () => {
  const d = mkdtempSync(join(tmpdir(), 'air-pid-'));
  try {
    const file = join(d, 'cache.json');
    let seen = '';
    withLock(file, () => { seen = spawnSync('cat', [`${file}.lock`]).stdout.toString(); });
    assert.match(seen, new RegExp(`^${process.pid} \\d+ ${thisHost().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
    writeFileSync(`${file}.lock`, `${deadPid()} ${Date.now()} ${thisHost()}`);
    assert.equal(withLock(file, () => 'ran'), 'ran');
    writeFileSync(`${file}.lock`, `${deadPid()} ${Date.now()} another.host`);
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${file}.lock`, old, old);
    assert.equal(withLock(file, () => 'ran'), 'ran', 'past its age limit');
    assert.equal(existsSync(`${file}.lock`), false);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
