import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { thisHost } from '../lib/pid.ts';
import { emptyLedger, loadLedger, period, readManual, recordSpend, resetLedger, spend } from './manual.ts';
import type { ManualConfig } from './types.ts';

const T = (s: string) => Date.parse(s);
const weekly: ManualConfig = { name: 'team', harness: 'manual', reset: { every: 'weekly', day: 1, hour: 9, utc: true }, budget: { usd: 100 } };
const monthly: ManualConfig = { name: 'gemini', harness: 'manual', reset: { every: 'monthly', day: 15, utc: true }, budget: { usd: 20 } };

test('weekly and monthly periods', () => {
  // 2026-11-07 is a Saturday
  assert.deepEqual(period(weekly.reset, T('2026-11-07T12:00:00Z')), { start: T('2026-11-02T09:00:00Z'), end: T('2026-11-09T09:00:00Z') });
  assert.deepEqual(period(weekly.reset, T('2026-11-09T08:59:00Z')), { start: T('2026-11-02T09:00:00Z'), end: T('2026-11-09T09:00:00Z') });
  assert.deepEqual(period(weekly.reset, T('2026-11-09T09:00:00Z')), { start: T('2026-11-09T09:00:00Z'), end: T('2026-11-16T09:00:00Z') });
  assert.deepEqual(period(monthly.reset, T('2026-11-07T00:00:00Z')), { start: T('2026-10-15T00:00:00Z'), end: T('2026-11-15T00:00:00Z') });
  assert.deepEqual(period(monthly.reset, T('2027-01-20T00:00:00Z')), { start: T('2027-01-15T00:00:00Z'), end: T('2027-02-15T00:00:00Z') });
  assert.deepEqual(period(monthly.reset, T('2027-01-02T00:00:00Z')), { start: T('2026-12-15T00:00:00Z'), end: T('2027-01-15T00:00:00Z') });
});

test('spend decrements a dollar budget and rolls over at the reset', () => {
  const ledger = emptyLedger();
  const now = T('2026-11-07T12:00:00Z');
  assert.deepEqual(readManual(weekly, ledger, now).windows,
    [{ name: 'weekly', kind: 'weekly', usedPct: 0, usdLeft: 100, usdBudget: 100, resetsAt: '2026-11-09T09:00:00.000Z' }]);
  assert.deepEqual(ledger, emptyLedger()); // a read never modifies the ledger
  recordSpend(weekly, ledger, 25, now);
  recordSpend(weekly, ledger, 5, now + 1000);
  const s = readManual(weekly, ledger, now + 2000);
  assert.equal(s.windows[0]!.usedPct, 30);
  assert.equal(s.windows[0]!.usdLeft, 70);
  assert.equal(s.stale, false);
  const after = T('2026-11-09T10:00:00Z');
  const next = readManual(weekly, ledger, after);
  assert.equal(next.windows[0]!.usdLeft, 100);
  assert.equal(next.windows[0]!.resetsAt, '2026-11-16T09:00:00.000Z');
  assert.equal(ledger.subscriptions.team!.spent, 30); // rollover is computed, not written, by a read
  recordSpend(weekly, ledger, 1, after);
  assert.deepEqual(ledger.subscriptions.team, { periodStart: '2026-11-09T09:00:00.000Z', spent: 1 });
  for (const bad of [-1, Infinity, NaN]) assert.throws(() => recordSpend(weekly, ledger, bad));
});

test('a monthly budget; spend past the budget leaves nothing', () => {
  const ledger = emptyLedger();
  recordSpend(monthly, ledger, 5, T('2026-11-07T00:00:00Z'));
  const w = readManual(monthly, ledger, T('2026-11-07T00:00:00Z')).windows[0]!;
  assert.equal(w.usedPct, 25);
  assert.equal(w.usdLeft, 15);
  assert.equal(w.kind, 'monthly');
  recordSpend(monthly, ledger, 30, T('2026-11-07T00:00:00Z'));
  assert.deepEqual(readManual(monthly, ledger, T('2026-11-07T00:00:00Z')).windows.map((x) => [x.usedPct, x.usdLeft]), [[175, 0]]);
});

const tmpLedger = () => join(mkdtempSync(join(tmpdir(), 'air-ledger-')), 'state', 'ledger.json');

test('a missing ledger is fresh; spend persists under the lock', () => {
  const file = tmpLedger();
  assert.deepEqual(loadLedger(file), { ledger: emptyLedger() });
  const s = spend(file, weekly, 10, T('2026-11-07T12:00:00Z'));
  assert.equal(s.windows[0]!.usdLeft, 90);
  assert.equal(loadLedger(file).ledger!.subscriptions.team!.spent, 10);
  assert.deepEqual(readdirSync(dirname(file)).sort(), ['ledger.json']); // no temp or lock files left
});

for (const [what, text, why] of [
  ['invalid JSON', '{"version": 1, "subscriptions": {', /invalid JSON/],
  ['a bad entry', JSON.stringify({ version: 1, subscriptions: { team: { periodStart: 'x', spent: -5 } } }), /invalid contents/],
] as const) {
  test(`a ledger with ${what} is moved aside and reads as unknown until reset`, () => {
    const file = tmpLedger();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    const first = loadLedger(file);
    assert.equal(first.ledger, null);
    assert.match(first.error!, why);
    const aside = readdirSync(dirname(file)).filter(n => n.startsWith('ledger.json.corrupt.'));
    assert.equal(aside.length, 1);
    assert.equal(readFileSync(join(dirname(file), aside[0]!), 'utf8'), text);
    // still unknown once the bad file is gone: its spend is lost, not zero
    const again = loadLedger(file);
    assert.equal(again.ledger, null);
    assert.match(again.error!, /reset-ledger/);
    const s = readManual(weekly, again.ledger, T('2026-11-07T12:00:00Z'), again.error);
    assert.equal(s.stale, true);
    assert.deepEqual(s.windows.map(w => [w.usedPct, 'usdLeft' in w]), [[null, false]]);
    assert.throws(() => spend(file, weekly, 1), /reset-ledger/);
    resetLedger(file);
    assert.deepEqual(loadLedger(file), { ledger: emptyLedger() });
  });
}

test('two processes spending 50 times each lose no update', async () => {
  const file = tmpLedger();
  const mod = pathToFileURL(join(import.meta.dirname, 'manual.ts')).href;
  const start = Date.now() + 1000; // both children start spending at the same instant
  const script = `const { spend } = await import(${JSON.stringify(mod)});
    const cfg = ${JSON.stringify(weekly)};
    while (Date.now() < ${start});
    for (let i = 0; i < 50; i++) spend(${JSON.stringify(file)}, cfg, 1);`;
  const child = () => new Promise<number | null>(resolve =>
    spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'inherit' }).on('close', resolve));
  assert.deepEqual(await Promise.all([child(), child()]), [0, 0]);
  assert.equal(loadLedger(file).ledger!.subscriptions.team!.spent, 100);
});

test('a lock left by a dead process is broken', () => {
  const file = tmpLedger();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.lock`, `999999999 0 ${thisHost()}`);
  assert.equal(spend(file, weekly, 3).windows[0]!.usdLeft, 97);
});
