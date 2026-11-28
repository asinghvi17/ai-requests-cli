import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callCost, priceOf, PRICES } from './prices.ts';
import { claudeSpent, codexRollouts, codexSpent } from './spent.ts';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'air-spent-'));
  dirs.push(d);
  return d;
};
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const jsonl = (file: string, lines: unknown[]) => {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
};
const near = (a: number | undefined, b: number) => assert.ok(a !== undefined && Math.abs(a - b) < 1e-12, `${a} != ${b}`);
const none = { input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 };

test('callCost prices each kind of token at the model\'s rates', () => {
  // A real Claude Code 2.1.311 session's totals (its `cost-state` line): Claude Code's own totalCostUSD was
  // 6.538590800000002, and the table gives the same.
  near(callCost('claude-opus-5-5', { input: 214, cacheWrite5m: 0, cacheWrite1h: 214_754, cacheRead: 15_795_014, output: 83_035 }), 6.5385908);
  near(callCost('claude-sonnet-5-5', { ...none, cacheWrite5m: 1e6 }), 2.5);
  near(callCost('claude-sonnet-5-5', { ...none, cacheRead: 1e6 }), 0.1);
  // Claude Haiku 5.5 prices a prompt over 100,000 tokens higher, cache reads included in its size
  near(callCost('claude-haiku-5-5', { ...none, input: 100_000 }), 0.01);
  near(callCost('claude-haiku-5-5', { ...none, input: 50_000, cacheRead: 60_000, output: 1000 }), (50_000 * 0.5 + 60_000 * 0.05 + 1000 * 2.5) / 1e6);
  near(callCost('claude-haiku-4-5-20251001', { ...none, output: 1e6 }), 5); // a date suffix is the same model
  near(callCost('claude-opus-5-5', { ...none, input: 1e6 }, { fast: true }), 8);
  assert.equal(callCost('claude-sonnet-5-5', { ...none, input: 1 }, { fast: true }), undefined); // no fast mode price
  near(callCost('claude-opus-5', { ...none, input: 1e6 }, { us: true }), 5.5);
  // OpenAI: cached input at its own rate, long-context rates above 272K prompt tokens
  near(callCost('gpt-5.3-codex', { ...none, input: 1e6, cacheRead: 1e6, output: 1e6 }), 1.75 + 0.175 + 14);
  near(callCost('gpt-5.4', { ...none, input: 1e6 }, { prompt: 300_000 }), 5);
  assert.equal(callCost('gpt-5.6-sol', { ...none, input: 1 }), undefined);
  // Every model `codex debug models` lists for the API (Codex 0.164.0) has a price, gpt-5.6-sol's promotion apart.
  for (const m of ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5']) assert.ok(priceOf(m), m);
  near(callCost('gpt-6-luna', { ...none, input: 1e6, cacheRead: 1e6, output: 1e6 }, { prompt: 100_000 }), 0.1 + 0.01 + 0.5);
  near(callCost('gpt-6-astra', { ...none, input: 1e6 }, { prompt: 300_000 }), 20);
  assert.equal(priceOf('claude-opus-5-5-preview'), undefined);
  for (const [model, p] of Object.entries(PRICES)) {
    for (const r of [p, ...(p.over ? [p.over.rates] : [])]) {
      assert.ok(Object.values(r).filter((v) => typeof v === 'number').every((v) => v > 0), model);
      assert.ok(r.cacheRead < r.input && r.output > r.input, model);
    }
  }
});

test('claudeSpent: every API call once at its model\'s price, the subagents included', () => {
  const config = tmp();
  const project = join(config, 'projects', '-home-me-air-o__r-12-abcdefgh');
  const call = (id: string, model: string, usage: object) => ({ type: 'assistant', uuid: `${id}-u`, message: { id, model, usage } });
  const big = {
    input_tokens: 2, cache_creation_input_tokens: 8072, cache_read_input_tokens: 12436, output_tokens: 260,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 8072 }, speed: 'standard', inference_geo: 'global',
  };
  jsonl(join(project, 's-1.jsonl'), [
    { type: 'user', message: { role: 'user', content: 'go' } },
    call('msg_a', 'claude-opus-5-5', big), call('msg_a', 'claude-opus-5-5', big), call('msg_a', 'claude-opus-5-5', big), // one response, three blocks
    call('msg_b', 'claude-sonnet-5-5', { input_tokens: 10, cache_creation_input_tokens: 100, output_tokens: 5 }), // no breakdown: 5-minute writes
    call('msg_x', '<synthetic>', { input_tokens: 0, output_tokens: 0 }), // an error placeholder, no API call
    call('msg_f', 'claude-opus-5-5', { input_tokens: 1000, output_tokens: 100, speed: 'fast' }),
    call('msg_g', 'claude-sonnet-5-5', { input_tokens: 1000, output_tokens: 0, inference_geo: 'us' }),
    '{"type":"assistant","message":', // cut off mid-write
  ]);
  jsonl(join(project, 's-1', 'subagents', 'agent-x.jsonl'), [call('msg_c', 'claude-haiku-4-5', { input_tokens: 1, output_tokens: 1 })]);
  jsonl(join(project, 's-2.jsonl'), [call('msg_d', 'claude-unknown-9', { input_tokens: 100, output_tokens: 0 }), call('msg_e', 'claude-opus-5-5', { input_tokens: 1000, output_tokens: 0 })]);
  jsonl(join(project, 'other.jsonl'), [call('msg_z', 'claude-opus-5-5', { input_tokens: 999_999, output_tokens: 1 })]);
  const s1 = (2 * 4 + 8072 * 8 + 12436 * 0.2 + 260 * 20) / 1e6 + (10 * 2 + 100 * 2.5 + 5 * 10) / 1e6 + (1000 * 4 + 100 * 20) * 2 / 1e6 + 1000 * 2 * 1.1 / 1e6 + 6 / 1e6;
  const one = claudeSpent(config, ['s-1'])!;
  near(one.usd, s1);
  assert.deepEqual(one.unpriced, []);
  const both = claudeSpent(config, ['s-1', 's-2', 's-1'])!;
  near(both.usd, s1 + 0.004);
  assert.deepEqual(both.unpriced, ['claude-unknown-9']); // its call is left out
  assert.equal(claudeSpent(config, ['missing']), undefined);
  assert.equal(claudeSpent(config, ['../projects']), undefined);
  assert.equal(claudeSpent(join(config, 'nope'), ['s-1']), undefined);
  assert.equal(claudeSpent(config, []), undefined);
});

test("codexSpent: each increase of a workspace session's running total, at the model then in use", () => {
  const home = tmp();
  const day = join(home, 'sessions', '2026', '11', '17');
  const meta = (id: string, cwd: string) => ({ timestamp: '2026-11-17T10:00:00Z', type: 'session_meta', payload: { id, cwd, cli_version: '0.164.0' } });
  const turn = (model: string) => ({ type: 'turn_context', payload: { cwd: '/ws', model } });
  const count = (input: number | null, cached = 0, output = 0, last = 0) => ({
    type: 'event_msg',
    payload: { type: 'token_count', info: input === null ? null : { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: 3, total_tokens: input + output }, last_token_usage: { input_tokens: last } } },
  });
  const at = (file: string, lines: unknown[], mins: number) => {
    jsonl(file, lines);
    const t = new Date(Date.now() - mins * 60_000);
    utimesSync(file, t, t);
  };
  at(join(day, 'rollout-a1.jsonl'), [meta('a', '/ws'), turn('gpt-5.3-codex'), count(null), count(1000, 200, 100), { type: 'response_item', payload: {} }, count(2500, 1000, 300)], 30);
  // the same session resumed into another file: what it already counted isn't counted again
  at(join(day, 'rollout-a2.jsonl'), [meta('a', '/ws'), turn('gpt-5.3-codex'), count(2500, 1000, 300), count(3000, 1000, 400)], 20);
  at(join(day, 'rollout-b.jsonl'), [meta('b', '/ws'), turn('gpt-9-unknown'), count(400, 0, 10)], 10);
  at(join(day, 'rollout-c.jsonl'), [meta('c', '/elsewhere'), turn('gpt-5.3-codex'), count(99_999, 0, 1)], 10);
  // a prompt over 272K tokens is priced at gpt-5.4's long-context rates
  at(join(day, 'rollout-d.jsonl'), [meta('d', '/ws'), turn('gpt-5.4'), count(300_000, 0, 0, 300_000)], 5);
  const old = join(day, 'rollout-e.jsonl');
  at(old, [meta('e', '/ws'), turn('gpt-5.3-codex'), count(50_000, 0, 0)], 26 * 60);
  const since = new Date(Date.now() - 3600_000);
  const a = (800 * 1.75 + 200 * 0.175 + 100 * 14) + (700 * 1.75 + 800 * 0.175 + 200 * 14) + (500 * 1.75 + 100 * 14);
  const s = codexSpent(home, '/ws', since)!;
  near(s.usd, a / 1e6 + 300_000 * 5 / 1e6);
  assert.deepEqual(s.unpriced, ['gpt-9-unknown']);
  assert.equal(codexSpent(home, '/nowhere', since), undefined);
  assert.equal(codexSpent(join(home, 'nope'), '/ws', since), undefined);
  assert.ok(!codexRollouts(home, since).includes(old));
});
