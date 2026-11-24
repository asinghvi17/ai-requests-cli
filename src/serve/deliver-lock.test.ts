// Delivery is single-entry: `air serve` and `air start N` racing on a job whose agent created AIR_DONE never
// both push, upload or comment. The loser of the workspace's delivery lock backs off and leaves the job alone.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claim } from '../claim/claim.ts';
import { thisHost } from '../lib/pid.ts';
import { createTrust } from '../claim/trust.ts';
import type { Config } from '../config.ts';
import { fakeGitHub } from '../gh/fake.ts';
import type { Tmux } from '../tmux/tmux.ts';
import { DONE_FILE } from '../workspace/task.ts';
import { updateState } from '../workspace/state.ts';
import type { ServeContext } from './context.ts';
import type { Release, ServeGitHub } from './github.ts';
import { DELIVERY_LOCK, finishJob, startOrDeliver } from './jobs.ts';

const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'air-deliver-lock-'));
  dirs.push(d);
  return d;
};

const BODY = '---\nair: 0\neffort: XS\ndeliver: artifact\n---\n\n## Task\n\nMake a file.\n\n## Done when\n\n- out/ has it.\n';

/** Issue 7 held by this server, its agent done (AIR_DONE, out/result.txt), paused; uploads counted and slow. */
async function finished() {
  const gh = fakeGitHub();
  gh.addIssue({ number: 7, body: BODY });
  const root = tmp();
  const won = await claim({ gh, issue: 7, root, host: 'box', waitMs: 0, nonce: 'aaaaaaaaaaaa' });
  if (won.status !== 'won') throw new Error('should win');
  updateState(won.dir, { phase: 'ready', job: { status: 'paused', pauseReason: 'operator', harness: 'claude', subscription: 'max', model: 'sonnet', runMs: 0, starts: 1 } }, new Date());
  writeFileSync(join(won.dir, 'out', 'result.txt'), 'the result\n');
  writeFileSync(join(won.dir, DONE_FILE), '');
  const uploads: string[] = [];
  const release: Release = { id: 1, uploadUrl: 'https://uploads.example/1', assets: [] };
  const api = {
    release: async () => release,
    async uploadAsset(_r: Release, name: string) {
      uploads.push(name);
      await new Promise((r) => setTimeout(r, 50)); // the other delivery runs meanwhile
      return { id: uploads.length, url: `https://example/${name}` };
    },
  } as unknown as ServeGitHub;
  const ctx: ServeContext = {
    gh, api, tmux: { listJobs: async () => [], stopJob: async () => {} } as unknown as Tmux, config: {} as Config,
    root, host: 'box', ghHost: 'github.com', env: process.env, stateDir: tmp(), trust: createTrust(gh),
    usage: async () => [], agentEnv: () => ({}), log: () => {}, now: () => new Date(), stopGraceMs: 0, resumeCheckMs: 0, agentReadyMs: 0,
  };
  const comments = () => gh.log.filter((l) => l === 'comment 7').length;
  return { gh, ctx, dir: won.dir, uploads, comments, before: comments() };
}

test('air serve and air start N delivering one job at once: one upload, one result comment', async () => {
  const { ctx, dir, uploads, comments, before } = await finished();
  const [server, cli] = await Promise.all([finishJob(ctx, dir), startOrDeliver(ctx, dir)]);
  assert.equal(server, 'delivered');
  assert.equal(cli, 'delivering-elsewhere');
  assert.deepEqual(uploads, ['air-7-aaaaaaaaaaaa.zip']);
  assert.equal(comments() - before, 1);
  assert.equal(existsSync(dir), false, 'the delivered workspace is removed, its lock with it');
});

test('a delivery lock held by another live process: back off, nothing written', async () => {
  const { ctx, dir, uploads, comments, before } = await finished();
  const other = spawn('sleep', ['30']);
  try {
    writeFileSync(join(dir, DELIVERY_LOCK), `${other.pid} ${thisHost()}\n`);
    assert.equal(await finishJob(ctx, dir), 'delivering-elsewhere');
    assert.deepEqual(uploads, []);
    assert.equal(comments() - before, 0);
  } finally {
    other.kill();
  }
});

test('a delivery lock left by a dead process is taken over', async () => {
  const { ctx, dir, uploads, comments, before } = await finished();
  const dead = spawnSync('sh', ['-c', 'echo $$']).stdout.toString().trim();
  writeFileSync(join(dir, DELIVERY_LOCK), `${dead} ${thisHost()}\n`);
  assert.equal(await finishJob(ctx, dir), 'delivered');
  assert.equal(uploads.length, 1);
  assert.equal(comments() - before, 1);
});

test('the workspace is removed inside the lock, after its window is closed; a process that comes after finds it finished', async () => {
  const { ctx, dir, comments, before } = await finished();
  const seen: string[] = [];
  ctx.tmux = {
    listJobs: async () => [{ issue: 7 }],
    stopJob: async () => { seen.push(`stop: workspace ${existsSync(dir) ? 'there' : 'gone'}, lock ${existsSync(join(dir, DELIVERY_LOCK)) ? 'held' : 'free'}`); },
  } as unknown as Tmux;
  assert.equal(await finishJob(ctx, dir), 'delivered');
  assert.deepEqual(seen, ['stop: workspace there, lock held']);
  assert.equal(existsSync(dir), false);
  // `air start N` (or the next tick) arriving after: finished elsewhere, not a crash, and nothing recreated.
  assert.equal(await finishJob(ctx, dir), 'delivered-elsewhere');
  assert.equal(await startOrDeliver(ctx, dir), 'delivered-elsewhere');
  assert.equal(existsSync(dir), false, 'a delivery lock never brings back a removed workspace');
  assert.equal(comments() - before, 1);
});
