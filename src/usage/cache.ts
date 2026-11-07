// Reads are cached per subscription in the state dir: reused for REUSE_MS, stale after STALE_MS. The attempt is
// recorded before the read, so a failing CLI is not re-run on every call (the factory's UsageCache does the same).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Reading, Subscription, Window } from './types.ts';

export const REUSE_MS = 5 * 60000;
export const STALE_MS = 15 * 60000;

interface Entry { attemptedAt: number; readAt: number | null; windows: Window[]; note?: string }
type CacheFile = Record<string, Entry>;

const fileOf = (stateDir: string) => join(stateDir, 'usage-cache.json');
function load(stateDir: string): CacheFile {
  try { const v = JSON.parse(readFileSync(fileOf(stateDir), 'utf8')); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}
function save(stateDir: string, name: string, e: Entry) {
  mkdirSync(stateDir, { recursive: true });
  const all = { ...load(stateDir), [name]: e }; // reload: another air process may have written other entries
  const file = fileOf(stateDir);
  writeFileSync(`${file}.${process.pid}.next`, JSON.stringify(all) + '\n', { mode: 0o600 });
  renameSync(`${file}.${process.pid}.next`, file);
}

export function toSubscription(name: string, harness: string, e: Entry | undefined, now: number): Subscription {
  const readAt = e?.readAt ?? null;
  const stale = readAt == null || now - readAt > STALE_MS;
  return { name, harness, windows: e?.windows ?? [], readAt: readAt == null ? null : new Date(readAt).toISOString(), stale,
    ...(e?.note ? { note: e.note } : stale && readAt != null ? { note: 'reading is stale' } : {}) };
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
  const next: Entry = r.windows.length ? { attemptedAt: now, readAt: now, windows: r.windows }
    : { attemptedAt: now, readAt: prev?.readAt ?? null, windows: prev?.windows ?? [], note: r.note ?? 'no reading' };
  save(o.stateDir, o.name, next);
  return toSubscription(o.name, o.harness, next, now);
}

/** Windows as a scheduler must see them: a stale subscription's percentages are unknown. */
export function effectiveWindows(s: Subscription): Window[] {
  return s.stale ? s.windows.map(w => ({ ...w, usedPct: null, ...(w.tokensLeft !== undefined ? { tokensLeft: undefined } : {}) })) : s.windows;
}

/** Percent left in the tightest all-model window; null when any is unknown (or stale, or there are none).
 *  Model-scoped meters (`scope`) only bind that model and are left to the caller. */
export function headroomPct(s: Subscription): number | null {
  const ws = effectiveWindows(s).filter(w => !w.scope);
  if (!ws.length || ws.some(w => w.usedPct == null)) return null;
  return Math.max(0, Math.min(...ws.map(w => 100 - w.usedPct!)));
}
