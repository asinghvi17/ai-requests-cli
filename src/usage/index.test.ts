import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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
    now, out: s => lines.push(s), err: s => errs.push(s), windowUsd: name => (name === 'work' ? 2000 : undefined),
    readers: {
      claude: async cfg => cfg.name === 'work' ? { windows: parseClaudeUsage(recorded) } : { windows: [], note: 'not logged in' },
      codex: async () => ({ windows: [], note: 'codex: timeout' }),
    },
  });
  return { run, lines, errs, state: join(dir, 'state') };
}

const subs = [
  { name: 'work', harness: 'claude', configDir: '/nonexistent/claude-work' },
  { name: 'home', harness: 'claude' },
  { name: 'codex', harness: 'codex' },
  { name: 'team', harness: 'manual', reset: { every: 'weekly', day: 1, utc: true }, budget: { usd: 200 } },
];

test('prints a table per subscription', async () => {
  const { run, lines } = setup(subs);
  assert.equal(await run([]), 0);
  assert.equal(lines.join('\n'), [
    'work (claude) · read <1m ago',
    '  WINDOW           LEFT                         RESETS IN',
    '  5-hour           70%                          2h 15m',
    '  Weekly           54% ($1080.00 of $2000.00)   22h 15m',
    '  Weekly (Fable)   100%                         22h 15m',
    'home (claude) · never read · STALE: treated as unknown · not logged in',
    '  no windows',
    'codex (codex) · never read · STALE: treated as unknown · codex: timeout',
    '  no windows',
    'team (manual) · read <1m ago',
    '  WINDOW   LEFT                        RESETS IN',
    '  Weekly   100% ($200.00 of $200.00)   1d 5h',
  ].join('\n'));
});

test('spend decrements a manual budget in dollars; --json prints subscriptions', async () => {
  const { run, lines } = setup(subs);
  assert.equal(await run(['spend', 'team', '50.5']), 0);
  assert.match(lines.pop()!, /Weekly {3}75% \(\$149\.50 of \$200\.00\)/);
  assert.equal(await run(['--json']), 0);
  const out = JSON.parse(lines.pop()!);
  assert.deepEqual(out.map((s: any) => [s.name, s.stale]), [['work', false], ['home', true], ['codex', true], ['team', false]]);
  assert.equal(out[3].windows[0].usdLeft, 149.5);
});

test('rejects bad arguments and config', async () => {
  const { run, errs } = setup(subs);
  assert.equal(await run(['spend', 'work', '5']), 2);
  for (const bad of ['Infinity', 'NaN', '-1', '', '1e400', '0x10']) assert.equal(await run(['spend', 'team', bad]), 2, bad);
  assert.equal(await run(['bogus']), 2);
  assert.equal(await run(['--nope']), 2);
  assert.equal(errs.length, 9);
  assert.equal(await setup([{ name: 'm', harness: 'manual', reset: { every: 'weekly', day: 9 }, budget: { usd: 1 } }]).run([]), 1);
  for (const budget of [{ tokens: 1 }, { percent: 100 }, { usd: 0 }, { usd: '5' }, { usd: 5, tokens: 1 }]) {
    const e = setup([{ name: 'm', harness: 'manual', reset: { every: 'weekly', day: 1 }, budget }]);
    assert.equal(await e.run([]), 1, JSON.stringify(budget));
    assert.match(e.errs[0]!, /budget must be \{ usd: N \}/);
  }
  assert.equal(await setup([{ name: 'a', harness: 'claude' }, { name: 'a', harness: 'codex' }]).run([]), 1);
  assert.deepEqual(loadConfig('/nonexistent/subscriptions.json').map(s => s.harness), ['claude', 'codex']);
});

test('span', () => {
  assert.deepEqual([span(30e3), span(14 * 60e3), span(134 * 60e3), span(76 * 3600e3), span(NaN)], ['<1m', '14m', '2h 14m', '3d 4h', '?']);
});

test('stale readings serialize no numbers in --json', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'air-usage-cmd-'));
  const config = join(dir, 'subscriptions.json');
  writeFileSync(config, JSON.stringify([{ name: 'work', harness: 'claude' }]));
  const lines: string[] = [];
  let ok = true;
  const run = (at: number) => usageCommand(['--json', '--config', config, '--state-dir', join(dir, 'state')], {
    now: at, out: s => lines.push(s),
    readers: { claude: async () => ok ? { windows: parseClaudeUsage(recorded) } : { windows: [], note: 'claude /usage failed' } } });
  await run(now);
  assert.equal(JSON.parse(lines.pop()!)[0].windows[0].usedPct, 30);
  ok = false;
  await run(now + 16 * 60000);
  const [s] = JSON.parse(lines.pop()!);
  assert.equal(s.stale, true);
  assert.deepEqual(s.windows.map((x: any) => x.usedPct), [null, null, null]);
});

test('a corrupt ledger: manual subscriptions read unknown until reset-ledger; plain reads never write it', async () => {
  const { run, lines, errs, state } = setup([subs[3]]);
  assert.equal(await run([]), 0);
  assert.deepEqual(readdirSync(state).filter(n => n.startsWith('manual-ledger')), []); // a read wrote nothing
  assert.equal(await run(['spend', 'team', '100']), 0);
  writeFileSync(join(state, 'manual-ledger.json'), '{"version": 3}');
  lines.length = 0;
  assert.equal(await run(['--json']), 0);
  const [s] = JSON.parse(lines.pop()!);
  assert.equal(s.stale, true);
  assert.equal(s.windows[0].usedPct, null);
  assert.match(s.note, /unsupported version 3.*reset-ledger/);
  assert.equal(await run([]), 0);
  assert.match(lines.pop()!, /team \(manual\) · never read · STALE.*\n  WINDOW .*\n  Weekly   \?  /);
  assert.equal(await run(['spend', 'team', '1']), 1);
  assert.match(errs.pop()!, /reset-ledger/);
  assert.equal(await run(['reset-ledger']), 0);
  assert.equal(await run(['spend', 'team', '1']), 0);
  assert.match(lines.pop()!, /\(\$199\.00 of \$200\.00\)/);
});
