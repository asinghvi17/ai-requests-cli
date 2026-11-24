import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cachedRead, effectiveWindows, headroomPct, REUSE_MS, STALE_MS } from './cache.ts';
import type { Reading, Window } from './types.ts';

const w = (name: string, usedPct: number, extra: Partial<Window> = {}): Window => ({ name, kind: name, usedPct, resetsAt: null, ...extra });

test('reuses a reading for 5 minutes, then reads again', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'air-cache-'));
  let calls = 0;
  const read = async (): Promise<Reading> => ({ windows: [w('five_hour', 10 * ++calls)] });
  const t0 = 1_800_000_000_000;
  const a = await cachedRead({ name: 'c', harness: 'claude', stateDir, read, now: t0 });
  const b = await cachedRead({ name: 'c', harness: 'claude', stateDir, read, now: t0 + REUSE_MS - 1 });
  assert.equal(calls, 1);
  assert.deepEqual(b, a);
  assert.equal(a.readAt, new Date(t0).toISOString());
  const c = await cachedRead({ name: 'c', harness: 'claude', stateDir, read, now: t0 + REUSE_MS });
  assert.equal(calls, 2);
  assert.equal(c.windows[0]!.usedPct, 20);
  await cachedRead({ name: 'c', harness: 'claude', stateDir, read, now: t0 + REUSE_MS + 1, refresh: true });
  assert.equal(calls, 3);
});

test('a failed read keeps the last windows, which go stale after 15 minutes and then count as unknown', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'air-cache-'));
  const t0 = 1_800_000_000_000;
  await cachedRead({ name: 'x', harness: 'codex', stateDir, now: t0, read: async () => ({ windows: [w('five_hour', 40), w('seven_day', 70)] }) });
  let calls = 0;
  const failing = async (): Promise<Reading> => { calls++; return { windows: [], note: 'codex: timeout' }; };
  const fresh = await cachedRead({ name: 'x', harness: 'codex', stateDir, now: t0 + REUSE_MS, read: failing });
  assert.equal(fresh.stale, false);
  assert.equal(fresh.note, 'codex: timeout');
  assert.equal(headroomPct(fresh), 30);
  // the failure is cached too: no re-run within 5 minutes
  await cachedRead({ name: 'x', harness: 'codex', stateDir, now: t0 + REUSE_MS + 1, read: failing });
  assert.equal(calls, 1);
  const stale = await cachedRead({ name: 'x', harness: 'codex', stateDir, now: t0 + STALE_MS + 1, read: failing });
  assert.equal(stale.stale, true);
  assert.equal(stale.readAt, new Date(t0).toISOString());
  // the numbers are gone from the subscription itself, so JSON and every consumer see unknown
  assert.deepEqual(stale.windows.map(x => x.usedPct), [null, null]);
  assert.deepEqual(effectiveWindows(stale).map(x => x.usedPct), [null, null]);
  assert.doesNotMatch(JSON.stringify(stale), /usedPct":\d|usdLeft/);
  assert.equal(headroomPct(stale), null);
});

test('never read is stale; a throwing reader is a failed read', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'air-cache-'));
  const s = await cachedRead({ name: 'y', harness: 'claude', stateDir, read: async () => { throw new Error('boom'); } });
  assert.equal(s.stale, true);
  assert.equal(s.readAt, null);
  assert.equal(s.note, 'reader failed: boom');
});

test('headroom ignores model-scoped meters', () => {
  const s = { name: 'c', harness: 'claude', readAt: null, stale: false,
    windows: [w('five_hour', 20), w('seven_day', 46), w('seven_day_fable', 100, { scope: 'Fable' })] };
  assert.equal(headroomPct(s), 54);
});

test('an incomplete reading is unknown, and replaces the last full one', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'air-cache-'));
  const t0 = 1_800_000_000_000;
  await cachedRead({ name: 'z', harness: 'claude', stateDir, now: t0, read: async () => ({ windows: [w('five_hour', 5), w('seven_day', 5)] }) });
  const s = await cachedRead({ name: 'z', harness: 'claude', stateDir, now: t0 + REUSE_MS, read: async () =>
    ({ windows: [w('five_hour', 10)], incomplete: true, note: 'incomplete: no weekly' }) });
  assert.equal(s.incomplete, true);
  assert.equal(s.stale, false);
  assert.equal(s.note, 'incomplete: no weekly');
  assert.deepEqual(s.windows.map(x => [x.name, x.usedPct]), [['five_hour', null]]);
  assert.equal(headroomPct(s), null);
  // a hand-built incomplete subscription is unknown too
  assert.equal(headroomPct({ name: 'h', harness: 'codex', readAt: null, stale: false, incomplete: true, windows: [w('five_hour', 1)] }), null);
});

test('stale usdLeft is dropped', () => {
  const s = { name: 'm', harness: 'manual', readAt: null, stale: true, windows: [w('weekly', 10, { usdLeft: 5, usdBudget: 10 })] };
  assert.deepEqual(effectiveWindows(s), [{ name: 'weekly', kind: 'weekly', usedPct: null, resetsAt: null }]);
});
