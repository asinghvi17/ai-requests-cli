// Effort matching: pick the local subscription (if any) that takes a request. Pure: no I/O, `now` is injected.

import type { Subscription, Window } from '../usage/types.ts';

export type Effort = 'XS' | 'S' | 'M' | 'L' | 'XL';
export type Tier = 'small' | 'medium' | 'large';

export const EFFORTS: readonly Effort[] = ['XS', 'S', 'M', 'L', 'XL'];

/** Percent of one weekly window an effort is expected to cost, at scale 1. */
export const EFFORT_COST: Readonly<Record<Effort, number>> = { XS: 1, S: 3, M: 8, L: 20, XL: 40 };

export const DEFAULT_RESERVE = 30;
export const DEFAULT_MAX_JOBS = 1;
export const FIVE_HOUR_LIMIT = 80;
export const TAPER_MS = 24 * 3600_000;
/** A monthly window is ~30/7 weeks, so the same work is a smaller share of it. */
export const MONTHLY_FACTOR = 7 / 30;

export interface Request {
  effort: Effort;
  /** `any` (or an empty/absent list) allows every harness. */
  harness?: string[];
  model?: Tier;
}

export interface SubscriptionSettings {
  /** Multiple of the base plan's quota (a Pro plan is 5). Default 1. */
  scale?: number;
  /** Percent of the primary window kept back. Default 30. */
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

export function costOf(effort: Effort, sub: Subscription, config: MatchConfig): number {
  const scale = config.subscriptions?.[sub.name]?.scale ?? 1;
  const factor = primaryWindow(sub)?.kind === 'monthly' ? MONTHLY_FACTOR : 1;
  return EFFORT_COST[effort] * scale * factor;
}

function harnessAllowed(harness: string, allowed: string[] | undefined): boolean {
  return !allowed || allowed.length === 0 || allowed.includes('any') || allowed.includes(harness);
}

/** Whether `sub` would take the work now. `tier` undefined skips the model check. */
export function evaluate(
  sub: Subscription, effort: Effort, allowed: string[] | undefined, tier: Tier | undefined,
  config: MatchConfig, now: Date,
): Verdict {
  const cost = costOf(effort, sub, config);
  const no = (reason: string, headroom = -Infinity): Verdict => ({ ok: false, reason: `${sub.name}: ${reason}`, headroom, cost });
  if (sub.stale) return no(`stale reading${sub.note ? ` (${sub.note})` : ''}, takes nothing`);
  if (!harnessAllowed(sub.harness, allowed)) return no(`harness ${sub.harness} not allowed (wants ${allowed!.join(', ')})`);
  let model: string | undefined;
  if (tier !== undefined) {
    model = config.models[sub.harness]?.[tier];
    if (!model) return no(`no ${tier} model configured for ${sub.harness}`);
  }
  const win = primaryWindow(sub);
  if (!win || win.usedPct === null) return no('weekly usage unknown, takes nothing');
  const label = win.kind === 'monthly' ? 'monthly' : 'weekly';
  const left = 100 - win.usedPct;
  const reserve = reserveFor(config.subscriptions?.[sub.name]?.reserve ?? DEFAULT_RESERVE, win.resetsAt, now);
  const headroom = left - cost - reserve;
  const why = `${label} ${fmt(left)}% left, needs ${fmt(cost)}% + ${fmt(reserve)}% reserve`;
  if (headroom < 0) return no(why, headroom);
  const five = sub.windows.find((w) => w.kind === 'five_hour' && !w.scope);
  if (five && five.usedPct !== null && five.usedPct >= FIVE_HOUR_LIMIT) {
    return no(`5-hour window ${fmt(five.usedPct)}% used (limit ${FIVE_HOUR_LIMIT}%)`, headroom);
  }
  return { ok: true, cost, headroom, model, reason: `${sub.name}: ${why}` };
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
  fits.sort((a, b) => {
    const ra = resetMs(a.sub);
    const rb = resetMs(b.sub);
    if (ra !== rb) return ra < rb ? -1 : 1;
    if (a.v.headroom !== b.v.headroom) return b.v.headroom - a.v.headroom;
    return a.sub.name < b.sub.name ? -1 : a.sub.name > b.sub.name ? 1 : 0;
  });
  const { sub, v } = fits[0]!;
  return { subscription: sub, model: v.model!, cost: v.cost, reason: v.reason };
}

/** Largest effort `sub` would accept now (any harness, any model), or null. */
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
  if (bu == null || au == null || before.stale || after.stale || b?.resetsAt !== a?.resetsAt || au < bu) {
    return { issue, effort, expected, delta: null, share: null };
  }
  const delta = au - bu;
  const scale = config.subscriptions?.[after.name]?.scale ?? 1;
  const factor = a?.kind === 'monthly' ? MONTHLY_FACTOR : 1;
  return { issue, effort, expected, delta, share: delta / (scale * factor) };
}
