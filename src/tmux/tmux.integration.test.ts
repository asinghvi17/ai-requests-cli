// Against a real tmux on a throwaway socket. Skipped when tmux is missing; the server is always killed.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createTmux, defaultRunner } from './tmux.ts';

const hasTmux = spawnSync('tmux', ['-V']).status === 0;
const socket = `air-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

async function until(what: string, check: () => Promise<boolean> | boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

describe('tmux integration', { skip: hasTmux ? false : 'tmux not installed' }, () => {
  const t = createTmux({ socket });
  let dir = '';
  const saved = process.env.GH_TOKEN;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'air-tmux-'));
    // A secret in the caller's environment must not reach jobs (nor the tmux server).
    process.env.GH_TOKEN = 'ghp_should_not_leak';
    assert.equal(await t.ensureSession(), true);
    assert.equal(await t.ensureSession(), false);
  });
  after(async () => {
    const path = (await defaultRunner(socket)(['display-message', '-p', '#{socket_path}'])).stdout.trim();
    await t.killServer();
    if (path.endsWith(socket)) rmSync(path, { force: true });
    if (saved === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = saved;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test('a job runs in its workspace with a scrubbed environment', async () => {
    const out = join(dir, 'env.txt');
    // Even a secret in tmux's own global environment (e.g. a server started by hand) must not reach the job.
    assert.equal((await defaultRunner(socket)(['set-environment', '-g', 'GITHUB_TOKEN', 'ghp_global'])).code, 0);
    const id = await t.startJob({ issue: 11, cwd: dir, argv: ['/bin/sh', '-c', `env > ${out}.tmp; pwd >> ${out}.tmp; mv ${out}.tmp ${out}`], env: { AIR_EXTRA: 'yes' } });
    assert.match(id, /^@\d+$/);
    await until('env file', () => existsSync(out));
    const env = readFileSync(out, 'utf8');
    assert.doesNotMatch(env, /GH_TOKEN|GITHUB_TOKEN|ghp_/);
    assert.doesNotMatch(env, /^TMUX/m);
    assert.match(env, /^PATH=/m);
    assert.match(env, /^AIR_EXTRA=yes$/m);
    assert.match(env, /^TERM=/m);
    assert.ok(env.trimEnd().endsWith(dir));
    await t.stopJob(11, { graceMs: 0 });
  });

  test('a prompt file is passed as the last argument', async () => {
    const prompt = join(dir, 'prompt.md'), out = join(dir, 'args.txt');
    writeFileSync(prompt, 'fix "the" bug\nplease');
    await t.startJob({ issue: 12, cwd: dir, argv: ['/bin/sh', '-c', `printf '%s' "$1" > ${out}`, 'sh'], promptFile: prompt });
    await until('args file', () => existsSync(out) && readFileSync(out, 'utf8').length > 0);
    assert.equal(readFileSync(out, 'utf8'), 'fix "the" bug\nplease');
    await t.stopJob(12, { graceMs: 0 });
  });

  test('tags, listing, and windows that are not ours', async () => {
    const id = await t.startJob({ issue: 42, cwd: dir, argv: ['sleep', '60'] });
    // The volunteer's own window, even one named like a job, and a split of our job window are ignored.
    const run = defaultRunner(socket);
    assert.equal((await run(['new-window', '-d', '-t', '=air:', '-n', '#42', 'sleep', '60'])).code, 0);
    assert.equal((await run(['split-window', '-d', '-t', id, 'sleep', '60'])).code, 0);
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
    assert.deepEqual((await t.attachArgs(42, {})).slice(-3), ['select-window', '-t', id]);
    await t.stopJob(42, { graceMs: 2000 });
    assert.equal(await t.isAlive(42), false);
    const left = await run(['list-windows', '-t', '=air', '-F', '#{window_name}']);
    assert.deepEqual(left.stdout.trim().split('\n'), ['log', '#42']); // only the volunteer's window remains
    assert.equal((await run(['kill-window', '-t', '=air:#42'])).code, 0);
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
  });

  test('stop sends the interrupt and waits for a graceful exit', async () => {
    const marker = join(dir, 'trapped');
    await t.startJob({ issue: 8, cwd: dir, argv: ['/bin/sh', '-c', `trap 'touch ${marker}; exit 0' INT; while :; do sleep 0.1; done`] });
    await until('job start', async () => (await t.capture(8, 5)) !== null);
    await sleep(200);
    const r = await t.stopJob(8, { graceMs: 3000, keys: ['C-c'] });
    assert.ok(existsSync(marker));
    assert.deepEqual(r, { exitStatus: 0 });
    assert.deepEqual(await t.listJobs(), []);
  });

  test('stop kills a job that ignores the interrupt', async () => {
    await t.startJob({ issue: 9, cwd: dir, argv: ['/bin/sh', '-c', `trap '' INT; while :; do sleep 0.1; done`] });
    await sleep(200);
    const start = Date.now();
    assert.deepEqual(await t.stopJob(9, { graceMs: 300 }), { exitStatus: null });
    assert.ok(Date.now() - start >= 300);
    assert.deepEqual(await t.listJobs(), []);
  });

  test('a restarted server re-adopts live jobs from the tags alone', async () => {
    const id = await t.startJob({ issue: 100, cwd: dir, argv: ['sleep', '60'] });
    const fresh = createTmux({ socket }); // no state carried over
    const [job] = await fresh.listJobs();
    assert.equal(job?.issue, 100);
    assert.equal(job?.windowId, id);
    assert.equal(await fresh.isAlive(100), true);
    await fresh.stopJob(100, { graceMs: 1000 });
    assert.deepEqual(await fresh.listJobs(), []);
  });
});
