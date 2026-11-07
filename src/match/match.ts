// Effort matching: pick the local subscription (if any) that takes a request. Pure: no I/O, `now` is injected.

import type { Subscription, Window } from '../usage/types.ts';

export type Effort = 'XS' | 'S' | 'M' | 'L' | 'XL';
export type Tier = 'small' | 'medium' | 'large';

export const EFFORTS: readonly Effort[] = ['XS', 'S', 'M', 'L', 'XL'];

/** Percent of one weekly window an effort is expected to cost, at scale 1. */
export const EFFORT_COST: Readonly<Record<Effort, number>> = { XS: 1, S: 3, M: 8, L: 20, XL: 40 };

/** Fraction of the primary window kept for the owner when a subscription sets none. */
export const DEFAULT_RESERVE = 0.3;
/** Harnesses a request can name and the server can run; `any` matches both. */
export const EXECUTABLE_HARNESSES: readonly string[] = ['claude', 'codex'];
/** Tolerance for percent arithmetic, so exact fits are not lost to float error. */
export const EPS = 1e-9;
export const DEFAULT_MAX_JOBS = 1;
export const FIVE_HOUR_LIMIT = 80;
export const TAPER_MS = 24 * 3600_000;
/** A monthly window is ~30/7 weeks, so the same work is a smaller share of it. */
export const MONTHLY_FACTOR = 7 / 30;

export interface Request {
  /** Anything but XS, S, M, L or XL exactly takes nothing. */
  effort: Effort | (string & {});
  /** claude, codex or any. `any` (or an empty/absent list) allows every harness. */
  harness?: string[];
  model?: Tier;
}

/** The `[subscriptions.<name>]` table of config.toml. */
export interface SubscriptionSettings {
  /** The agent harness this subscription funds. Required for `manual` subscriptions, which are matched like
   *  any other subscription of that harness; ignored for claude and codex readers (the reader's harness wins). */
  harness?: string;
  /** Cost multiplier relative to the reference (largest) plan: a smaller plan such as Pro sets 5, so every
   *  effort size costs 5x as much of its window. Default 1. */
  scale?: number;
  /** Fraction (0-1) of the primary window kept back. Default 0.3. */
  reserve?: number;
}

export interface MatchConfig {
  /** Per subscription name. */
  subscriptions?: Record<string, SubscriptionSettings>;
  /** `[models.<harness>]`: tier to model name. */
  models: Record<string, Partial<Record<Tier, string>>>;
  maxJobs?: number;
}

export interface Choice { subscription: Subscription; model: string; cost: number; reason: string }
export interface NoChoice { none: true; reasons: string[] }

export interface Verdict { ok: boolean; reason: string; headroom: number; cost: number; model?: string }

const fmt = (n: number): string => String(Math.round(n * 10) / 10);

export function canTakeMore(running: number, maxJobs: number = DEFAULT_MAX_JOBS): boolean {
  return running < maxJobs;
}

/** The window whose reset drives the decision: weekly (unscoped), else monthly. */
export function primaryWindow(sub: Subscription): Window | undefined {
  const unscoped = sub.windows.filter((w) => !w.scope);
  return unscoped.find((w) => w.kind === 'weekly') ?? unscoped.find((w) => w.kind === 'monthly');
}

/** Reserve in percent points: full until 24 h before reset, then linear to 0 at reset. */
export function reserveFor(base: number, resetsAt: string | null, now: Date): number {
  if (resetsAt === null) return base;
  const left = Date.parse(resetsAt) - now.getTime();
  if (Number.isNaN(left)) return base;
  return base * Math.min(1, Math.max(0, left / TAPER_MS));
}

const isEffort = (e: unknown): e is Effort => typeof e === 'string' && Object.hasOwn(EFFORT_COST, e);
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/** The agent harness a subscription's work runs on: a manual one funds the harness its config declares. */
export function effectiveHarness(sub: Subscription, config: MatchConfig): string | undefined {
  if (sub.harness !== 'manual') return sub.harness;
  return config.subscriptions?.[sub.name]?.harness;
}

export function costOf(effort: Effort, sub: Subscription, config: MatchConfig): number {
  const scale = config.subscriptions?.[sub.name]?.scale ?? 1;
  const factor = primaryWindow(sub)?.kind === 'monthly' ? MONTHLY_FACTOR : 1;
  return EFFORT_COST[effort] * scale * factor;
}

function harnessAllowed(harness: string, allowed: string[] | undefined): boolean {
  return !allowed || allowed.length === 0 || allowed.includes('any') || allowed.includes(harness);
}

/** Whether `sub` would take the work now. `tier` undefined skips the model check; `executable` requires a
 *  harness the server can run (claude or codex). */
export function evaluate(
  sub: Subscription, effort: Effort | string, allowed: string[] | undefined, tier: Tier | undefined,
  config: MatchConfig, now: Date,
): Verdict {
  const no = (reason: string, cost = NaN): Verdict => ({ ok: false, reason: `${sub.name}: ${reason}`, headroom: -Infinity, cost });
  if (!isEffort(effort)) return no(`unknown effort ${JSON.stringify(effort)}, takes nothing`);
  if (sub.stale) return no(`stale reading${sub.note ? ` (${sub.note})` : ''}, takes nothing`);
  if (sub.incomplete) return no(`incomplete reading${sub.note ? ` (${sub.note})` : ''}, takes nothing`);
  const harness = effectiveHarness(sub, config);
  if (harness === undefined || !EXECUTABLE_HARNESSES.includes(harness)) {
    return no(sub.harness === 'manual'
      ? 'manual subscription declares no harness (claude or codex), ignored'
      : `harness ${harness} cannot run requests, ignored`);
  }
  const settings = config.subscriptions?.[sub.name];
  const scale = settings?.scale ?? 1;
  const baseReserve = settings?.reserve ?? DEFAULT_RESERVE;
  if (!finite(scale) || scale <= 0) return no(`invalid scale ${scale}, takes nothing`);
  if (!finite(baseReserve) || baseReserve < 0) return no(`invalid reserve ${baseReserve}, takes nothing`);
  const cost = costOf(effort, sub, config);
  if (!harnessAllowed(harness, allowed)) return no(`harness ${harness} not allowed (wants ${allowed!.join(', ')})`, cost);
  let model: string | undefined;
  if (tier !== undefined) {
    model = Object.hasOwn(config.models, harness) && Object.hasOwn(config.models[harness]!, tier)
      ? config.models[harness]![tier] : undefined;
    if (!model) return no(`no ${tier} model configured for ${harness}`, cost);
  }
  const win = primaryWindow(sub);
  const label = win?.kind === 'monthly' ? 'monthly' : 'weekly';
  if (!win || !finite(win.usedPct) || win.usedPct < 0) return no(`${label} usage unknown, takes nothing`, cost);
  const left = 100 - win.usedPct;
  const reserve = reserveFor(baseReserve * 100, win.resetsAt, now);
  const headroom = left - cost - reserve;
  const why = `${label} ${fmt(left)}% left, needs ${fmt(cost)}% + ${fmt(reserve)}% reserve`;
  if (!Number.isFinite(headroom)) return no(`${label} usage unknown, takes nothing`, cost);
  // Round to 1e-9 so exact fits survive float error and ordering by headroom stays a strict weak order.
  const rounded = Math.round(headroom / EPS) * EPS;
  if (rounded < 0) return { ok: false, reason: `${sub.name}: ${why}`, headroom: rounded, cost };
  const fives = sub.windows.filter((w) => w.kind === 'five_hour' && !w.scope);
  for (const five of fives) {
    if (!finite(five.usedPct)) return { ok: false, reason: `${sub.name}: 5-hour window usage unknown, takes nothing`, headroom: rounded, cost };
    if (five.usedPct >= FIVE_HOUR_LIMIT) {
      return { ok: false, reason: `${sub.name}: 5-hour window ${fmt(five.usedPct)}% used (limit ${FIVE_HOUR_LIMIT}%)`, headroom: rounded, cost };
    }
  }
  return { ok: true, cost, headroom: rounded, model, reason: `${sub.name}: ${why}` };
}

function resetMs(sub: Subscription): number {
  const r = primaryWindow(sub)?.resetsAt;
  const t = r ? Date.parse(r) : NaN;
  return Number.isNaN(t) ? Infinity : t;
}

/** Earliest primary reset wins; ties go to most headroom, then name. */
export function choose(request: Request, subs: Subscription[], config: MatchConfig, now: Date): Choice | NoChoice {
  const tier = request.model ?? 'medium';
  const fits: { sub: Subscription; v: Verdict }[] = [];
  const reasons: string[] = [];
  for (const sub of subs) {
    const v = evaluate(sub, request.effort, request.harness, tier, config, now);
    if (v.ok) fits.push({ sub, v });
    else reasons.push(v.reason);
  }
  if (fits.length === 0) return { none: true, reasons };
  // Every fit has a finite headroom (evaluate guarantees it), so the comparator below never sees NaN.
  for (const f of fits) if (!Number.isFinite(f.v.headroom)) throw new Error(`non-finite headroom for ${f.sub.name}`);
  fits.sort((a, b) => {
    const ra = resetMs(a.sub);
    const rb = resetMs(b.sub);
    if (ra !== rb) return ra < rb ? -1 : 1;
    const ha = Math.round(a.v.headroom / EPS);
    const hb = Math.round(b.v.headroom / EPS);
    if (ha !== hb) return hb - ha;
    return a.sub.name < b.sub.name ? -1 : a.sub.name > b.sub.name ? 1 : 0;
  });
  const { sub, v } = fits[0]!;
  return { subscription: sub, model: v.model!, cost: v.cost, reason: v.reason };
}

/** Largest effort `sub` would accept now (any model), or null. Needs an executable harness. */
export function largestEffort(sub: Subscription, config: MatchConfig, now: Date): Effort | null {
  for (const e of [...EFFORTS].reverse()) {
    if (evaluate(sub, e, undefined, undefined, config, now).ok) return e;
  }
  return null;
}

// Calibration hook: the server logs these into claim comments so the effort table can be tuned.

export interface ActualRecord {
  issue: string;
  effort: Effort;
  /** Table cost at scale 1, percent of a weekly window. */
  expected: number;
  /** Percent points of the primary window actually consumed; null if not measurable. */
  delta: number | null;
  /** delta normalised by scale: comparable to `expected`. */
  share: number | null;
}

export function recordActual(
  issue: string, effort: Effort, before: Subscription, after: Subscription, config: MatchConfig = { models: {} },
): ActualRecord {
  const expected = EFFORT_COST[effort];
  const b = primaryWindow(before);
  const a = primaryWindow(after);
  const bu = b?.usedPct;
  const au = a?.usedPct;
  if (!finite(bu) || !finite(au) || before.stale || after.stale || before.incomplete || after.incomplete || b?.resetsAt !== a?.resetsAt || au < bu) {
    return { issue, effort, expected, delta: null, share: null };
  }
  const delta = au - bu;
  const scale = config.subscriptions?.[after.name]?.scale ?? 1;
  const factor = a?.kind === 'monthly' ? MONTHLY_FACTOR : 1;
  return { issue, effort, expected, delta, share: delta / (scale * factor) };
}
