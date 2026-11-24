// `air serve` says loudly, once per episode, when requests wait only on budget, and rereads config.toml every
// tick (keeping the last good config when the file breaks). A server on fakes: GitHub in memory, no tmux.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTrust } from '../request/trust.ts';
import { parseConfig } from '../setup/config.ts';
import { fakeGitHub } from '../gh/testing/fake.ts';
import type { Short } from '../match/match.ts';
import type { Tmux } from '../tmux/tmux.ts';
import type { Subscription } from '../agents/usage/types.ts';
import type { ServeContext } from './context.ts';
import type { ListedIssue, ServeGitHub } from './github.ts';
import { budgetKeys, budgetNote, createServer } from './server.ts';

const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'air-budget-'));
  dirs.push(d);
  return d;
};

const body = (effort: string) => `---\nair: 0\neffort: ${effort}\ndeliver: comment\n---\n\n## Task\n\nSummarise it.\n\n## Done when\n\n- It is summarised.\n`;
const toml = (windowUsd: number | string) => `repo = "o/requests"\nmax_jobs = 2\n\n[subscriptions.claude]\nharness = "claude"\nwindow_usd = ${windowUsd}\nreserve = 0.3\n`;
const NOW = new Date('2026-11-20T12:00:00Z');
/** As in the trial: 70% of the weekly window used, 13 h before it resets (so a little over half the reserve is kept). */
const reading = (usedPct = 70): Subscription[] => [{
  name: 'claude', harness: 'claude', readAt: NOW.toISOString(), stale: false,
  windows: [{ name: 'seven_day', kind: 'weekly', usedPct, resetsAt: new Date(NOW.getTime() + 13 * 3600_000).toISOString() }],
}];

/** A manual-start server on fakes, with config.toml at `configFile` holding `toml(windowUsd)`. */
function world(windowUsd: number) {
  const gh = fakeGitHub();
  const root = tmp(), stateDir = tmp(), configFile = join(tmp(), 'config.toml');
  writeFileSync(configFile, toml(windowUsd));
  const logs: string[] = [], notices: (string | undefined)[] = [];
  let usage = reading();
  const tmux = { listJobs: async () => [], setNotice: async (t: string | undefined) => { notices.push(t); } } as unknown as Tmux;
  const ctx: ServeContext = {
    gh, api: { openRequests: async () => [...gh.issues.values()] as unknown as ListedIssue[] } as ServeGitHub, tmux,
    config: { ...parseConfig(toml(windowUsd)), workspace_root: root }, configFile, root, host: 'box', ghHost: 'github.com', env: process.env,
    stateDir, trust: createTrust(gh), usage: async () => usage, agentEnv: () => ({}), log: (s) => logs.push(s), now: () => NOW,
    stopGraceMs: 0, resumeCheckMs: 0, agentReadyMs: 0, claimWaitMs: 0,
  };
  const server = createServer(ctx, { manual: true });
  const tick = async () => {
    await server.tick();
    await server.idle();
  };
  return { gh, ctx, server, configFile, logs, notices, tick, use: (pct: number) => { usage = reading(pct); } };
}

const budgetLines = (logs: string[]) => logs.filter((l) => l.startsWith('budget: '));

test('budgetNote names the request, what each subscription lacks, and the exact keys and files to change', () => {
  const config = parseConfig(toml(20));
  const files = { config: '/Users/v/.config/air/config.toml', subscriptions: '/Users/v/.config/air/subscriptions.json' };
  const short: Short = { subscription: 'claude', manual: false, size: 20, left: 6, reserve: 3.06, cost: 3, fitsAt: 101.69 };
  assert.equal(budgetNote([{ issue: 21, effort: 'S', short: [short] }, { issue: 22, effort: 'M', short: [short] }], config, files),
    "budget: #21 (effort S, $3.00) and 1 more can't be taken only because of budget or reserve, so this server takes no work. " +
    'claude: $6.00 of its $20.00 window left, $3.06 of that kept as reserve, and #21 costs $3.00. ' +
    'Raise subscriptions.claude.window_usd (now 20: what the whole window is worth at API prices; $101.69 or more takes #21) ' +
    'or lower subscriptions.claude.reserve (now 0.3) in /Users/v/.config/air/config.toml. air serve rereads config.toml every tick.');
  const { fitsAt: _, ...full } = short;
  assert.match(budgetNote([{ issue: 21, effort: 'S', short: [full] }], config, files),
    /The window is used past its reserve: lower subscriptions\.claude\.reserve \(now 0\.3\) in \/Users\/v\/\.config\/air\/config\.toml, or wait for the window to reset\./);
  assert.match(budgetNote([{ issue: 21, effort: 'S', short: [{ ...short, manual: true }] }], config, files),
    /Raise its budget\.usd in \/Users\/v\/\.config\/air\/subscriptions\.json \(\$101\.69 or more takes #21; read at start, so restart air serve\)/);
});

test('requests that wait only on budget are said so once when that begins, with a status-bar notice while it lasts', async () => {
  const w = world(20); // the trial's default: $6 left, $3.25 reserve, S costs $3
  w.gh.addIssue({ number: 21, body: body('S') });
  await w.tick();
  await w.tick();
  await w.tick();
  const notes = budgetLines(w.logs);
  assert.equal(notes.length, 1, 'once, not every tick');
  assert.match(notes[0]!, /^budget: #21 \(effort S, \$3\.00\) can't be taken only because of budget or reserve/);
  assert.match(notes[0]!, new RegExp(`subscriptions\\.claude\\.window_usd \\(now 20: .*\\) or lower subscriptions\\.claude\\.reserve \\(now 0\\.3\\) in ${w.configFile.replace(/[.]/g, '\\.')}\\.`));
  assert.match(w.notices.at(-1)!, /^air takes no work: requests wait on budget; raise window_usd in .*config\.toml/);
  // The owner's use drops back (a new week): the state ends; when it begins again, it is said again.
  w.use(0);
  await w.tick();
  assert.ok(w.logs.some((l) => l.startsWith('#21: fits claude')));
  assert.equal(w.notices.at(-1), undefined, 'the notice is cleared');
  w.gh.addIssue({ number: 22, body: body('S') });
  w.use(70);
  await w.tick();
  await w.tick();
  assert.equal(budgetLines(w.logs).length, 2);
  assert.match(budgetLines(w.logs)[1]!, /^budget: #22 /);
});

test('the budget notice is logged again when what to change does, not while it stays the same', async () => {
  const w = world(20);
  w.gh.addIssue({ number: 21, body: body('S') });
  await w.tick();
  w.use(71); // the numbers move, the fix doesn't
  await w.tick();
  assert.equal(budgetLines(w.logs).length, 1);
  w.use(95); // used past the reserve: now only a lower reserve helps
  await w.tick();
  const notes = budgetLines(w.logs);
  assert.equal(notes.length, 2);
  assert.match(notes[1]!, /The window is used past its reserve: lower subscriptions\.claude\.reserve/);
  // Every subscription short of budget is named, each for the first request it turns down.
  const s = (subscription: string, fitsAt?: number): Short => ({ subscription, manual: false, size: 20, left: 6, reserve: 3, cost: 3, ...(fitsAt ? { fitsAt } : {}) });
  const waits = [{ issue: 21, effort: 'S', short: [s('claude', 100)] }, { issue: 22, effort: 'S', short: [s('claude', 100), s('work')] }];
  assert.equal(budgetKeys(waits), 'claude: window_usd, work: reserve');
  assert.match(budgetNote(waits, parseConfig(toml(20)), { config: 'c', subscriptions: 's' }), /claude: .*#21 costs .* work: .*#22 costs/);
});

test('the status-bar notice is cleared when the server stops', async () => {
  const w = world(20);
  w.gh.addIssue({ number: 21, body: body('S') });
  const stop = new AbortController();
  const running = w.server.run({ signal: stop.signal, tickMs: 10 });
  while (!w.notices.at(-1)) await new Promise((r) => setTimeout(r, 10));
  stop.abort();
  await running;
  assert.equal(w.notices.at(-1), undefined);
});

test('a request turned down for something else is not a budget wait', async () => {
  const w = world(500);
  w.gh.addIssue({ number: 23, body: body('S').replace('deliver: comment', 'deliver: comment\nharness: [codex]') });
  await w.tick();
  assert.ok(w.logs.some((l) => /^#23: no fit: claude: harness claude not allowed/.test(l)));
  assert.deepEqual(budgetLines(w.logs), []);
});

test('config.toml is reread every tick: a raised window_usd takes the waiting request without a restart', async () => {
  const w = world(20);
  w.gh.addIssue({ number: 21, body: body('S') });
  await w.tick();
  assert.ok(w.logs.some((l) => l.startsWith('#21: no fit: claude: weekly $6.00 left')));
  await w.tick();
  assert.ok(!w.logs.some((l) => l.startsWith('config: ')), 'an unchanged file is not reloaded');
  writeFileSync(w.configFile, toml(500));
  await w.tick();
  assert.ok(w.logs.includes(`config: reloaded ${w.configFile}`));
  assert.equal(w.ctx.config.subscriptions.claude!.window_usd, 500);
  assert.ok(w.logs.some((l) => /^#21: claimed \(nonce \w+\) for claude\/sonnet$/.test(l)), w.logs.join('\n'));
});

test('a config.toml that breaks keeps the last good config, logged once until it changes', async () => {
  const w = world(500);
  const root = w.ctx.config.workspace_root;
  writeFileSync(w.configFile, toml('"lots"'));
  await w.tick();
  await w.tick();
  const bad = w.logs.filter((l) => l.startsWith('config: '));
  assert.deepEqual(bad, [`config: ${w.configFile}: subscriptions.claude.window_usd must be a positive number (US dollars); keeping the config in use`]);
  assert.equal(w.ctx.config.subscriptions.claude!.window_usd, 500);
  rmSync(w.configFile);
  await w.tick();
  assert.match(w.logs.at(-1)!, /^config: .*config\.toml: ENOENT.*; keeping the config in use$/);
  writeFileSync(w.configFile, toml(800).replace('repo = "o/requests"\n', 'repo = "o/requests"\nworkspace_root = "/elsewhere"\n'));
  await w.tick();
  assert.equal(w.ctx.config.subscriptions.claude!.window_usd, 800);
  assert.ok(w.logs.includes('config: workspace_root changes to /elsewhere when air serve restarts'));
  assert.equal(w.ctx.config.workspace_root, root, 'workspace_root keeps its startup value');
});
