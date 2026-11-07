import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyLedger, loadLedger, period, readManual, recordSpend, saveLedger } from './manual.ts';
import type { ManualConfig } from './types.ts';

const T = (s: string) => Date.parse(s);
const weekly: ManualConfig = { name: 'team', harness: 'manual', reset: { every: 'weekly', day: 1, hour: 9, utc: true }, budget: { tokens: 1_000_000 } };
const monthly: ManualConfig = { name: 'gemini', harness: 'manual', reset: { every: 'monthly', day: 15, utc: true }, budget: { percent: 20 } };

test('weekly and monthly periods', () => {
  // 2026-11-07 is a Saturday
  assert.deepEqual(period(weekly.reset, T('2026-11-07T12:00:00Z')), { start: T('2026-11-02T09:00:00Z'), end: T('2026-11-09T09:00:00Z') });
  assert.deepEqual(period(weekly.reset, T('2026-11-09T08:59:00Z')), { start: T('2026-11-02T09:00:00Z'), end: T('2026-11-09T09:00:00Z') });
  assert.deepEqual(period(weekly.reset, T('2026-11-09T09:00:00Z')), { start: T('2026-11-09T09:00:00Z'), end: T('2026-11-16T09:00:00Z') });
  assert.deepEqual(period(monthly.reset, T('2026-11-07T00:00:00Z')), { start: T('2026-10-15T00:00:00Z'), end: T('2026-11-15T00:00:00Z') });
  assert.deepEqual(period(monthly.reset, T('2027-01-20T00:00:00Z')), { start: T('2027-01-15T00:00:00Z'), end: T('2027-02-15T00:00:00Z') });
  assert.deepEqual(period(monthly.reset, T('2027-01-02T00:00:00Z')), { start: T('2026-12-15T00:00:00Z'), end: T('2027-01-15T00:00:00Z') });
});

test('spend decrements a token budget and rolls over at the reset', () => {
  const ledger = emptyLedger();
  const now = T('2026-11-07T12:00:00Z');
  assert.deepEqual(readManual(weekly, ledger, now).windows,
    [{ name: 'weekly', kind: 'weekly', usedPct: 0, tokensLeft: 1_000_000, resetsAt: '2026-11-09T09:00:00.000Z' }]);
  recordSpend(weekly, ledger, 250_000, now);
  recordSpend(weekly, ledger, 50_000, now + 1000);
  const s = readManual(weekly, ledger, now + 2000);
  assert.equal(s.windows[0]!.usedPct, 30);
  assert.equal(s.windows[0]!.tokensLeft, 700_000);
  assert.equal(s.stale, false);
  const next = readManual(weekly, ledger, T('2026-11-09T10:00:00Z'));
  assert.equal(next.windows[0]!.tokensLeft, 1_000_000);
  assert.equal(next.windows[0]!.resetsAt, '2026-11-16T09:00:00.000Z');
  assert.equal(ledger.subscriptions.team!.spent, 0);
  assert.throws(() => recordSpend(weekly, ledger, -1));
});

test('percent budgets have no token count', () => {
  const ledger = emptyLedger();
  recordSpend(monthly, ledger, 5, T('2026-11-07T00:00:00Z'));
  const w = readManual(monthly, ledger, T('2026-11-07T00:00:00Z')).windows[0]!;
  assert.equal(w.usedPct, 25);
  assert.equal('tokensLeft' in w, false);
  assert.equal(w.kind, 'monthly');
});

test('ledger round-trips and tolerates a missing or corrupt file', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'air-ledger-')), 'state', 'ledger.json');
  assert.deepEqual(loadLedger(file), emptyLedger());
  const ledger = emptyLedger();
  recordSpend(weekly, ledger, 10);
  saveLedger(file, ledger);
  assert.deepEqual(loadLedger(file), ledger);
});
