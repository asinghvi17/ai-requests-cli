import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Subscription } from '../usage/types.ts';
import { effectiveHarness, canTakeMore, choose, largestEffort, recordActual, reserveFor, type MatchConfig, type Request } from './match.ts';

const NOW = new Date('2026-01-10T00:00:00Z');
const inH = (h: number) => new Date(NOW.getTime() + h * 3600_000).toISOString();

function sub(name: string, o: {
  harness?: string; used?: number | null | undefined; incomplete?: boolean; reset?: string | null; five?: number; stale?: boolean; kind?: string;
} = {}): Subscription {
  const windows = [{ name: 'seven_day', kind: o.kind ?? 'weekly', usedPct: o.used === undefined ? 10 : o.used, resetsAt: o.reset === undefined ? inH(100) : o.reset }];
  if (o.five !== undefined) windows.push({ name: 'five_hour', kind: 'five_hour', usedPct: o.five, resetsAt: inH(2) });
  return { name, harness: o.harness ?? 'claude', windows, readAt: NOW.toISOString(), stale: o.stale ?? false, ...(o.incomplete ? { incomplete: true } : {}) };
}

const config: MatchConfig = {
  models: { claude: { small: 'haiku', medium: 'sonnet', large: 'opus' }, codex: { medium: 'gpt' } },
  subscriptions: { pro: { scale: 5 }, lowres: { reserve: 0.1 }, m1: { harness: 'claude' }, m2: { harness: 'bogus' } },
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

test('effort costs and fit boundary (weekly left - cost >= reserve)', () => {
  for (const [used, effort, ok] of [[62, 'M', true], [62.1, 'M', false], [69, 'XS', true], [69.1, 'XS', false],
    [30, 'XL', true], [30.1, 'XL', false], [50, 'L', true], [51, 'L', false], [67, 'S', true]] as const) {
    const r = choose({ effort }, [sub('a', { used })], config, NOW);
    assert.equal('none' in r, !ok, `${effort} at ${used}% used`);
  }
});

test('taper lets a nearly-expired sub take big work', () => {
  const s = (h: number) => sub('a', { used: 80, reset: inH(h) });
  assert.ok('none' in choose({ effort: 'L' }, [s(24)], config, NOW)); // 20 left < 20 + 30
  assert.ok('none' in choose({ effort: 'L' }, [s(12)], config, NOW)); // 20 < 20 + 15
  assert.ok(!('none' in choose({ effort: 'L' }, [s(0)], config, NOW))); // 20 >= 20 + 0
  assert.ok(!('none' in choose({ effort: 'S' }, [s(12)], config, NOW))); // 20 >= 3 + 15
});

test('scale multiplies cost', () => {
  const r = choose({ effort: 'M' }, [sub('pro', { used: 20 })], config, NOW); // cost 40, 80 left >= 70
  assert.ok(!('none' in r)); assert.equal(r.cost, 40);
  const n = choose({ effort: 'M' }, [sub('pro', { used: 31 })], config, NOW);
  assert.ok('none' in n); assert.equal(n.reasons[0], 'pro: weekly 69% left, needs 40% + 30% reserve');
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

test('monthly budgets use the same taper, cost against the monthly window', () => {
  const m = (used: number, h: number) => sub('m', { kind: 'monthly', used, reset: inH(h) });
  const r = choose(req({ effort: 'XL' }), [m(50, 100)], config, NOW); // cost 40*7/30 = 9.33, 50 left >= 39.33
  assert.ok(!('none' in r)); assert.ok(Math.abs(r.cost - 40 * 7 / 30) < 1e-9);
  assert.ok('none' in choose(req({ effort: 'XL' }), [m(62, 100)], config, NOW));
  assert.ok(!('none' in choose(req({ effort: 'XL' }), [m(62, 12)], config, NOW))); // reserve 15
});

test('none-fit reasons, one per subscription', () => {
  const n = choose(req(), [sub('sub2', { used: 75 }), sub('sub3', { used: 99 })], config, NOW);
  assert.ok('none' in n);
  assert.deepEqual(n.reasons, [
    'sub2: weekly 25% left, needs 8% + 30% reserve',
    'sub3: weekly 1% left, needs 8% + 30% reserve',
  ]);
});

test('largestEffort', () => {
  for (const [used, want] of [[0, 'XL'], [30, 'XL'], [31, 'L'], [51, 'M'], [63, 'S'], [67, 'S'], [68, 'XS'], [69, 'XS'], [71, null]] as const) {
    assert.equal(largestEffort(sub('a', { used }), config, NOW), want, `${used}`);
  }
});

test('recordActual', () => {
  const r = recordActual('o/r#1', 'M', sub('pro', { used: 10 }), sub('pro', { used: 50 }), config);
  assert.deepEqual(r, { issue: 'o/r#1', effort: 'M', expected: 8, delta: 40, share: 8 });
  const reset = recordActual('o/r#1', 'M', sub('a', { used: 90, reset: inH(1) }), sub('a', { used: 3, reset: inH(169) }));
  assert.equal(reset.delta, null);
  assert.equal(recordActual('i', 'S', sub('a', { stale: true }), sub('a')).delta, null);
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

test('exact fit survives float error (44.5% used, 744 minutes to reset, XL)', () => {
  const s = sub('a', { used: 44.5, reset: inH(744 / 60) });
  const r = choose({ effort: 'XL' }, [s], config, NOW); // left 55.5 = 40 + 15.5
  assert.ok(!('none' in r));
  assert.ok('none' in choose({ effort: 'XL' }, [sub('a', { used: 44.51, reset: inH(744 / 60) })], config, NOW));
});

test('headroom ties within epsilon fall back to name', () => {
  const r = choose(req(), [sub('b', { used: 10 + 1e-12 }), sub('a', { used: 10 })], config, NOW);
  assert.ok(!('none' in r)); assert.equal(r.subscription.name, 'a');
});

test('monthly reasons say monthly', () => {
  const n = choose(req(), [sub('m', { kind: 'monthly', used: 95 })], config, NOW);
  assert.ok('none' in n); assert.match(n.reasons[0]!, /^m: monthly 5% left/);
  const u = choose(req(), [sub('m', { kind: 'monthly', used: null })], config, NOW);
  assert.ok('none' in u); assert.match(u.reasons[0]!, /^m: monthly usage unknown/);
});

test('manual subscriptions fund the harness their config declares', () => {
  const m = (name: string) => sub(name, { harness: 'manual', kind: 'monthly', used: 10 });
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
});

test('largestEffort needs an executable harness', () => {
  assert.equal(largestEffort(sub('a', { harness: 'gemini' }), config, NOW), null);
});
