import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { childEnv, isDenied } from './env.ts';
import { exec } from './exec.ts';

const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'air-exec-'));
  dirs.push(d);
  return d;
}

const SERVER_ENV = {
  PATH: process.env.PATH, HOME: '/home/x', LANG: 'C.UTF-8', GH_TOKEN: 'ghp_secret', GITHUB_TOKEN: 'ghs_secret',
  AWS_SECRET_ACCESS_KEY: 'aws', SSH_AUTH_SOCK: '/tmp/agent.sock', ANTHROPIC_API_KEY: 'sk', GOOGLE_APPLICATION_CREDENTIALS: '/k.json',
  BASH_ENV: '/evil', RANDOM_THING: 'x',
};

test('childEnv keeps the allowlist and drops credentials', () => {
  const env = childEnv({ AIR_WORKSPACE: '/w' }, SERVER_ENV);
  assert.deepEqual(env, { PATH: process.env.PATH, HOME: '/home/x', LANG: 'C.UTF-8', AIR_WORKSPACE: '/w' });
  assert.throws(() => childEnv({ GH_TOKEN: 'x' }, {}), /refusing to pass GH_TOKEN/);
  assert.throws(() => childEnv({ 'A=B': 'x' }, {}), /bad environment variable name/);
  for (const n of ['GH_TOKEN', 'GITHUB_TOKEN', 'AWS_PROFILE', 'SSH_AUTH_SOCK', 'AZURE_CLIENT_SECRET', 'NPM_TOKEN', 'GIT_ASKPASS', 'LD_PRELOAD']) assert.ok(isDenied(n), n);
});

test('commands get /dev/null on stdin, the given env and cwd, and log their output', async () => {
  const d = tmp();
  const log = join(d, 'log');
  const env = childEnv({ AIR_WORKSPACE: d }, SERVER_ENV);
  const script = 'cat; [ -t 0 ] && echo tty; if [ -e /proc/self/fd/0 ]; then readlink /proc/self/fd/0; fi; pwd; env | sort; echo err >&2';
  const r = await exec(['sh', '-c', script], { cwd: d, env, log });
  assert.deepEqual(r, { code: 0, signal: null, timedOut: false });
  const out = readFileSync(log, 'utf8');
  assert.doesNotMatch(out, /tty/);
  if (process.platform === 'linux') assert.match(out, /^\/dev\/null$/m);
  assert.ok(out.includes(`${d}\n`) || out.includes('/private' + d));
  assert.match(out, new RegExp(`^AIR_WORKSPACE=${d}$`, 'm'));
  assert.doesNotMatch(out, /GH_TOKEN|GITHUB_TOKEN|AWS_|SSH_AUTH_SOCK|ANTHROPIC|GOOGLE_|RANDOM_THING|secret/);
  assert.match(out, /^err$/m);
  assert.equal((await exec(['sh', '-c', 'exit 7'], { cwd: d, env, log })).code, 7);
});

test('a timeout kills the whole process group, background children included', async () => {
  const d = tmp();
  const log = join(d, 'log');
  const t0 = Date.now();
  const r = await exec(['sh', '-c', `sleep 30 & echo $! > ${d}/bg; sleep 30`], { cwd: d, env: childEnv({}), log, timeoutMs: 300 });
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - t0 < 10_000);
  const bg = Number(readFileSync(join(d, 'bg'), 'utf8'));
  await sleep(100);
  assert.throws(() => process.kill(bg, 0), /ESRCH/);
});

test('background children are reaped when the command exits', async () => {
  const d = tmp();
  const r = await exec(['sh', '-c', `sleep 30 & echo $! > ${d}/bg`], { cwd: d, env: childEnv({}), log: join(d, 'log') });
  assert.equal(r.code, 0);
  await sleep(100);
  assert.throws(() => process.kill(Number(readFileSync(join(d, 'bg'), 'utf8')), 0), /ESRCH/);
});
