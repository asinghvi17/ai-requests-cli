import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GhError } from '../gh/gh.ts';
import { fakeReleases } from '../gh/testing/releases-fake.ts';
import { createWorkspace } from '../workspace/state.ts';
import type { ServeContext } from './context.ts';
import { createServer, SWEEP_INTERVAL_MS } from './server.ts';
import { readServerState, updateServerState } from './state.ts';
import { KEEP_MS } from './tidy.ts';

const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const HOUR = 3600_000;

function setup() {
  const stateDir = mkdtempSync(join(tmpdir(), 'air-serve-sweep-'));
  const root = mkdtempSync(join(tmpdir(), 'air-serve-sweep-root-'));
  dirs.push(stateDir, root);
  const rel = fakeReleases();
  const asset = rel.addAsset('air-context', 'old.zip');
  rel.issueList.push({
    number: 1, state: 'closed', labels: ['ai-request'], closedAt: '2026-01-01T00:00:00Z',
    body: `---\nair: 0\neffort: S\ndeliver: comment\ncontext:\n  url: ${asset.url}\n  sha256: ${'a'.repeat(64)}\n  bytes: 1\n---\n`,
  });
  let now = new Date('2026-11-08T12:00:00Z');
  const lines: string[] = [];
  // Only what the sweep uses: the rest of the context is never touched by sweepIfDue.
  const ctx = {
    gh: { repo: 'o/requests' }, root, tmux: { panes: async () => [] }, stateDir, releases: rel, trust: async () => true, now: () => now, log: (m: string) => lines.push(m),
  } as unknown as ServeContext;
  return { ctx, rel, lines, stateDir, root, advance: (ms: number) => { now = new Date(now.getTime() + ms); }, now: () => now };
}

test('serve sweeps at most once per 24 h and persists the last run in serve.json', async () => {
  const s = setup();
  updateServerState(s.stateDir, { paused: true });
  const server = createServer(s.ctx);
  const first = server.sweepIfDue();
  assert.ok(first, 'never swept: due');
  assert.equal(server.sweepIfDue(), undefined, 'one at a time');
  await first;
  assert.deepEqual(s.rel.log, ['deleteAsset 1']);
  assert.ok(s.lines.includes('sweep: deleted 1, kept 0'));
  const state = readServerState(s.stateDir);
  assert.equal(state.lastSweepAt, '2026-11-08T12:00:00.000Z');
  assert.equal(state.paused, true, 'the pause flag survives');

  s.advance(23 * HOUR);
  assert.equal(server.sweepIfDue(), undefined);
  // A restarted server reads the persisted time.
  assert.equal(createServer(s.ctx).sweepIfDue(), undefined);
  s.advance(SWEEP_INTERVAL_MS - 23 * HOUR);
  const again = server.sweepIfDue();
  assert.ok(again);
  await again;
  assert.equal(readServerState(s.stateDir).lastSweepAt, s.now().toISOString());
});

test('a failing sweep only logs, and waits a day before trying again', async () => {
  const s = setup();
  s.rel.assets = async () => { throw new GhError('server', 'Server Error (HTTP 502)', 502); };
  const server = createServer(s.ctx);
  await server.sweepIfDue();
  assert.ok(s.lines.some((l) => /^sweep failed: Server Error \(HTTP 502\)$/.test(l)), s.lines.join('\n'));
  s.advance(HOUR);
  assert.equal(server.sweepIfDue(), undefined);
  s.advance(SWEEP_INTERVAL_MS);
  const retry = server.sweepIfDue();
  assert.ok(retry);
  await retry;
});

test('the daily sweep starts with the local cleanup: an ended workspace past its keep is removed, a recent one kept', async () => {
  const s = setup();
  const make = (issue: number, ago: number) => {
    const at = new Date(s.now().getTime() - ago).toISOString();
    return createWorkspace(s.root, {
      version: 1, repo: 'o/requests', issue, title: 't', author: 'a', url: 'u', host: 'box', nonce: 'aaaaaaaaaaaa', repos: [], phase: 'failed', createdAt: at, updatedAt: at,
    }, 'body');
  };
  const old = make(1, KEEP_MS + HOUR), recent = make(2, HOUR);
  await createServer(s.ctx).sweepIfDue();
  assert.equal(existsSync(old), false);
  assert.equal(existsSync(recent), true);
  assert.ok(s.lines.includes('cleanup: removed 1, kept 1 ended workspace(s) for debugging'), s.lines.join('\n'));
  assert.ok(s.lines.indexOf('sweep: deleted 1, kept 0') > s.lines.findIndex((l) => l.startsWith('cleanup: removed 1')), 'then the asset sweep');
});
