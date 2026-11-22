import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { staleLaunchers, writeLauncher } from '../tmux/launcher.ts';
import { createWorkspace, writeState, type JobStatus, type Phase, type State } from '../workspace/state.ts';
import { DELIVERY_LOCK } from './jobs.ts';
import { LOCK_FILE } from './state.ts';
import { formatMachineStatus, KEEP_MS, leftovers, machineStatus, tidy } from './tidy.ts';

const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'air-tidy-'));
  dirs.push(d);
  return d;
};

const NOW = new Date('2026-11-22T12:00:00Z');
const DAY = 86_400_000;
const deadPid = () => Number(spawnSync('sh', ['-c', 'echo $$']).stdout.toString().trim());

let nonces = 0;
/** A workspace of o/requests#`issue` in `phase` (and job `status`), last written `ago` ms before NOW. */
function ws(root: string, issue: number, phase: Phase, status?: JobStatus, ago = 0): string {
  const at = new Date(NOW.getTime() - ago).toISOString();
  const state: State = {
    version: 1, repo: 'o/requests', issue, title: 't', author: 'alice', url: 'u', host: 'box', nonce: `nonce${String(++nonces).padStart(8, '0')}`,
    repos: [], phase, createdAt: at, updatedAt: at,
    ...(status ? { job: { status, harness: 'claude', subscription: 'max', model: 'sonnet', runMs: 0, starts: 1 } } : {}),
  };
  const dir = createWorkspace(root, state, 'body');
  writeState(dir, state);
  return dir;
}

test('ended workspaces: delivered ones go at once, the others after KEEP_MS; held ones stay', () => {
  const root = tmp(), stateDir = tmp();
  const held = ws(root, 1, 'ready', 'running', 30 * DAY);
  const manual = ws(root, 2, 'ready', undefined, 30 * DAY); // `air setup` by hand, no job yet
  const done = ws(root, 3, 'done', 'done');
  const failed = ws(root, 4, 'failed', 'failed', KEEP_MS - 3600_000);
  const oldFailed = ws(root, 5, 'failed', 'failed', KEEP_MS + 1);
  const cancelled = ws(root, 6, 'ready', 'cancelled', KEEP_MS + 1); // its release was refused: still `ready`
  const lost = ws(root, 7, 'lost', undefined, 8 * DAY);
  const l = leftovers({ root, stateDir, now: NOW });
  assert.deepEqual(l.held.map((w) => w.dir).sort(), [held, manual].sort());
  assert.deepEqual(l.kept.map((k) => [k.ws.dir, k.until.toISOString()]), [[failed, new Date(NOW.getTime() + 3600_000).toISOString()]]);
  assert.deepEqual(l.due.map((w) => w.dir).sort(), [done, oldFailed, cancelled, lost].sort());

  const lines: string[] = [];
  assert.deepEqual(tidy({ root, stateDir, now: NOW, log: (s) => lines.push(s) }), { removed: 4, failed: 0, kept: 1 });
  for (const d of [done, oldFailed, cancelled, lost]) assert.equal(existsSync(d), false, d);
  for (const d of [held, manual, failed]) assert.equal(existsSync(d), true, d);
  assert.ok(lines.includes(`removed the workspace of o/requests#3 (done), ${done}`), lines.join('\n'));
  assert.ok(lines.includes(`removed the workspace of o/requests#7 (lost), ${lost}`), lines.join('\n'));
});

test('every requests repo under workspace_root is looked at; other directories are not', () => {
  const root = tmp(), stateDir = tmp();
  const done = ws(root, 3, 'done', 'done');
  const other = join(root, 'other__repo', '9-aaaaaaaaaaaa');
  mkdirSync(join(root, 'notes', '9-aaaaaaaaaaaa'), { recursive: true });
  const state: State = { version: 1, repo: 'other/repo', issue: 9, title: 't', author: 'a', url: 'u', host: 'box', nonce: 'aaaaaaaaaaaa', repos: [], phase: 'done', createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() };
  createWorkspace(root, state, 'body');
  tidy({ root, stateDir, now: NOW, log: () => {} });
  assert.equal(existsSync(done), false);
  assert.equal(existsSync(other), false);
  assert.equal(existsSync(join(root, 'notes', '9-aaaaaaaaaaaa')), true);
});

test('stale locks (dead pid) and temp files of dead air processes go; live ones stay', () => {
  const root = tmp(), stateDir = tmp();
  const live = spawn('sleep', ['30']);
  try {
    const dead = deadPid();
    const kept = ws(root, 4, 'failed', 'failed', DAY);
    const busy = ws(root, 5, 'ready', 'delivering');
    writeFileSync(join(kept, DELIVERY_LOCK), `${dead}\n`);
    writeFileSync(join(busy, DELIVERY_LOCK), `${live.pid}\n`);
    writeFileSync(join(stateDir, LOCK_FILE), `${dead}\n`);
    const temp = [`.serve.json.${dead}.tmp`, `.serve.lock.${dead}.0123456789ab`, `.serve.lock.${dead}.0123456789ab.stale`, `manual-ledger.json.${dead}.0123456789ab.tmp`];
    const liveTemp = [`.serve.json.${live.pid}.tmp`, `cache.json.${live.pid}.0123456789ab.tmp`];
    for (const f of [...temp, ...liveTemp, 'serve.json', 'serve.log']) writeFileSync(join(stateDir, f), '');
    const l = leftovers({ root, stateDir, now: NOW });
    assert.deepEqual(l.locks, [join(stateDir, LOCK_FILE), join(kept, DELIVERY_LOCK)]);
    assert.deepEqual(l.temp.sort(), temp.map((f) => join(stateDir, f)).sort());
    tidy({ root, stateDir, now: NOW, log: () => {} });
    assert.equal(existsSync(join(kept, DELIVERY_LOCK)), false);
    assert.equal(existsSync(join(stateDir, LOCK_FILE)), false);
    assert.equal(existsSync(join(busy, DELIVERY_LOCK)), true, 'a live holder keeps its lock');
    for (const f of temp) assert.equal(existsSync(join(stateDir, f)), false, f);
    for (const f of [...liveTemp, 'serve.json', 'serve.log']) assert.equal(existsSync(join(stateDir, f)), true, f);
  } finally {
    live.kill();
  }
});

test('launcher dirs: an old one no pane uses goes; a recent one, one a pane names or one whose agent runs stays', () => {
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = tmp(); // tmpdir() follows it: only this test's launchers are looked at
  const live = spawn('sleep', ['30']);
  try {
    const old = Date.now() / 1000 - 2 * 86_400;
    const make = (age: number) => {
      const l = writeLauncher({ argv: ['true'], status: true });
      utimesSync(l.dir, age, age);
      return l.dir;
    };
    const left = make(old), named = make(old), running = make(old), fresh = make(Date.now() / 1000);
    writeFileSync(join(running, 'pid'), `${live.pid}\n`);
    utimesSync(running, old, old);
    const panes = [{ windowId: '@1', windowName: '#3', paneId: '%1', issue: 3, repo: 'o/requests', launcher: named }];
    assert.deepEqual(staleLaunchers(new Set([named])), [left]);
    const root = tmp(), stateDir = tmp();
    assert.deepEqual(leftovers({ root, stateDir, now: new Date(), panes }).launchers, [left]);
    assert.deepEqual(leftovers({ root, stateDir, now: new Date() }).launchers, [], 'not looked for without the pane list');
    tidy({ root, stateDir, now: new Date(), panes, log: () => {} });
    assert.equal(existsSync(left), false);
    for (const d of [named, running, fresh]) assert.equal(existsSync(d), true, d);
  } finally {
    live.kill();
    if (saved === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = saved;
  }
});

test('air status without an issue: clean, kept for debugging, or what is left behind', () => {
  const root = tmp(), stateDir = tmp();
  const show = (panes: Parameters<typeof machineStatus>[1]['panes'], serving = false) =>
    machineStatus(leftovers({ root, stateDir, now: NOW, panes }), { panes, serving, socket: 'air' });
  const text = (s: ReturnType<typeof show>) => formatMachineStatus(s, { root, stateDir, socket: 'air' });
  assert.match(text(show([])), /^serve: not running\njobs held: 0\ntmux \(-L air\): no server\nclean: nothing left behind$/m);
  assert.equal(show([]).clean, true);

  const failed = ws(root, 4, 'failed', 'failed', DAY);
  assert.match(text(show([])), new RegExp(`workspaces kept for debugging: 1\n  o/requests#4 failed/failed: ${failed} \\(removed from 2026-11-28\\)\nclean, but for 1 workspace\\(s\\) kept for debugging\n$`));

  const held = ws(root, 1, 'ready', 'running');
  const done = ws(root, 3, 'done', 'done');
  const panes = [
    { windowId: '@0', windowName: 'log', paneId: '%0' },
    { windowId: '@1', windowName: '#1', paneId: '%1', issue: 1, repo: 'o/requests' },
    { windowId: '@2', windowName: '#2', paneId: '%2', issue: 2, repo: 'o/requests' },
  ];
  const s = show(panes, true);
  assert.equal(s.clean, false);
  assert.equal(s.left, 2);
  const out = text(s);
  assert.match(out, new RegExp(`jobs held: 1\n  o/requests#1 ready/running: ${held}\n`));
  assert.match(out, /tmux \(-L air\): windows log, #1, #2\n/);
  assert.match(out, new RegExp(`workspaces due for removal: 1\n  o/requests#3 done/done: ${done}\n`));
  assert.match(out, /tmux leftovers: 1\n {2}window #2 \(@2\) of o\/requests#2, a job not held\n/);
  assert.match(out, /left behind: 2; `air serve` removes it/);
  // No server and no job: the session itself is left over.
  assert.deepEqual(show([panes[0]!]).tmux?.stray, ['the tmux session on -L air, with no job and no `air serve`']);
  assert.match(text(show(undefined)), /^tmux: could not be asked$/m);
});
