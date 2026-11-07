// Subscriptions with no readable meter: the volunteer states a budget and a reset schedule, and air records its own
// spend in a small JSON ledger so the budget decrements. A new period rolls the spend back to zero.
// A ledger that cannot be trusted (bad JSON, bad shape, unknown version) is moved aside and its subscriptions read
// as unknown until `air usage reset-ledger` writes a fresh one: lost spend must never look like an unused budget.
import { readdirSync, readFileSync, renameSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { withLock, writeAtomic } from './lock.ts';
import type { ManualConfig, Subscription } from './types.ts';

export interface Ledger { version: 1; subscriptions: Record<string, { periodStart: string; spent: number }> }
/** `ledger: null`: unusable; `error` says why and where the bad file went. */
export type LedgerLoad = { ledger: Ledger; error?: undefined } | { ledger: null; error: string };

export const emptyLedger = (): Ledger => ({ version: 1, subscriptions: {} });
const RESET_HINT = 'run `air usage reset-ledger` to start a fresh one';

function valid(v: any): v is Ledger {
  if (!v || typeof v !== 'object' || v.version !== 1 || !v.subscriptions || typeof v.subscriptions !== 'object' || Array.isArray(v.subscriptions)) return false;
  return Object.values(v.subscriptions).every((e: any) => e && typeof e.periodStart === 'string' && Number.isFinite(Date.parse(e.periodStart))
    && typeof e.spent === 'number' && Number.isFinite(e.spent) && e.spent >= 0);
}

function loadUnlocked(file: string): LedgerLoad {
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return { ledger: null, error: `cannot read ledger ${file}: ${(e as Error).message}` };
    // A missing ledger is fresh only if none was moved aside: otherwise its spend is lost, not zero.
    const aside = readdirSync(dirname(file), { withFileTypes: true }).filter(d => d.name.startsWith(`${basename(file)}.corrupt.`));
    return aside.length ? { ledger: null, error: `ledger was unusable and moved to ${join(dirname(file), aside.map(d => d.name).sort().at(-1)!)}; ${RESET_HINT}` }
      : { ledger: emptyLedger() };
  }
  let v: unknown, why: string;
  try { v = JSON.parse(text); why = (v as any)?.version !== 1 ? `unsupported version ${JSON.stringify((v as any)?.version)}` : 'invalid contents'; }
  catch { why = 'invalid JSON'; }
  if (valid(v)) return { ledger: v };
  const to = `${file}.corrupt.${new Date().toISOString().replace(/[:.]/g, '-')}`;
  try { renameSync(file, to); } catch { /* moved by another process */ }
  return { ledger: null, error: `ledger ${why}; moved to ${to}; ${RESET_HINT}` };
}

/** ENOENT is a fresh empty ledger; anything else unusable is moved to `<file>.corrupt.<time>` and reported. */
export function loadLedger(file: string): LedgerLoad {
  try { return withLock(file, () => loadUnlocked(file)); } catch (e) { return { ledger: null, error: (e as Error).message }; }
}

/** Unlocked write; `spend` and `resetLedger` are the locked load → modify → save paths. */
export function saveLedger(file: string, ledger: Ledger) {
  writeAtomic(file, JSON.stringify(ledger, null, 2) + '\n');
}

/** Record spend against `cfg` under the ledger lock. Throws if the ledger is unusable. */
export function spend(file: string, cfg: ManualConfig, amount: number, now = Date.now()): Subscription {
  return withLock(file, () => {
    const { ledger, error } = loadUnlocked(file);
    if (!ledger) throw new Error(error);
    recordSpend(cfg, ledger, amount, now);
    saveLedger(file, ledger);
    return readManual(cfg, ledger, now);
  });
}

/** Start a fresh, empty ledger (after a corrupt one was moved aside). */
export function resetLedger(file: string) {
  withLock(file, () => saveLedger(file, emptyLedger()));
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

function current(cfg: ManualConfig, ledger: Ledger, now: number) {
  const { start, end } = period(cfg.reset, now);
  const periodStart = new Date(start).toISOString();
  const e = ledger.subscriptions[cfg.name];
  return { periodStart, end, spent: e && e.periodStart === periodStart ? e.spent : 0 };
}

/** Record spend (tokens or percent points, the budget's unit), rolling the period over. Mutates `ledger`. */
export function recordSpend(cfg: ManualConfig, ledger: Ledger, amount: number, now = Date.now()) {
  if (!Number.isFinite(amount) || amount < 0) throw new Error(`invalid spend ${amount}`);
  const { periodStart, spent } = current(cfg, ledger, now);
  ledger.subscriptions[cfg.name] = { periodStart, spent: spent + amount };
}

/** Pure: never modifies or writes the ledger. `ledger: null` (unusable) reads as unknown, never as 0% used. */
export function readManual(cfg: ManualConfig, ledger: Ledger | null, now = Date.now(), why = 'ledger unusable'): Subscription {
  const kind = cfg.reset.every;
  if (!ledger) {
    return { name: cfg.name, harness: 'manual', readAt: null, stale: true, note: why,
      windows: [{ name: kind, kind, usedPct: null, resetsAt: new Date(period(cfg.reset, now).end).toISOString() }] };
  }
  const { spent, end } = current(cfg, ledger, now);
  const budget = 'tokens' in cfg.budget ? cfg.budget.tokens : cfg.budget.percent;
  const usedPct = budget > 0 ? Math.round((spent / budget) * 1000) / 10 : 100;
  return {
    name: cfg.name, harness: 'manual', readAt: new Date(now).toISOString(), stale: false,
    windows: [{ name: kind, kind, usedPct, resetsAt: new Date(end).toISOString(),
      ...('tokens' in cfg.budget ? { tokensLeft: Math.max(0, cfg.budget.tokens - spent) } : {}) }],
  };
}
