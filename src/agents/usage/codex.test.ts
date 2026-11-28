import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCodexRateLimits, readCodex } from './codex.ts';

const fixtures = join(import.meta.dirname, 'fixtures');
const fake = join(fixtures, 'fake-codex.ts');
const env = (reply: string, extra: Record<string, string> = {}) =>
  ({ PATH: process.env.PATH ?? '', FAKE_CODEX_REPLY: join(fixtures, reply), ...extra });

test('maps primary/secondary windows by length', () => {
  const r = JSON.parse(readFileSync(join(fixtures, 'codex-rate-limits.json'), 'utf8')).result.rateLimits;
  assert.deepEqual(parseCodexRateLimits(r), [
    { name: 'five_hour', kind: 'five_hour', usedPct: 37, resetsAt: '2026-11-08T00:00:00.000Z' },
    { name: 'seven_day', kind: 'weekly', usedPct: 12, resetsAt: '2026-11-11T16:00:00.000Z' },
  ]);
  assert.deepEqual(parseCodexRateLimits({ primary: { usedPercent: 5, windowDurationMins: 43200 } }),
    [{ name: 'monthly', kind: 'monthly', usedPct: 5, resetsAt: null }]);
  assert.deepEqual(parseCodexRateLimits(null), []);
});

test('a reached limit with no full window marks the primary full', () => {
  const w = parseCodexRateLimits({ rateLimitReachedType: 'rate_limit_reached',
    primary: { usedPercent: 98, windowDurationMins: 300 }, secondary: { usedPercent: 40, windowDurationMins: 10080 } });
  assert.deepEqual(w.map(x => x.usedPct), [100, 40]);
});

test('readCodex reads account rate limits from the app-server with the subscription CODEX_HOME', async () => {
  const seen = join(mkdtempSync(join(tmpdir(), 'air-codex-test-')), 'seen');
  const r = await readCodex({ bin: fake, codexHome: '/nonexistent/codex-work', env: env('codex-rate-limits.json', { FAKE_CODEX_SEEN: seen }) });
  assert.equal(r.windows.length, 2);
  assert.equal(readFileSync(seen, 'utf8'), '/nonexistent/codex-work');
});

test('readCodex reports the not-logged-in error and timeouts', async () => {
  assert.equal((await readCodex({ bin: fake, env: env('codex-auth-required.json') })).note,
    'codex: codex account authentication required to read rate limits');
  assert.equal((await readCodex({ bin: fake, timeoutMs: 500, env: env('codex-rate-limits.json', { FAKE_CODEX_HANG: '1' }) })).note, 'codex: timeout');
  assert.match((await readCodex({ bin: '/nonexistent/codex' })).note!, /cannot run codex/);
});

test('a reply without the primary window is incomplete', async () => {
  const r = await readCodex({ bin: fake, env: env('codex-secondary-only.json') });
  assert.equal(r.incomplete, true);
  assert.match(r.note!, /no primary/);
});

test('the default environment carries no API keys or tokens', async () => {
  const secrets = { GH_TOKEN: 'x', GITHUB_TOKEN: 'x', OPENAI_API_KEY: 'x', ANTHROPIC_API_KEY: 'x' };
  const saved = { ...process.env };
  Object.assign(process.env, secrets);
  try { assert.equal((await readCodex({ bin: fake })).windows.length, 2); }
  finally { for (const k of Object.keys(secrets)) if (!(k in saved)) delete process.env[k]; }
});
