// Against a real tmux on a throwaway socket. Skipped when tmux is missing; the server is killed after the
// suite and on exit or interrupt, and any global environment the tests set is restored.
import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createTmux, defaultRunner, socketPath, TASK_FILE, TASK_INSTRUCTION } from './tmux.ts';
import { clientEnv } from './env.ts';

const hasTmux = spawnSync('tmux', ['-V']).status === 0;
const socket = `air-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const raw = defaultRunner(socket);

function killTestServer() {
  spawnSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' });
  rmSync(socketPath(socket), { force: true }); // tmux may be unable to unlink it in a sandbox
}
if (hasTmux) {
  process.on('exit', killTestServer);
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => { killTestServer(); process.exit(130); });
}

async function until(what: string, check: () => Promise<boolean> | boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

describe('tmux integration', { skip: hasTmux ? false : 'tmux not installed' }, () => {
  let t = createTmux({ socket });
  let dir = '';
  const saved = process.env.GH_TOKEN;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'air-tmux-'));
    // A secret in the caller's environment must not reach jobs (nor the tmux server).
    process.env.GH_TOKEN = 'ghp_should_not_leak';
    assert.equal(await t.ensureSession(), true);
    assert.equal(await t.ensureSession(), false);
  });
  afterEach(async () => {
    for (const job of await t.listJobs()) await t.stopJob(job.issue, { graceMs: 0 });
  });
  after(() => {
    killTestServer();
    if (saved === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = saved;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test('a job runs interactively in its workspace with a scrubbed environment and a task file', async () => {
    // Even secrets and shell startup hooks in tmux's own global environment must not reach the job.
    for (const [k, v] of [['GITHUB_TOKEN', 'ghp_global'], ['BASH_ENV', '/nonexistent/bashenv'], ['ENV', '/nonexistent/env']])
      assert.equal((await raw(['set-environment', '-g', k!, v!])).code, 0);
    const out = join(dir, 'env.txt');
    const script = `{ env; echo "pwd=$(pwd)"; echo "arg=$1"; [ -t 0 ] && echo stdin=tty; } > ${out}.tmp; mv ${out}.tmp ${out}`;
    const task = 'fix the bug\n'.repeat(200_000); // ~2.4 MB: would be E2BIG in argv
    const id = await t.startJob({ issue: 11, cwd: dir, argv: ['/bin/sh', '-c', script, 'sh'], env: { AIR_EXTRA: 'yes' }, task });
    assert.match(id, /^@\d+$/);
    await until('env file', () => existsSync(out));
    const env = readFileSync(out, 'utf8');
    assert.doesNotMatch(env, /GH_TOKEN|GITHUB_TOKEN|ghp_|BASH_ENV|^ENV=/m);
    assert.doesNotMatch(env, /^TMUX/m);
    assert.match(env, /^PATH=/m);
    assert.match(env, new RegExp(`^HOME=${process.env.HOME}$`, 'm'));
    assert.match(env, /^AIR_EXTRA=yes$/m);
    assert.match(env, /^TERM=/m);
    assert.match(env, new RegExp(`^pwd=${dir}$`, 'm'));
    assert.match(env, new RegExp(`^arg=${TASK_INSTRUCTION.replace(/\./g, '\\.')}$`, 'm'));
    assert.match(env, /^stdin=tty$/m);
    assert.equal(readFileSync(join(dir, TASK_FILE), 'utf8'), task);
  });

  test('tags, listing, and windows that are not ours', async () => {
    const id = await t.startJob({ issue: 42, cwd: dir, argv: ['sleep', '60'] });
    // The volunteer's own window, even one named like a job, and a split of our job window are ignored.
    assert.equal((await raw(['new-window', '-d', '-t', '=air:', '-n', '#42', 'sleep', '60'])).code, 0);
    assert.equal((await raw(['split-window', '-d', '-t', id, 'sleep', '60'])).code, 0);
    try {
      const jobs = await t.listJobs();
      assert.equal(jobs.length, 1);
      const [job] = jobs;
      assert.equal(job!.issue, 42);
      assert.equal(job!.windowId, id);
      assert.equal(job!.windowName, '#42');
      assert.equal(job!.dead, false);
      assert.ok(job!.pid > 0);
      assert.equal(await t.isAlive(42), true);
      await assert.rejects(t.startJob({ issue: 42, cwd: dir, argv: ['true'] }), /already/);
      await t.stopJob(42, { graceMs: 2000 });
      assert.equal(await t.isAlive(42), false);
      const left = await raw(['list-windows', '-t', '=air', '-F', '#{window_name}']);
      assert.deepEqual(left.stdout.trim().split('\n'), ['log', '#42']); // only the volunteer's window remains
    } finally {
      await raw(['kill-window', '-t', '=air:=#42']);
    }
  });

  test('concurrent starts of one issue yield one window', async () => {
    const results = await Promise.allSettled([1, 2, 3].map(() => t.startJob({ issue: 13, cwd: dir, argv: ['sleep', '60'] })));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal((await t.listJobs()).filter(j => j.issue === 13).length, 1);
  });

  test('duplicates keep the oldest pane; leftover starting panes are killed, not adopted', async () => {
    const id = await t.startJob({ issue: 14, cwd: dir, argv: ['sleep', '60'] });
    const tag = async (issue: string, nonce: string, state: string) => {
      const r = await raw(['new-window', '-d', '-P', '-F', '#{window_id}', '-t', '=air:', 'sleep', '60']);
      const w = r.stdout.trim();
      assert.equal((await raw(['set-option', '-p', '-t', w, '@air_job', issue, ';', 'set-option', '-p', '-t', w, '@air_nonce', nonce,
        ';', 'set-option', '-p', '-t', w, '@air_state', state])).code, 0);
      return w;
    };
    const dup = await tag('14', 'dupnonce', 'running');
    const stale = await tag('15', 'stalenonce', 'starting');
    const jobs = await t.listJobs();
    assert.deepEqual(jobs.map(j => j.issue), [14, 14]); // the stale placeholder is not a job
    assert.equal(await t.isAlive(14), true); // findJob resolves the duplicate
    const windows = (await raw(['list-windows', '-t', '=air', '-F', '#{window_id}'])).stdout.trim().split('\n');
    assert.ok(windows.includes(id));
    assert.ok(!windows.includes(dup));
    assert.ok(!windows.includes(stale));
    assert.deepEqual((await t.listJobs()).map(j => j.windowId), [id]);
  });

  test('exit status is readable after the pane dies, and capture works', async () => {
    await t.startJob({ issue: 7, cwd: dir, argv: ['/bin/sh', '-c', 'echo hello-from-job; exit 3'] });
    await until('pane death', async () => (await t.listJobs()).some(j => j.issue === 7 && j.dead));
    const job = (await t.listJobs()).find(j => j.issue === 7)!;
    assert.equal(job.exitStatus, 3);
    assert.equal(await t.isAlive(7), false);
    assert.match((await t.capture(7, 20))!, /hello-from-job/);
    assert.deepEqual(await t.stopJob(7), { exitStatus: 3 });
    assert.deepEqual(await t.listJobs(), []);
    assert.equal(await t.capture(7), null);
  });

  test('stop sends the interrupt and waits for a graceful exit', async () => {
    const ready = join(dir, 'trap-ready'), trapped = join(dir, 'trapped');
    await t.startJob({ issue: 8, cwd: dir, argv: ['/bin/sh', '-c', `trap 'touch ${trapped}; exit 0' INT; touch ${ready}; while :; do sleep 0.1; done`] });
    await until('trap installed', () => existsSync(ready));
    const r = await t.stopJob(8, { graceMs: 3000, keys: ['C-c'] });
    assert.ok(existsSync(trapped));
    assert.deepEqual(r, { exitStatus: 0 });
    assert.deepEqual(await t.listJobs(), []);
  });

  test('stop kills a job that ignores the interrupt', async () => {
    const ready = join(dir, 'ignore-ready');
    await t.startJob({ issue: 9, cwd: dir, argv: ['/bin/sh', '-c', `trap '' INT; touch ${ready}; while :; do sleep 0.1; done`] });
    await until('trap installed', () => existsSync(ready));
    const start = Date.now();
    assert.deepEqual(await t.stopJob(9, { graceMs: 300 }), { exitStatus: null });
    assert.ok(Date.now() - start >= 300);
    assert.deepEqual(await t.listJobs(), []);
  });

  test('attach targets the job window; switch-client moves a client to it', async () => {
    const a = await t.startJob({ issue: 20, cwd: dir, argv: ['sleep', '60'] });
    const b = await t.startJob({ issue: 21, cwd: dir, argv: ['sleep', '60'] });
    const argv = await t.attachArgs(20, {});
    assert.deepEqual(argv, ['tmux', '-L', socket, 'attach-session', '-t', a]);
    // A control-mode client runs the same attach command headless (-C added after the socket).
    const client = spawn('tmux', ['-L', socket, '-C', ...argv.slice(3)], { env: clientEnv(), stdio: ['pipe', 'ignore', 'ignore'] });
    try {
      const clients = async () => (await raw(['list-clients', '-F', '#{client_name} #{window_id}'])).stdout.trim().split('\n').filter(Boolean);
      await until('client attached', async () => (await clients()).length === 1);
      const [name, win] = (await clients())[0]!.split(' ');
      assert.equal(win, a);
      // Inside our server the argv is switch-client; with no calling terminal here, name the client with -c.
      const sw = await t.attachArgs(21, { TMUX: `${socketPath(socket)},1,0` });
      assert.deepEqual(sw, ['tmux', '-L', socket, 'switch-client', '-t', b]);
      assert.equal((await raw([sw[3]!, '-c', name!, ...sw.slice(4)])).code, 0);
      await until('client switched', async () => (await clients())[0]!.split(' ')[1] === b);
    } finally {
      client.stdin.end();
      client.kill();
    }
  });

  test('restart: a new wrapper re-adopts live jobs; a new tmux server has none', async () => {
    const id = await t.startJob({ issue: 100, cwd: dir, argv: ['sleep', '60'] });
    // Server process restart: throw the wrapper (and its locks) away and build a fresh one.
    t = createTmux({ socket });
    const [job] = await t.listJobs();
    assert.equal(job?.issue, 100);
    assert.equal(job?.windowId, id);
    assert.equal(await t.isAlive(100), true);
    assert.match(job!.nonce, /^[0-9a-f]{24}$/);
    // tmux server restart: jobs are gone, and concurrent ensureSession calls race safely.
    assert.equal((await raw(['kill-server'])).code, 0);
    t = createTmux({ socket });
    assert.deepEqual(await t.listJobs(), []);
    assert.equal(await t.isAlive(100), false);
    assert.equal(await t.capture(100), null);
    assert.equal(await t.stopJob(100), undefined);
    const created = await Promise.all([t.ensureSession(), createTmux({ socket }).ensureSession()]);
    assert.equal(created.filter(Boolean).length, 1);
    assert.deepEqual(await t.listJobs(), []);
  });
});
