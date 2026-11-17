import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

test('claudeSpent: every API call once, the subagents included, from the transcripts of the given sessions', () => {
  const config = tmp();
  const project = join(config, 'projects', '-home-me-air-o__r-12-abcdefgh');
  const call = (id: string, usage: object) => ({ type: 'assistant', uuid: `${id}-u`, message: { id, model: 'claude-opus-5-5', usage } });
  const big = { input_tokens: 2, cache_creation_input_tokens: 8072, cache_read_input_tokens: 12436, output_tokens: 260, output_tokens_details: { thinking_tokens: 19 }, service_tier: 'standard' };
  jsonl(join(project, 's-1.jsonl'), [
    { type: 'user', message: { role: 'user', content: 'go' } },
    call('msg_a', big), call('msg_a', big), call('msg_a', big), // one response with three content blocks
    call('msg_b', { input_tokens: 10, output_tokens: 5 }),
    '{"type":"assistant","message":', // cut off mid-write
  ]);
  jsonl(join(project, 's-1', 'subagents', 'agent-x.jsonl'), [call('msg_c', { input_tokens: 1, output_tokens: 1 })]);
  jsonl(join(project, 's-2.jsonl'), [call('msg_d', { input_tokens: 100, output_tokens: 0 })]);
  jsonl(join(project, 'other.jsonl'), [call('msg_e', { input_tokens: 999_999, output_tokens: 1 })]);
  assert.equal(claudeSpent(config, ['s-1']), 2 + 8072 + 12436 + 260 + 15 + 2);
  assert.equal(claudeSpent(config, ['s-1', 's-2', 's-1']), 20_787 + 100);
  assert.equal(claudeSpent(config, ['missing']), undefined);
  assert.equal(claudeSpent(config, ['../projects']), undefined);
  assert.equal(claudeSpent(join(config, 'nope'), ['s-1']), undefined);
  assert.equal(claudeSpent(config, []), undefined);
});

test("codexSpent: each of the workspace's sessions at its largest running total", () => {
  const home = tmp();
  const day = join(home, 'sessions', '2026', '11', '17');
  const meta = (id: string, cwd: string) => ({ timestamp: '2026-11-17T10:00:00Z', type: 'session_meta', payload: { id, cwd, cli_version: '0.164.0' } });
  const count = (total: number | null) => ({
    type: 'event_msg',
    payload: { type: 'token_count', info: total === null ? null : { total_token_usage: { input_tokens: total - 10, cached_input_tokens: 5, output_tokens: 10, reasoning_output_tokens: 3, total_tokens: total }, last_token_usage: { total_tokens: 7 } }, rate_limits: { primary: { used_percent: 12 } } },
  });
  jsonl(join(day, 'rollout-2026-11-17T10-00-00-a.jsonl'), [meta('a', '/ws'), count(null), count(1000), { type: 'response_item', payload: {} }, count(2500)]);
  // the same session resumed into another file: counted once, at its largest
  jsonl(join(day, 'rollout-2026-11-17T11-00-00-a.jsonl'), [meta('a', '/ws'), count(2500), count(3000)]);
  jsonl(join(day, 'rollout-2026-11-17T12-00-00-b.jsonl'), [meta('b', '/ws'), count(400)]);
  jsonl(join(day, 'rollout-2026-11-17T12-30-00-c.jsonl'), [meta('c', '/elsewhere'), count(99_999)]);
  jsonl(join(day, 'rollout-2026-11-17T13-00-00-d.jsonl'), [meta('d', '/ws')]); // no call made yet
  const old = join(day, 'rollout-2026-11-01T00-00-00-e.jsonl');
  jsonl(old, [meta('e', '/ws'), count(50_000)]);
  const since = new Date(Date.now() - 3600_000);
  utimesSync(old, new Date(since.getTime() - 86_400_000), new Date(since.getTime() - 86_400_000));
  assert.equal(codexSpent(home, '/ws', since), 3000 + 400);
  assert.equal(codexSpent(home, '/nowhere', since), undefined);
  assert.equal(codexSpent(join(home, 'nope'), '/ws', since), undefined);
  assert.ok(!codexRollouts(home, since).includes(old));
});
