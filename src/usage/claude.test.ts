import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseClaudeUsage, readClaude } from './claude.ts';

const fixtures = join(import.meta.dirname, 'fixtures');
const recorded = join(fixtures, 'claude-usage.stream.jsonl');
const fake = join(fixtures, 'fake-claude.ts');

test('parses the recorded /usage stream into session, weekly and per-model windows', () => {
  assert.deepEqual(parseClaudeUsage(readFileSync(recorded, 'utf8')), [
    { name: 'five_hour', kind: 'five_hour', usedPct: 30, resetsAt: '2026-11-07T21:00:00.206Z' },
    { name: 'seven_day', kind: 'weekly', usedPct: 46, resetsAt: '2026-11-08T17:00:00.206Z' },
    { name: 'seven_day_fable', kind: 'weekly', usedPct: 0, resetsAt: '2026-11-08T17:00:00.000Z', scope: 'Fable' },
  ]);
});

test('ignores other events, bad rows and unknown kinds', () => {
  const ev = (limits: unknown) => JSON.stringify({ type: 'assistant', local_command_run: { command: 'usage' }, usage_report: { rate_limits: { limits } } });
  const text = [
    'not json',
    JSON.stringify({ type: 'assistant', local_command_run: { command: 'cost' }, usage_report: { rate_limits: { limits: [{ kind: 'session', percent: 9 }] } } }),
    ev([{ kind: 'session', percent: -1 }, { kind: 'weekly_all', percent: 'x' }, { kind: 'mystery', percent: 5 },
      { kind: 'weekly_scoped', percent: 5, scope: null }, { kind: 'session', percent: 12, resets_at: 'garbage' }]),
  ].join('\n');
  assert.deepEqual(parseClaudeUsage(text), [{ name: 'five_hour', kind: 'five_hour', usedPct: 12, resetsAt: null }]);
});

function fakeEnv(extra: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'air-claude-test-'));
  const seen = join(dir, 'seen');
  writeFileSync(seen, '');
  return { seen, env: { PATH: process.env.PATH ?? '', FAKE_CLAUDE_OUTPUT: recorded, FAKE_CLAUDE_SEEN: seen, ...extra } };
}

test('readClaude runs the CLI with the subscription config dir', async () => {
  const { env, seen } = fakeEnv();
  const r = await readClaude({ bin: fake, env, configDir: '/home/v/.claude-work' });
  assert.equal(r.windows.length, 3);
  assert.equal(r.note, undefined);
  assert.deepEqual(readFileSync(seen, 'utf8').trim().split('\n'), ['/home/v/.claude-work --version', '/home/v/.claude-work -p']);
});

test('readClaude explains old CLIs, failures and empty reports', async () => {
  assert.match((await readClaude({ bin: fake, env: fakeEnv({ FAKE_CLAUDE_VERSION: '2.1.279' }).env })).note!, /need 2\.1\.280/);
  assert.match((await readClaude({ bin: fake, env: fakeEnv({ FAKE_CLAUDE_EXIT: '1' }).env })).note!, /failed/);
  const empty = join(mkdtempSync(join(tmpdir(), 'air-claude-test-')), 'empty.jsonl');
  writeFileSync(empty, '{"type":"result"}\n');
  assert.match((await readClaude({ bin: fake, env: fakeEnv({ FAKE_CLAUDE_OUTPUT: empty }).env })).note!, /no limits/);
  assert.match((await readClaude({ bin: '/nonexistent/claude' })).note!, /cannot run/);
});
