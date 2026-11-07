// Subscriptions with no readable meter: the volunteer states a budget and a reset schedule, and air records its own
// spend in a small JSON ledger so the budget decrements. A new period rolls the spend back to zero.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ManualConfig, Subscription } from './types.ts';

export interface Ledger { version: 1; subscriptions: Record<string, { periodStart: string; spent: number }> }

export const emptyLedger = (): Ledger => ({ version: 1, subscriptions: {} });

export function loadLedger(file: string): Ledger {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8'));
    if (v?.version === 1 && v.subscriptions && typeof v.subscriptions === 'object') return v;
  } catch { /* first use or unreadable: start empty */ }
  return emptyLedger();
}

export function saveLedger(file: string, ledger: Ledger) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.next`, JSON.stringify(ledger, null, 2) + '\n', { mode: 0o600 });
  renameSync(`${file}.next`, file);
}

/** The current period [start, end) of a reset schedule, at `now`. */
export function period(reset: ManualConfig['reset'], now: number): { start: number; end: number } {
  const utc = !!reset.utc, hour = reset.hour ?? 0;
  const d = new Date(now);
  const get = (f: 'FullYear' | 'Month' | 'Date' | 'Day') => (d as any)[`get${utc ? 'UTC' : ''}${f}`]();
  const at = (y: number, m: number, day: number) => utc ? Date.UTC(y, m, day, hour) : new Date(y, m, day, hour).getTime();
  const y = get('FullYear'), m = get('Month'), date = get('Date');
  if (reset.every === 'weekly') {
    // Day arithmetic through the calendar keeps the reset at the same wall-clock hour across DST changes.
    let day = date - ((get('Day') - reset.day + 7) % 7);
    if (at(y, m, day) > now) day -= 7;
    return { start: at(y, m, day), end: at(y, m, day + 7) };
  }
  const day = Math.min(28, Math.max(1, reset.day));
  let start = at(y, m, day), startMonth = m;
  if (start > now) { startMonth = m - 1; start = at(y, startMonth, day); }
  return { start, end: at(y, startMonth + 1, day) };
}

function entry(cfg: ManualConfig, ledger: Ledger, now: number) {
  const { start, end } = period(cfg.reset, now);
  const periodStart = new Date(start).toISOString();
  let e = ledger.subscriptions[cfg.name];
  if (!e || e.periodStart !== periodStart) e = ledger.subscriptions[cfg.name] = { periodStart, spent: 0 };
  return { e, end };
}

/** Record spend (tokens or percent points, the budget's unit). Mutates `ledger`; the caller saves it. */
export function recordSpend(cfg: ManualConfig, ledger: Ledger, amount: number, now = Date.now()) {
  if (!Number.isFinite(amount) || amount < 0) throw new Error(`invalid spend ${amount}`);
  entry(cfg, ledger, now).e.spent += amount;
}

export function readManual(cfg: ManualConfig, ledger: Ledger, now = Date.now()): Subscription {
  const { e, end } = entry(cfg, ledger, now);
  const budget = 'tokens' in cfg.budget ? cfg.budget.tokens : cfg.budget.percent;
  const usedPct = budget > 0 ? Math.round((e.spent / budget) * 1000) / 10 : 100;
  const kind = cfg.reset.every;
  return {
    name: cfg.name, harness: 'manual', readAt: new Date(now).toISOString(), stale: false,
    windows: [{ name: kind, kind, usedPct, resetsAt: new Date(end).toISOString(),
      ...('tokens' in cfg.budget ? { tokensLeft: Math.max(0, cfg.budget.tokens - e.spent) } : {}) }],
  };
}
