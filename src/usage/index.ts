// `air usage`: read every configured subscription and print a table per subscription.
// Config: a JSON array of SubscriptionConfig in <config dir>/subscriptions.json; without one, the default
// `claude` and `codex` logins. Readings and the manual ledger live in the state dir.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { cachedRead, effectiveWindows } from './cache.ts';
import { readClaude } from './claude.ts';
import { readCodex } from './codex.ts';
import { loadLedger, readManual, recordSpend, saveLedger } from './manual.ts';
import type { Reading, Subscription, SubscriptionConfig, Window } from './types.ts';

export type * from './types.ts';
export { readClaude, parseClaudeUsage } from './claude.ts';
export { readCodex, parseCodexRateLimits } from './codex.ts';
export { readManual, recordSpend, loadLedger, saveLedger } from './manual.ts';
export { cachedRead, effectiveWindows, headroomPct, REUSE_MS, STALE_MS } from './cache.ts';

const env = process.env;
export const stateDir = () => env.AIR_STATE_DIR || join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'air');
export const configFile = () => join(env.AIR_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'air'), 'subscriptions.json');
export const ledgerFile = (dir: string) => join(dir, 'manual-ledger.json');

export const DEFAULT_SUBSCRIPTIONS: SubscriptionConfig[] = [{ name: 'claude', harness: 'claude' }, { name: 'codex', harness: 'codex' }];

export function loadConfig(file: string): SubscriptionConfig[] {
  if (!existsSync(file)) return DEFAULT_SUBSCRIPTIONS;
  const v = JSON.parse(readFileSync(file, 'utf8'));
  const list = Array.isArray(v) ? v : v?.subscriptions;
  if (!Array.isArray(list)) throw new Error(`${file}: expected an array of subscriptions`);
  const names = new Set<string>();
  for (const s of list) {
    if (typeof s?.name !== 'string' || !s.name) throw new Error(`${file}: a subscription has no name`);
    if (names.has(s.name)) throw new Error(`${file}: duplicate subscription ${s.name}`);
    names.add(s.name);
    if (!['claude', 'codex', 'manual'].includes(s.harness)) throw new Error(`${file}: ${s.name}: unknown harness ${s.harness}`);
    if (s.harness === 'manual') {
      const r = s.reset, b = s.budget;
      if (!r || !['weekly', 'monthly'].includes(r.every) || !Number.isInteger(r.day)
        || (r.every === 'weekly' ? r.day < 0 || r.day > 6 : r.day < 1 || r.day > 28)) {
        throw new Error(`${file}: ${s.name}: reset must be { every: "weekly", day: 0-6 } or { every: "monthly", day: 1-28 }`);
      }
      if (!b || ('tokens' in b) === ('percent' in b) || !(Number(b.tokens ?? b.percent) > 0)) {
        throw new Error(`${file}: ${s.name}: budget must be { tokens: N } or { percent: N }`);
      }
    }
  }
  return list;
}

export interface ReadOpts {
  stateDir?: string; now?: number; refresh?: boolean;
  /** Test seam: replaces the CLI readers. */
  readers?: Partial<Record<'claude' | 'codex', (cfg: SubscriptionConfig) => Promise<Reading>>>;
}

export async function readSubscription(cfg: SubscriptionConfig, o: ReadOpts = {}): Promise<Subscription> {
  const dir = o.stateDir ?? stateDir();
  if (cfg.harness === 'manual') {
    const file = ledgerFile(dir), ledger = loadLedger(file);
    const sub = readManual(cfg, ledger, o.now);
    saveLedger(file, ledger); // persists a rollover
    return sub;
  }
  const read = o.readers?.[cfg.harness] ? () => o.readers![cfg.harness]!(cfg)
    : cfg.harness === 'claude' ? () => readClaude({ bin: cfg.bin, configDir: cfg.configDir })
    : () => readCodex({ bin: cfg.bin, codexHome: cfg.codexHome });
  return cachedRead({ name: cfg.name, harness: cfg.harness, stateDir: dir, read, now: o.now, refresh: o.refresh });
}

export const readAll = (cfgs: SubscriptionConfig[], o: ReadOpts = {}) => Promise.all(cfgs.map(c => readSubscription(c, o)));

/** `2h 14m`, `3d 4h`, `14m`, `<1m` (the factory's usage.ts `span`). */
export function span(ms: number): string {
  if (!Number.isFinite(ms)) return '?';
  const m = Math.floor(Math.max(0, ms) / 60000);
  if (m < 1) return '<1m';
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
}

/** `5-hour`, `Weekly`, `Weekly (Fable)`, `Monthly`, `90-minute`. */
export function windowTitle(w: Window): string {
  const base = w.kind === 'five_hour' ? '5-hour' : w.kind === 'weekly' ? 'Weekly' : w.kind === 'monthly' ? 'Monthly'
    : w.kind === 'daily' ? 'Daily' : /^\d+_min$/.test(w.kind) ? `${w.kind.split('_')[0]}-minute` : w.name.replace(/_/g, ' ');
  return w.scope ? `${base} (${w.scope})` : base;
}

const tokens = (n: number) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n));

export function formatTable(subs: Subscription[], now = Date.now()): string {
  const out: string[] = [];
  for (const s of subs) {
    const age = s.readAt ? `read ${span(now - Date.parse(s.readAt))} ago` : 'never read';
    out.push(`${s.name} (${s.harness}) · ${age}${s.stale ? ' · STALE: treated as unknown' : ''}${s.note ? ` · ${s.note}` : ''}`);
    const ws = effectiveWindows(s);
    if (!ws.length) { out.push('  no windows'); continue; }
    const rows = ws.map(w => {
      const left = w.usedPct == null ? '?' : `${Math.max(0, Math.round(100 - w.usedPct))}%`;
      const reset = w.resetsAt ? (Date.parse(w.resetsAt) > now ? span(Date.parse(w.resetsAt) - now) : 'reset due') : '?';
      return [windowTitle(w), w.tokensLeft !== undefined ? `${left} (${tokens(w.tokensLeft)} tok)` : left, reset];
    });
    const head = ['WINDOW', 'LEFT', 'RESETS IN'];
    const width = head.map((h, i) => Math.max(h.length, ...rows.map(r => r[i]!.length)));
    for (const r of [head, ...rows]) out.push('  ' + r.map((c, i) => i < r.length - 1 ? c.padEnd(width[i]!) : c).join('   ').trimEnd());
  }
  return out.join('\n');
}

const USAGE = `usage: air usage [--refresh] [--json] [--config FILE] [--state-dir DIR]
       air usage spend NAME AMOUNT   record spend against a manual subscription (its budget's unit)`;

/** `air usage`. Returns the exit code. */
export async function usageCommand(argv: string[], io: { out?: (s: string) => void; err?: (s: string) => void } & ReadOpts = {}): Promise<number> {
  const out = io.out ?? (s => console.log(s)), err = io.err ?? (s => console.error(s));
  let a;
  try {
    a = parseArgs({ args: argv, allowPositionals: true, options: {
      refresh: { type: 'boolean' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
      config: { type: 'string' }, 'state-dir': { type: 'string' } } });
  } catch (e) { err(`${(e as Error).message}\n${USAGE}`); return 2; }
  if (a.values.help) { out(USAGE); return 0; }
  const dir = a.values['state-dir'] ?? io.stateDir ?? stateDir();
  let cfgs: SubscriptionConfig[];
  try { cfgs = loadConfig(a.values.config ?? configFile()); } catch (e) { err((e as Error).message); return 1; }
  const [sub, ...rest] = a.positionals;
  if (sub === 'spend') {
    const cfg = cfgs.find(c => c.name === rest[0]);
    const amount = Number(rest[1]);
    if (!cfg || cfg.harness !== 'manual' || rest.length !== 2 || !(amount >= 0)) { err(`${USAGE}\n(NAME must be a manual subscription)`); return 2; }
    const file = ledgerFile(dir), ledger = loadLedger(file);
    recordSpend(cfg, ledger, amount, io.now);
    saveLedger(file, ledger);
    out(formatTable([readManual(cfg, ledger, io.now)], io.now));
    return 0;
  }
  if (sub !== undefined) { err(USAGE); return 2; }
  const subs = await readAll(cfgs, { ...io, stateDir: dir, refresh: a.values.refresh });
  out(a.values.json ? JSON.stringify(subs, null, 2) : formatTable(subs, io.now));
  return 0;
}
