// Effort matching: pick the local subscription (if any) that takes a request. Pure: no I/O, `now` is injected.
// Everything is in US dollars at API prices: an effort's cost (spec §2), a manual budget, and a subscription's
// primary window, which config.toml's `window_usd` says the worth of.

import { EFFORT_USD, EFFORTS, type Effort } from '../spec/frontmatter.ts';
import { usd } from '../usage/prices.ts';
import type { Subscription, Window } from '../usage/types.ts';

export { EFFORT_USD, EFFORTS, type Effort };
export type Tier = 'small' | 'medium' | 'large';

/** Harnesses a request can name and the server can run; `any` matches both. */
export const EXECUTABLE_HARNESSES: readonly string[] = ['claude', 'codex'];
/** Tolerance for dollar arithmetic, so exact fits are not lost to float error. */
export const EPS = 1e-9;
export const DEFAULT_MAX_JOBS = 1;
export const FIVE_HOUR_LIMIT = 80;
export const TAPER_MS = 24 * 3600_000;

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
  /** US dollars at API prices a full primary window of this plan is worth. Required for a subscription whose
   *  meter is a percentage (claude, codex); a manual one has its budget in dollars. */
  window_usd?: number;
  /** Fraction (0-1) of the primary window kept back (config.toml's default: DEFAULT_RESERVE). */
  reserve: number;
}

export interface MatchConfig {
  /** Per subscription name. */
  subscriptions?: Record<string, SubscriptionSettings>;
  /** `[models.<harness>]`: tier to model name. */
  models: Record<string, Partial<Record<Tier, string>>>;
  maxJobs?: number;
  /** Subscription name -> why it takes no new work (its agent can't run unattended). */
  refused?: Record<string, string>;
}

export interface Choice { subscription: Subscription; model: string; cost: number; reason: string }
/** `short`: the subscriptions that would take the request but for their budget. */
export interface NoChoice { none: true; reasons: string[]; short: Short[] }

/**
 * A subscription that turned work down for budget alone: its window is worth `size` dollars, `left` of it is
 * left, `reserve` of that is kept back (tapered), and the work costs `cost`. `fitsAt`: the smallest window size
 * that would take it with the same share used, when one would (less reserve can always make room).
 */
export interface Short { subscription: string; manual: boolean; size: number; left: number; reserve: number; cost: number; fitsAt?: number }

export interface Verdict { ok: boolean; reason: string; headroom: number; cost: number; model?: string; short?: Short }

const fmt = (n: number): string => String(Math.round(n * 10) / 10);
export function canTakeMore(running: number, maxJobs: number = DEFAULT_MAX_JOBS): boolean {
  return running < maxJobs;
}

/** The window whose reset drives the decision: weekly (unscoped), else monthly. */
export function primaryWindow(sub: Subscription): Window | undefined {
  const unscoped = sub.windows.filter((w) => !w.scope);
  return unscoped.find((w) => w.kind === 'weekly') ?? unscoped.find((w) => w.kind === 'monthly');
}

/** Reserve (in the unit of `base`): full until 24 h before reset, then linear to 0 at reset. */
export function reserveFor(base: number, resetsAt: string | null, now: Date): number {
  if (resetsAt === null) return base;
  const left = Date.parse(resetsAt) - now.getTime();
  if (Number.isNaN(left)) return base;
  return base * Math.min(1, Math.max(0, left / TAPER_MS));
}

const isEffort = (e: unknown): e is Effort => typeof e === 'string' && Object.hasOwn(EFFORT_USD, e);
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/** The agent harness a subscription's work runs on: a manual one funds the harness its config declares. */
export function effectiveHarness(sub: Subscription, config: MatchConfig): string | undefined {
  if (sub.harness !== 'manual') return sub.harness;
  return config.subscriptions?.[sub.name]?.harness;
}

/** What `sub`'s whole primary window is worth in dollars: a manual budget, else config.toml's `window_usd`. */
export function windowSize(sub: Subscription, config: MatchConfig): number | undefined {
  return sub.harness === 'manual' ? primaryWindow(sub)?.usdBudget : config.subscriptions?.[sub.name]?.window_usd;
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
  if (config.refused && Object.hasOwn(config.refused, sub.name)) return no(`not served: ${config.refused[sub.name]}`);
  const settings = config.subscriptions?.[sub.name];
  const cost = EFFORT_USD[effort];
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
  const size = windowSize(sub, config);
  // (A manual subscription has its table: it names its harness there.)
  if (size === undefined || settings === undefined) return no('no window_usd in config.toml, so its window has no dollar size; takes nothing', cost);
  if (!finite(size) || size <= 0) return no(`invalid window size $${size}, takes nothing`, cost);
  if (!finite(settings.reserve) || settings.reserve < 0) return no(`invalid reserve ${settings.reserve}, takes nothing`, cost);
  const left = ((100 - win.usedPct) / 100) * size;
  const reserve = reserveFor(settings.reserve * size, win.resetsAt, now);
  const headroom = left - cost - reserve;
  const why = `${label} ${usd(left)} left, needs ${usd(cost)} + ${usd(reserve)} reserve`;
  if (!Number.isFinite(headroom)) return no(`${label} usage unknown, takes nothing`, cost);
  // Round to 1e-9 so exact fits survive float error and ordering by headroom stays a strict weak order.
  const rounded = Math.round(headroom / EPS) * EPS;
  if (rounded < 0) {
    // Left and reserve are shares of the window, so a bigger window fits the cost when they leave room.
    const room = (left - reserve) / size;
    const short: Short = { subscription: sub.name, manual: sub.harness === 'manual', size, left, reserve, cost, ...(room > EPS ? { fitsAt: cost / room } : {}) };
    return { ok: false, reason: `${sub.name}: ${why}`, headroom: rounded, cost, short };
  }
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
  const short: Short[] = [];
  for (const sub of subs) {
    const v = evaluate(sub, request.effort, request.harness, tier, config, now);
    if (v.ok) fits.push({ sub, v });
    else reasons.push(v.reason);
    if (v.short) short.push(v.short);
  }
  if (fits.length === 0) return { none: true, reasons, short };
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

// Calibration: the final comment records each job's expected and measured cost, so the effort table can be tuned.

export interface ActualRecord {
  issue: string;
  effort: Effort;
  /** The effort's cost, US dollars. */
  expected: number;
  /** What the job cost at API prices; null if it couldn't be measured. */
  usd: number | null;
}
