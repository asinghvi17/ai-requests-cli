import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Subscription } from '../usage/types.ts';
import { effectiveHarness, canTakeMore, choose, largestEffort, reserveFor, windowSize, type MatchConfig, type Request } from './match.ts';

const NOW = new Date('2026-01-10T00:00:00Z');
const inH = (h: number) => new Date(NOW.getTime() + h * 3600_000).toISOString();

function sub(name: string, o: {
  harness?: string; used?: number | null | undefined; incomplete?: boolean; reset?: string | null; five?: number; stale?: boolean; kind?: string; usdBudget?: number;
} = {}): Subscription {
  const windows: Subscription['windows'] = [{ name: 'seven_day', kind: o.kind ?? 'weekly', usedPct: o.used === undefined ? 10 : o.used, resetsAt: o.reset === undefined ? inH(100) : o.reset, ...(o.usdBudget !== undefined ? { usdBudget: o.usdBudget } : {}) }];
  if (o.five !== undefined) windows.push({ name: 'five_hour', kind: 'five_hour', usedPct: o.five, resetsAt: inH(2) });
  return { name, harness: o.harness ?? 'claude', windows, readAt: NOW.toISOString(), stale: o.stale ?? false, ...(o.incomplete ? { incomplete: true } : {}) };
}

const config: MatchConfig = {
  models: { claude: { small: 'haiku', medium: 'sonnet', large: 'opus' }, codex: { medium: 'gpt' } },
  // Every readable test subscription's window is worth $1,000, so $1 is 0.1 points of it.
  subscriptions: {
    ...Object.fromEntries(['a', 'b', 'c', 'x', 's', 'u', 'i', 'm', 'sub2', 'sub3'].map((n) => [n, { window_usd: 1000 }])),
    pro: { window_usd: 100 }, lowres: { window_usd: 1000, reserve: 0.1 }, m1: { harness: 'claude' }, m2: { harness: 'bogus' },
  },
};
const req = (r: Partial<Request> = {}): Request => ({ effort: 'M', ...r });

test('canTakeMore', () => {
  for (const [running, max, want] of [[0, 1, true], [1, 1, false], [1, 2, true], [2, 2, false]] as const) {
    assert.equal(canTakeMore(running, max), want);
  }
  assert.equal(canTakeMore(0), true);
  assert.equal(canTakeMore(1), false);
});

test('reserve tapers linearly over the last 24h', () => {
  for (const [h, want] of [[48, 30], [24, 30], [12, 15], [0, 0], [-5, 0]] as const) {
    assert.equal(reserveFor(30, inH(h), NOW), want, `${h}h`);
  }
  assert.equal(reserveFor(30, null, NOW), 30);
});

test('effort costs and fit boundary in dollars (window left - cost >= reserve)', () => {
  // $1,000 window, $300 reserve: M ($10) fits with $310 left, XL ($100) with $400.
  for (const [used, effort, ok] of [[69, 'M', true], [69.1, 'M', false], [69.9, 'XS', true], [69.95, 'XS', false],
    [60, 'XL', true], [60.1, 'XL', false], [67, 'L', true], [67.1, 'L', false], [69.7, 'S', true]] as const) {
    const r = choose({ effort }, [sub('a', { used })], config, NOW);
    assert.equal('none' in r, !ok, `${effort} at ${used}% used`);
  }
  const r = choose({ effort: 'L' }, [sub('a')], config, NOW);
  assert.ok(!('none' in r)); assert.equal(r.cost, 30);
});

test('taper lets a nearly-expired sub take big work', () => {
  const s = (h: number) => sub('a', { used: 80, reset: inH(h) });
  assert.ok('none' in choose({ effort: 'XL' }, [s(24)], config, NOW)); // $200 left < $100 + $300
  assert.ok('none' in choose({ effort: 'XL' }, [s(12)], config, NOW)); // $200 < $100 + $150
  assert.ok(!('none' in choose({ effort: 'XL' }, [s(0)], config, NOW))); // $200 >= $100 + $0
  assert.ok(!('none' in choose({ effort: 'S' }, [s(12)], config, NOW))); // $200 >= $3 + $150
});

test('window_usd sizes a readable window; without it a subscription takes nothing', () => {
  const r = choose({ effort: 'M' }, [sub('pro', { used: 20 })], config, NOW); // $80 left >= $10 + $30
  assert.ok(!('none' in r)); assert.equal(r.cost, 10);
  const n = choose({ effort: 'M' }, [sub('pro', { used: 61 })], config, NOW);
  assert.ok('none' in n); assert.equal(n.reasons[0], 'pro: weekly $39.00 left, needs $10.00 + $30.00 reserve');
  const none = choose({ effort: 'XS' }, [sub('nosize', { used: 0 })], config, NOW);
  assert.ok('none' in none); assert.match(none.reasons[0]!, /^nosize: no window_usd in config\.toml/);
  assert.equal(windowSize(sub('pro'), config), 100);
  assert.equal(windowSize(sub('m1', { harness: 'manual', usdBudget: 50 }), config), 50);
});

test('per-subscription reserve', () => {
  assert.ok(!('none' in choose({ effort: 'M' }, [sub('lowres', { used: 80 })], config, NOW)));
});

test('harness filter', () => {
  const subs = [sub('c', { harness: 'claude' }), sub('x', { harness: 'codex' })];
  const pick = (harness?: string[]) => { const r = choose(req({ harness }), subs, config, NOW); return 'none' in r ? null : r.subscription.name; };
  assert.equal(pick(['codex']), 'x');
  assert.equal(pick(['claude']), 'c');
  assert.equal(pick(['any']), 'c');
  assert.equal(pick(undefined), 'c');
  const none = choose(req({ harness: ['claude'] }), [subs[1]!], config, NOW);
  assert.ok('none' in none); assert.match(none.reasons[0]!, /^x: harness codex not allowed/);
});

test('a subscription the preflight refused takes no work; the others still do', () => {
  const subs = [sub('c', { harness: 'claude', used: 0 }), sub('x', { harness: 'codex', used: 50 })];
  const r = choose(req(), subs, { ...config, refused: { c: "claude can't run unattended: it is not installed" } }, NOW);
  assert.ok(!('none' in r));
  assert.equal(r.subscription.name, 'x');
  const none = choose(req(), [subs[0]!], { ...config, refused: { c: "claude can't run unattended: it is not installed" } }, NOW);
  assert.ok('none' in none);
  assert.equal(none.reasons[0], "c: not served: claude can't run unattended: it is not installed");
});

test('model tier filter, default medium', () => {
  const subs = [sub('x', { harness: 'codex' })];
  const r = choose(req(), subs, config, NOW);
  assert.ok(!('none' in r)); assert.equal(r.model, 'gpt');
  const n = choose(req({ model: 'large' }), subs, config, NOW);
  assert.ok('none' in n); assert.equal(n.reasons[0], 'x: no large model configured for codex');
  const c = choose(req({ model: 'large' }), [sub('c')], config, NOW);
  assert.ok(!('none' in c)); assert.equal(c.model, 'opus');
});

test('5-hour window', () => {
  assert.ok('none' in choose(req(), [sub('a', { five: 80 })], config, NOW));
  assert.ok(!('none' in choose(req(), [sub('a', { five: 79.9 })], config, NOW)));
  const n = choose(req(), [sub('a', { five: 95 })], config, NOW);
  assert.ok('none' in n); assert.match(n.reasons[0]!, /^a: 5-hour window 95% used/);
});

test('stale and unknown take nothing', () => {
  const n = choose(req(), [sub('s', { stale: true }), sub('u', { used: null })], config, NOW);
  assert.ok('none' in n);
  assert.match(n.reasons[0]!, /^s: stale/); assert.match(n.reasons[1]!, /^u: .*unknown/);
  assert.equal(largestEffort(sub('s', { stale: true }), config, NOW), null);
});

test('earliest reset wins, then headroom, then name', () => {
  const name = (subs: Subscription[]) => { const r = choose(req(), subs, config, NOW); return 'none' in r ? null : r.subscription.name; };
  assert.equal(name([sub('a', { reset: inH(100) }), sub('b', { reset: inH(50) })]), 'b');
  assert.equal(name([sub('a', { used: 10 }), sub('b', { used: 5 })]), 'b');
  assert.equal(name([sub('b'), sub('a')]), 'a');
  assert.equal(name([sub('a', { reset: null }), sub('b', { reset: inH(500) })]), 'b');
});

test('monthly windows match the same way, with the same taper', () => {
  const m = (used: number, h: number) => sub('m', { kind: 'monthly', used, reset: inH(h) });
  const r = choose(req({ effort: 'XL' }), [m(50, 100)], config, NOW); // $500 left >= $100 + $300
  assert.ok(!('none' in r)); assert.equal(r.cost, 100);
  assert.ok('none' in choose(req({ effort: 'XL' }), [m(62, 100)], config, NOW));
  assert.ok(!('none' in choose(req({ effort: 'XL' }), [m(62, 12)], config, NOW))); // reserve $150
});

test('none-fit reasons, one per subscription', () => {
  const n = choose(req(), [sub('sub2', { used: 75 }), sub('sub3', { used: 99 })], config, NOW);
  assert.ok('none' in n);
  assert.deepEqual(n.reasons, [
    'sub2: weekly $250.00 left, needs $10.00 + $300.00 reserve',
    'sub3: weekly $10.00 left, needs $10.00 + $300.00 reserve',
  ]);
});

test('largestEffort', () => {
  for (const [used, want] of [[0, 'XL'], [60, 'XL'], [61, 'L'], [67, 'L'], [68, 'M'], [69, 'M'], [69.5, 'S'], [69.8, 'XS'], [70, null]] as const) {
    assert.equal(largestEffort(sub('a', { used }), config, NOW), want, `${used}`);
  }
});

test('unknown primary usage takes nothing (null, undefined, NaN, Infinity, negative)', () => {
  for (const used of [null, undefined, NaN, Infinity, -Infinity, -5]) {
    const s = sub('a'); s.windows[0]!.usedPct = used as number;
    const n = choose(req({ effort: 'XS' }), [s], config, NOW);
    assert.ok('none' in n, String(used)); assert.match(n.reasons[0]!, /^a: weekly usage unknown/);
    assert.equal(largestEffort(s, config, NOW), null);
  }
});

test('incomplete takes nothing, with its own reason', () => {
  const n = choose(req(), [sub('i', { incomplete: true, used: null })], config, NOW);
  assert.ok('none' in n); assert.match(n.reasons[0]!, /^i: incomplete reading/);
});

test('5-hour window: present but unknown takes nothing; absent does not apply', () => {
  for (const five of [null, NaN, Infinity]) {
    const s = sub('a', { five: 0 }); s.windows[1]!.usedPct = five as number;
    const n = choose(req(), [s], config, NOW);
    assert.ok('none' in n); assert.match(n.reasons[0]!, /^a: 5-hour window usage unknown/);
  }
  assert.ok(!('none' in choose(req(), [sub('a')], config, NOW)));
});

test('unknown or malformed effort takes nothing', () => {
  for (const effort of ['xl', 'XXL', '', 'M ', 'constructor', '__proto__', undefined, null, 5, {}]) {
    const n = choose({ effort } as unknown as Request, [sub('a', { used: 0 })], config, NOW);
    assert.ok('none' in n, String(effort)); assert.match(n.reasons[0]!, /^a: unknown effort/);
  }
});

test('exact fit survives float error (74.5% used, 744 minutes to reset, XL)', () => {
  const s = sub('a', { used: 74.5, reset: inH(744 / 60) });
  const r = choose({ effort: 'XL' }, [s], config, NOW); // left $255 = $100 + $155 reserve
  assert.ok(!('none' in r));
  assert.ok('none' in choose({ effort: 'XL' }, [sub('a', { used: 74.51, reset: inH(744 / 60) })], config, NOW));
});

test('headroom ties within epsilon fall back to name', () => {
  const r = choose(req(), [sub('b', { used: 10 + 1e-12 }), sub('a', { used: 10 })], config, NOW);
  assert.ok(!('none' in r)); assert.equal(r.subscription.name, 'a');
});

test('monthly reasons say monthly', () => {
  const n = choose(req(), [sub('m', { kind: 'monthly', used: 95 })], config, NOW);
  assert.ok('none' in n); assert.match(n.reasons[0]!, /^m: monthly \$50\.00 left/);
  const u = choose(req(), [sub('m', { kind: 'monthly', used: null })], config, NOW);
  assert.ok('none' in u); assert.match(u.reasons[0]!, /^m: monthly usage unknown/);
});

test('manual subscriptions fund the harness their config declares, from a budget in dollars', () => {
  const m = (name: string) => sub(name, { harness: 'manual', kind: 'monthly', used: 10, usdBudget: 1000 });
  assert.equal(effectiveHarness(m('m1'), config), 'claude');
  const ok = choose(req({ harness: ['claude'] }), [m('m1')], config, NOW);
  assert.ok(!('none' in ok)); assert.equal(ok.model, 'sonnet');
  assert.ok('none' in choose(req({ harness: ['codex'] }), [m('m1')], config, NOW));
  assert.ok('none' in choose(req({ harness: ['manual'] }), [m('m1')], config, NOW));
  const none = choose(req(), [m('m0'), m('m2')], config, NOW);
  assert.ok('none' in none);
  assert.match(none.reasons[0]!, /^m0: manual subscription declares no harness/);
  assert.match(none.reasons[1]!, /^m2: manual subscription declares no harness/);
  assert.equal(largestEffort(m('m0'), config, NOW), null);
  assert.equal(largestEffort(m('m1'), config, NOW), 'XL');
  // $50 budget, $30 spent: $20 left, $15 reserve: S ($3) fits, M ($10) doesn't
  const small = sub('m1', { harness: 'manual', used: 60, usdBudget: 50 });
  assert.equal(largestEffort(small, config, NOW), 'S');
  const n = choose(req(), [small], config, NOW);
  assert.ok('none' in n); assert.equal(n.reasons[0], 'm1: weekly $20.00 left, needs $10.00 + $15.00 reserve');
});

test('largestEffort needs an executable harness', () => {
  assert.equal(largestEffort(sub('a', { harness: 'gemini' }), config, NOW), null);
});
