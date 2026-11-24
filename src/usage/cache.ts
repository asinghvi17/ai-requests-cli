// Reads are cached per subscription in the state dir: reused for REUSE_MS, stale after STALE_MS. The attempt is
// recorded before the read, so a failing CLI is not re-run on every call (the factory's UsageCache does the same).
// A stale or incomplete reading leaves this module with every number nulled: no caller can use one by mistake.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withLock, writeAtomic } from '../lib/index.ts';
import type { Reading, Subscription, Window } from './types.ts';

export const REUSE_MS = 5 * 60000;
export const STALE_MS = 15 * 60000;

interface Entry { attemptedAt: number; readAt: number | null; windows: Window[]; note?: string; incomplete?: boolean }
type CacheFile = Record<string, Entry>;

const fileOf = (stateDir: string) => join(stateDir, 'usage-cache.json');
function load(stateDir: string): CacheFile {
  try { const v = JSON.parse(readFileSync(fileOf(stateDir), 'utf8')); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}
function save(stateDir: string, name: string, e: Entry) {
  const file = fileOf(stateDir);
  // reload under the lock: another air process may have written other entries
  withLock(file, () => writeAtomic(file, JSON.stringify({ ...load(stateDir), [name]: e }) + '\n'));
}

/** Windows with the numbers removed: what unknown looks like. */
export const unknownWindows = (ws: Window[]): Window[] => ws.map(({ usdLeft, usdBudget, ...w }) => ({ ...w, usedPct: null }));

export function toSubscription(name: string, harness: string, e: Entry | undefined, now: number): Subscription {
  const readAt = e?.readAt ?? null;
  const stale = readAt == null || now - readAt > STALE_MS;
  const windows = e?.windows ?? [];
  const note = e?.note ?? (stale && readAt != null ? 'reading is stale' : undefined);
  return { name, harness, windows: stale || e?.incomplete ? unknownWindows(windows) : windows,
    readAt: readAt == null ? null : new Date(readAt).toISOString(), stale,
    ...(e?.incomplete ? { incomplete: true } : {}), ...(note ? { note } : {}) };
}

export async function cachedRead(o: {
  name: string; harness: string; stateDir: string; read: () => Promise<Reading>; now?: number; refresh?: boolean;
}): Promise<Subscription> {
  const now = o.now ?? Date.now();
  const prev = load(o.stateDir)[o.name];
  if (prev && !o.refresh && now - prev.attemptedAt < REUSE_MS) return toSubscription(o.name, o.harness, prev, now);
  save(o.stateDir, o.name, { ...(prev ?? { readAt: null, windows: [] }), attemptedAt: now });
  let r: Reading;
  try { r = await o.read(); } catch (e) { r = { windows: [], note: `reader failed: ${(e as Error).message}` }; }
  // A failed read keeps the last good windows; they age into `stale` on their own.
  const next: Entry = r.windows.length
    ? { attemptedAt: now, readAt: now, windows: r.windows, ...(r.incomplete ? { incomplete: true, note: r.note ?? 'incomplete reading' } : {}) }
    : { attemptedAt: now, readAt: prev?.readAt ?? null, windows: prev?.windows ?? [], ...(prev?.incomplete ? { incomplete: true } : {}), note: r.note ?? 'no reading' };
  save(o.stateDir, o.name, next);
  return toSubscription(o.name, o.harness, next, now);
}

/** Windows as a scheduler must see them. Subscriptions from this module already carry nulls when stale or
 *  incomplete; this also guards hand-built ones. */
export function effectiveWindows(s: Subscription): Window[] {
  return s.stale || s.incomplete ? unknownWindows(s.windows) : s.windows;
}

/** Percent left in the tightest all-model window; null when any is unknown (or stale, or there are none).
 *  Model-scoped meters (`scope`) only bind that model and are left to the caller. */
export function headroomPct(s: Subscription): number | null {
  const ws = effectiveWindows(s).filter(w => !w.scope);
  if (!ws.length || ws.some(w => w.usedPct == null)) return null;
  return Math.max(0, Math.min(...ws.map(w => 100 - w.usedPct!)));
}
