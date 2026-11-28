import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseClaudeUsage, readClaude } from './claude.ts';
import { cliEnv } from './run.ts';

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
  const r = await readClaude({ bin: fake, env, configDir: '/nonexistent/claude-work' });
  assert.equal(r.windows.length, 3);
  assert.equal(r.note, undefined);
  assert.deepEqual(readFileSync(seen, 'utf8').trim().split('\n'), ['/nonexistent/claude-work --version', '/nonexistent/claude-work -p']);
});

test('readClaude explains old CLIs, failures and empty reports', async () => {
  assert.match((await readClaude({ bin: fake, env: fakeEnv({ FAKE_CLAUDE_VERSION: '2.1.279' }).env })).note!, /need 2\.1\.280/);
  assert.match((await readClaude({ bin: fake, env: fakeEnv({ FAKE_CLAUDE_EXIT: '1' }).env })).note!, /failed/);
  const empty = join(mkdtempSync(join(tmpdir(), 'air-claude-test-')), 'empty.jsonl');
  writeFileSync(empty, '{"type":"result"}\n');
  assert.match((await readClaude({ bin: fake, env: fakeEnv({ FAKE_CLAUDE_OUTPUT: empty }).env })).note!, /no limits/);
  assert.match((await readClaude({ bin: '/nonexistent/claude' })).note!, /cannot run/);
});

test('a reading without the all-model weekly limit is incomplete', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'air-claude-test-'));
  const only5h = join(dir, 'only5h.jsonl');
  writeFileSync(only5h, JSON.stringify({ type: 'assistant', local_command_run: { command: 'usage' }, usage_report: { rate_limits: { limits: [
    { kind: 'session', percent: 10, resets_at: '2026-11-07T21:00:00Z' },
    { kind: 'weekly_renamed', percent: 99, resets_at: '2026-11-08T17:00:00Z' }] } } }) + '\n');
  const r = await readClaude({ bin: fake, env: fakeEnv({ FAKE_CLAUDE_OUTPUT: only5h }).env });
  assert.equal(r.incomplete, true);
  assert.match(r.note!, /no weekly/);
  assert.deepEqual(r.windows.map(w => w.name), ['five_hour']);
});

test('keychain/keyring session variables pass through', () => {
  const keyring = { SECURITYSESSIONID: '186a7', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' };
  assert.deepEqual(cliEnv({ ...keyring, GH_TOKEN: 'x' }), keyring);
});

test('the CLI gets an allowlisted environment: no API keys or tokens', async () => {
  const secrets = { GH_TOKEN: 'x', GITHUB_TOKEN: 'x', OPENAI_API_KEY: 'x', ANTHROPIC_API_KEY: 'x', AWS_SECRET_ACCESS_KEY: 'x' };
  const env = cliEnv({ ...secrets, PATH: '/bin', HOME: '/nonexistent/home', CLAUDE_CONFIG_DIR: '/nonexistent/c', UNRELATED: '1' });
  assert.deepEqual(env, { PATH: '/bin', HOME: '/nonexistent/home', CLAUDE_CONFIG_DIR: '/nonexistent/c' });
  // the default (no `env` option) filters process.env; the fake exits 3 on any leaked secret
  const saved = { ...process.env };
  Object.assign(process.env, secrets);
  try { assert.equal((await readClaude({ bin: fake })).windows.length, 3); }
  finally { for (const k of Object.keys(secrets)) if (!(k in saved)) delete process.env[k]; }
});
