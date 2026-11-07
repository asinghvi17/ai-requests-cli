import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseClaudeUsage } from './claude.ts';
import { loadConfig, span, usageCommand } from './index.ts';

const recorded = readFileSync(join(import.meta.dirname, 'fixtures', 'claude-usage.stream.jsonl'), 'utf8');
const now = Date.parse('2026-11-07T18:45:00Z');

function setup(subs: unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'air-usage-cmd-'));
  const config = join(dir, 'subscriptions.json');
  writeFileSync(config, JSON.stringify(subs));
  const lines: string[] = [], errs: string[] = [];
  const run = (argv: string[]) => usageCommand([...argv, '--config', config, '--state-dir', join(dir, 'state')], {
    now, out: s => lines.push(s), err: s => errs.push(s),
    readers: {
      claude: async cfg => cfg.name === 'work' ? { windows: parseClaudeUsage(recorded) } : { windows: [], note: 'not logged in' },
      codex: async () => ({ windows: [], note: 'codex: timeout' }),
    },
  });
  return { run, lines, errs };
}

const subs = [
  { name: 'work', harness: 'claude', configDir: '/home/v/.claude-work' },
  { name: 'home', harness: 'claude' },
  { name: 'codex', harness: 'codex' },
  { name: 'team', harness: 'manual', reset: { every: 'weekly', day: 1, utc: true }, budget: { tokens: 2_000_000 } },
];

test('prints a table per subscription', async () => {
  const { run, lines } = setup(subs);
  assert.equal(await run([]), 0);
  assert.equal(lines.join('\n'), [
    'work (claude) · read <1m ago',
    '  WINDOW           LEFT   RESETS IN',
    '  5-hour           70%    2h 15m',
    '  Weekly           54%    22h 15m',
    '  Weekly (Fable)   100%   22h 15m',
    'home (claude) · never read · STALE: treated as unknown · not logged in',
    '  no windows',
    'codex (codex) · never read · STALE: treated as unknown · codex: timeout',
    '  no windows',
    'team (manual) · read <1m ago',
    '  WINDOW   LEFT              RESETS IN',
    '  Weekly   100% (2.0M tok)   1d 5h',
  ].join('\n'));
});

test('spend decrements a manual budget; --json prints subscriptions', async () => {
  const { run, lines } = setup(subs);
  assert.equal(await run(['spend', 'team', '500000']), 0);
  assert.match(lines.pop()!, /Weekly {3}75% \(1\.5M tok\)/);
  assert.equal(await run(['--json']), 0);
  const out = JSON.parse(lines.pop()!);
  assert.deepEqual(out.map((s: any) => [s.name, s.stale]), [['work', false], ['home', true], ['codex', true], ['team', false]]);
  assert.equal(out[3].windows[0].tokensLeft, 1_500_000);
});

test('rejects bad arguments and config', async () => {
  const { run, errs } = setup(subs);
  assert.equal(await run(['spend', 'work', '5']), 2);
  assert.equal(await run(['bogus']), 2);
  assert.equal(await run(['--nope']), 2);
  assert.equal(errs.length, 3);
  assert.equal(await setup([{ name: 'm', harness: 'manual', reset: { every: 'weekly', day: 9 }, budget: { tokens: 1 } }]).run([]), 1);
  assert.equal(await setup([{ name: 'a', harness: 'claude' }, { name: 'a', harness: 'codex' }]).run([]), 1);
  assert.deepEqual(loadConfig('/nonexistent/subscriptions.json').map(s => s.harness), ['claude', 'codex']);
});

test('span', () => {
  assert.deepEqual([span(30e3), span(14 * 60e3), span(134 * 60e3), span(76 * 3600e3), span(NaN)], ['<1m', '14m', '2h 14m', '3d 4h', '?']);
});
