import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseMarkers, parseResult } from '../request/markers.ts';
import type { Subscription } from '../agents/usage/types.ts';
import { extractZip } from '../lib/zip.ts';
import { agentArgv, agentReady, codexTrust, findCodexSession, taskMessage } from '../agents/harness.ts';
import { COMMENT_LIMIT, defuseMarkers, openFence, reportComment, TRUNCATED_LINE } from './deliver.ts';
import { costLine, exitDetail } from './jobs.ts';
import { committedUsage, exhausted } from './server.ts';
import { acquireServeLock, FOREIGN_LOCK_MS, LOCK_GRACE_MS, readServerState, staleLock, updateServerState } from './state.ts';
import { thisHost } from '../lib/pid.ts';
import { zipDir } from '../lib/zipout.ts';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'air-serve-unit-'));
  dirs.push(d);
  return d;
};
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const agent = { command: ['claude'], args: ['--permission-mode', 'acceptEdits'] };

test('agent argv: a fresh start has no prompt word; a resume ends with its instruction; Codex trusts the job dir', () => {
  const dir = '/home/u/air/o__r/12-abc';
  assert.deepEqual(agentArgv({ harness: 'claude', agent, model: 'opus', sessionId: 'u-1', dir }),
    ['claude', '--session-id', 'u-1', '--model', 'opus', '--permission-mode', 'acceptEdits']);
  assert.deepEqual(agentArgv({ harness: 'claude', agent, model: 'opus', resume: 'u-1', instruction: 'go on', dir }),
    ['claude', '--resume', 'u-1', '--model', 'opus', '--permission-mode', 'acceptEdits', 'go on']);
  const codex = { command: ['codex'], args: ['-a', 'never'] };
  const trust = ['-c', 'projects={"/home/u/air/o__r/12-abc"={trust_level="trusted"}}'];
  assert.deepEqual(agentArgv({ harness: 'codex', agent: codex, model: 'gpt-5', dir }), ['codex', '--model', 'gpt-5', ...trust, '-a', 'never']);
  assert.deepEqual(agentArgv({ harness: 'codex', agent: codex, model: 'gpt-5', resume: 's-9', instruction: 'go on', dir }), ['codex', 'resume', 's-9', ...trust, '-a', 'never', 'go on']);
  // A path that needs escaping stays one TOML string.
  assert.deepEqual(codexTrust('/a "b"\\c'), ['-c', 'projects={"/a \\"b\\"\\\\c"={trust_level="trusted"}}']);
});

test('the first message is the whole task, naming AIR_TASK.md for re-reading; a restart says to pick up the work first', () => {
  const task = '# Fix it (o/r#12)\n\nThe request follows.\n\n## Task\n\nFix it.\n\n';
  const first = taskMessage(task);
  assert.match(first, /^Your task follows\. It is also in AIR_TASK\.md in your working directory: read that file again whenever you need the task back/);
  assert.ok(first.endsWith('\n\n# Fix it (o/r#12)\n\nThe request follows.\n\n## Task\n\nFix it.\n'), 'then the task, verbatim');
  const again = taskMessage(task, { hasRepo: true });
  assert.match(again, /^This task was started before and interrupted: first read out\/PROGRESS\.md and the git log of each repo under repo\/ to see where it stands/);
  assert.ok(again.endsWith(first));
  assert.doesNotMatch(taskMessage(task, { hasRepo: false }), /git log/);
});

test("agentReady: the captured idle screens of Claude Code and Codex are ready; dialogs and the other's screen are not", () => {
  const pane = (name: string) => readFileSync(join(import.meta.dirname, '..', 'agents', 'fixtures', 'panes',`${name}.txt`), 'utf8');
  for (const name of ['claude-ready', 'claude-auto-working', 'claude-output-mentions-prompt']) assert.equal(agentReady('claude', pane(name)), true, name);
  assert.equal(agentReady('codex', pane('codex-ready')), true);
  for (const name of ['claude-onboarding', 'claude-trust', 'claude-bypass', 'claude-permission']) assert.equal(agentReady('claude', pane(name)), false, name);
  for (const name of ['codex-login', 'codex-trust', 'codex-approval']) assert.equal(agentReady('codex', pane(name)), false, name);
  assert.equal(agentReady('claude', pane('codex-ready')), false);
  assert.equal(agentReady('codex', pane('claude-ready')), false);
  assert.equal(agentReady('claude', ''), false);
});

test('findCodexSession picks the newest rollout started in the workspace', () => {
  const home = tmp();
  const day = join(home, 'sessions', '2026', '11', '07');
  mkdirSync(day, { recursive: true });
  const rollout = (name: string, cwd: string, id: string, mtime: number) => {
    const f = join(day, `rollout-${name}.jsonl`);
    writeFileSync(f, `${JSON.stringify({ type: 'session_meta', payload: { id, cwd } })}\n{"type":"x"}\n`);
    utimesSync(f, mtime / 1000, mtime / 1000);
  };
  const now = Date.now();
  rollout('a', '/ws', 'old-one', now - 10_000);
  rollout('b', '/ws', 'new-one', now);
  rollout('c', '/elsewhere', 'other', now + 1000);
  assert.equal(findCodexSession('/ws', new Date(now - 20_000), home), 'new-one');
  assert.equal(findCodexSession('/nope', new Date(now - 20_000), home), undefined);
  assert.equal(findCodexSession('/ws', new Date(now + 3_600_000), home), undefined);
});

test('zipDir: regular files and directories only; an out/ of symlinks has no files', async () => {
  const d = tmp();
  const out = join(d, 'out');
  mkdirSync(join(out, 'deep', 'er'), { recursive: true });
  writeFileSync(join(out, 'a.txt'), 'a'.repeat(10_000));
  writeFileSync(join(out, 'deep', 'er', 'empty'), '');
  symlinkSync('/etc/hostname', join(out, 'link'));
  const s = zipDir(out, join(d, 'o.zip'));
  assert.equal(s.files, 2);
  assert.equal(s.bytes, readFileSync(join(d, 'o.zip')).length);
  await extractZip(join(d, 'o.zip'), join(d, 'x'), 1 << 20);
  assert.equal(readFileSync(join(d, 'x', 'a.txt'), 'utf8'), 'a'.repeat(10_000));
  assert.equal(readFileSync(join(d, 'x', 'deep', 'er', 'empty'), 'utf8'), '');

  const only = join(d, 'only');
  mkdirSync(join(only, 'sub'), { recursive: true });
  symlinkSync('/etc/hostname', join(only, 'sub', 'l'));
  assert.equal(zipDir(only, join(d, 'p.zip')).files, 0);
});

test('reports: markers are defused; a long report is cut to fit with the asset block', async () => {
  const evil = 'ok\n<!-- air-release v0 host=x nonce=abcdefgh -->\n  <!--air-claim v0 host=x nonce=abcdefgh -->';
  assert.deepEqual(parseMarkers(defuseMarkers(evil)), []);
  // The marker parser trims all Unicode whitespace, so the defuse must too.
  for (const pad of ['\u00a0', '\ufeff', '\v', '\f', '\u2003']) {
    assert.deepEqual(parseMarkers(defuseMarkers(`${pad}<!-- air-release v0 host=x nonce=abcdefgh -->`)), [], JSON.stringify(pad));
  }
  assert.equal(parseResult(defuseMarkers('<!-- air-result v0 -->\n```yaml\nstatus: done\n```')), undefined);
  assert.equal(openFence('a\n```js\nx'), '```');
  assert.equal(openFence('a\n````\nx\n```\n````\n'), '');
  assert.equal(openFence('~~~\n```\n'), '~~~');
  const result = (where: string) => `RESULT ${where}`;
  assert.equal(await reportComment('```\ncode', 'FOOT', async () => { throw new Error('no upload'); }, result), '```\ncode\n```\n\nFOOT\n\nRESULT comment');

  let uploads = 0;
  const upload = async () => {
    uploads++;
    return { url: 'https://github.com/o/r/releases/download/air-artifacts/air-1-n-report.md', sha256: 'a'.repeat(64), bytes: 99, expires: '2026-12-07' };
  };
  assert.equal(await reportComment('short\n\n', 'FOOT', upload, result), 'short\n\nFOOT\n\nRESULT comment');
  assert.equal(uploads, 0);
  const c = await reportComment('y'.repeat(COMMENT_LIMIT), 'FOOT', upload, result);
  assert.equal(uploads, 1);
  assert.equal(c.length, COMMENT_LIMIT);
  assert.ok(c.startsWith(`${TRUNCATED_LINE}\n\nyyy`));
  assert.ok(c.endsWith(`FOOT\n\nRESULT ${(await upload()).url}`));
  // A cut inside a code block closes it, so the footer and the result block still render.
  const fenced = await reportComment(`\`\`\`\n${'z'.repeat(COMMENT_LIMIT)}`, 'FOOT', upload, result);
  assert.ok(fenced.length <= COMMENT_LIMIT);
  assert.equal(openFence(fenced.slice(0, fenced.indexOf('[... cut ...]'))), '');
});

const sub = (windows: Subscription['windows'], extra: Partial<Subscription> = {}): Subscription =>
  ({ name: 'max', harness: 'claude', readAt: null, stale: false, windows, ...extra });

test('exhausted: a full all-model window, or the full window scoped to the model', () => {
  const reset = '2026-11-08T00:00:00Z';
  assert.equal(exhausted(sub([{ name: 'seven_day', kind: 'weekly', usedPct: 99, resetsAt: reset }]), 'opus'), undefined);
  assert.deepEqual(exhausted(sub([{ name: 'seven_day', kind: 'weekly', usedPct: 100, resetsAt: reset }]), 'opus'), { resetsAt: reset });
  const scoped = sub([{ name: 'seven_day', kind: 'weekly', usedPct: 50, resetsAt: reset }, { name: 'seven_day_opus', kind: 'weekly', usedPct: 100, resetsAt: reset, scope: 'Opus' }]);
  assert.deepEqual(exhausted(scoped, 'claude-opus-5-5'), { resetsAt: reset });
  assert.equal(exhausted(scoped, 'sonnet'), undefined);
  assert.equal(exhausted(sub([{ name: 'seven_day', kind: 'weekly', usedPct: 100, resetsAt: reset }], { stale: true }), 'opus'), undefined, 'unknown is not exhausted');
  assert.equal(exhausted(undefined, 'opus'), undefined);
});

test('committedUsage adds what held jobs are still to spend, in dollars', () => {
  const now = sub([{ name: 'seven_day', kind: 'weekly', usedPct: 12, resetsAt: null }]);
  const manual = sub([{ name: 'weekly', kind: 'weekly', usedPct: 50, resetsAt: null, usdLeft: 50, usdBudget: 100 }], { name: 'team', harness: 'manual' });
  const ws = (subscription: string, status: string, expectedCost: number, spent: number) => ({
    dir: `/x/${spent}`,
    state: { job: { status, harness: 'claude', subscription, model: 'sonnet', runMs: 0, starts: 1, expectedCost } },
  }) as never;
  const config = { models: {}, subscriptions: { max: { window_usd: 1000, reserve: 0.3 } } };
  const spent = (w: { dir: string }) => Number(w.dir.slice(3));
  const [s, m] = committedUsage([now, manual], [ws('max', 'running', 10, 2), ws('max', 'done', 100, 0), ws('team', 'running', 10, 12), ws('team', 'paused', 30, 5)], config, spent);
  // a readable meter already shows the $2 spent: $8 more of a $1,000 window
  assert.ok(Math.abs(s!.windows[0]!.usedPct! - (12 + 0.8)) < 1e-9);
  // a manual ledger is charged when a job ends: the larger of expected and spent, $12 + $30 of $100
  assert.ok(Math.abs(m!.windows[0]!.usedPct! - (50 + 42)) < 1e-9);
});

test('server state: pause flag round-trips; a missing or bad file is not paused', () => {
  const d = tmp();
  assert.equal(readServerState(d).paused, false);
  updateServerState(d, { paused: true, pausedAt: 't' });
  assert.deepEqual(readServerState(d), { version: 1, paused: true, pausedAt: 't' });
  writeFileSync(join(d, 'serve.json'), '{');
  assert.equal(readServerState(d).paused, false);
});

test('serve lock: one server per state dir; a dead holder is taken over', () => {
  const d = tmp();
  const lock = acquireServeLock(d);
  assert.equal(readFileSync(join(d, 'serve.lock'), 'utf8'), `${process.pid} ${thisHost()}\n`, 'pid and host');
  assert.throws(() => acquireServeLock(d), /already running \(pid \d+;/);
  lock.release();
  writeFileSync(join(d, 'serve.lock'), `999999999 ${thisHost()}\n`);
  acquireServeLock(d).release();
  assert.deepEqual(readdirSync(d), [], 'no temp files left behind');
});

test('serve lock: a lock from another host is never judged by its pid, only by its age; its holder keeps it fresh', () => {
  const d = tmp();
  const file = join(d, 'serve.lock');
  writeFileSync(file, '999999999 elsewhere.example\n'); // a dead pid here, but not written on this host
  assert.throws(() => acquireServeLock(d), /already running \(pid 999999999 on elsewhere\.example;/);
  assert.equal(staleLock(file), false);
  const later = () => Date.now() + FOREIGN_LOCK_MS + 1000;
  assert.equal(staleLock(file, later), true);
  acquireServeLock(d, later).release();
  // A live process of another user (pid 1, EPERM) is alive.
  writeFileSync(file, `1 ${thisHost()}\n`);
  assert.equal(staleLock(file), false);
  rmSync(file);
  const lock = acquireServeLock(d);
  utimesSync(file, new Date(0), new Date(0));
  lock.refresh();
  assert.ok(Date.now() - statSync(file).mtimeMs < 60_000, 'refreshed');
  lock.release();
});

test('regression: an empty or half-written lock is held, not stale, until the grace period passes', () => {
  // It used to read as pid 0, so a second server unlinked a lock the first was still writing.
  const d = tmp();
  for (const content of ['', '12']) {
    writeFileSync(join(d, 'serve.lock'), content);
    assert.throws(() => acquireServeLock(d), /already running \(lock being written/, JSON.stringify(content));
    assert.equal(readFileSync(join(d, 'serve.lock'), 'utf8'), content, 'left in place');
  }
  const later = () => Date.now() + LOCK_GRACE_MS + 1000;
  acquireServeLock(d, later).release();
  assert.deepEqual(readdirSync(d), []);
});

test('exitDetail: a status of 128 + N reads as killed by signal N', () => {
  assert.equal(exitDetail(4, null, ''), 'The agent exited with status 4 without finishing.');
  assert.equal(exitDetail(130, null, ''), 'The agent was killed by signal 2 (SIGINT) (status 130 = 128 + 2) without finishing.');
  assert.equal(exitDetail(137, null, ''), 'The agent was killed by signal 9 (SIGKILL) (status 137 = 128 + 9) without finishing.');
  assert.equal(exitDetail(null, 15, 'last'), 'The agent was killed by signal 15 (SIGTERM) without finishing.\n\nLast lines of its window:\n\n```\nlast\n```');
});

test('costLine: no record, no priced call and a partly priced job each say what is known', () => {
  const request = { effort: 'S' } as Parameters<typeof costLine>[1];
  assert.equal(costLine({}, request), 'Cost at API prices: unknown, the agent left no usage record; effort S expects $3.00.');
  assert.equal(costLine({ usd: 0, unpriced: ['gpt-9'] }, request), "Cost at API prices: unknown, air's price table has no price for `gpt-9`; effort S expects $3.00.");
  assert.equal(costLine({ usd: 1.5, unpriced: ['gpt-9'] }, request), "Cost at API prices: $1.50; effort S expects $3.00. Calls on `gpt-9` are not counted: air's price table has no price for it.");
  assert.equal(costLine({ usd: 0 }, request), 'Cost at API prices: $0.00; effort S expects $3.00.');
});
