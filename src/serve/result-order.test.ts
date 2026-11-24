// Every path that ends a server's part in an issue (spec §8) posts its final comment before it changes the
// labels: a reader that sees the new labels then sees the result too. Recorded with the fake gh's call log.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claim, release } from '../claim/claim.ts';
import { createTrust } from '../claim/trust.ts';
import type { Config } from '../config.ts';
import { fakeGitHub, type FakeGitHub } from '../gh/fake.ts';
import { GhError } from '../gh/gh.ts';
import type { Tmux } from '../tmux/tmux.ts';
import { readState, updateState, type JobRecord } from '../workspace/state.ts';
import type { ServeContext } from './context.ts';
import type { ServeGitHub } from './github.ts';
import { cancelJob, expirePause, failJob, finishJob, partialJob } from './jobs.ts';

const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'air-order-'));
  dirs.push(d);
  return d;
};

const BODY = '---\nair: 0\neffort: XS\ndeliver: comment\n---\n\n## Task\n\nSummarise it.\n\n## Done when\n\n- It is summarised.\n';

/** Writes to issue 7 since `from` in the fake's call log. */
const writes = (gh: FakeGitHub, from: number) => gh.log.slice(from).filter((l) => /^(comment|addLabels|removeLabel|unassign) 7\b/.test(l));

/** The comment comes first, before any label change. */
function commentFirst(w: string[]): void {
  assert.equal(w[0], 'comment 7', w.join('\n'));
  assert.ok(w.slice(1).every((l) => l !== 'comment 7'), w.join('\n'));
}

/** Issue 7 claimed by this server, its job `job` labelled `label`, and a context with no tmux window or API. */
async function held(label: string, job: Partial<JobRecord> = {}) {
  const gh = fakeGitHub();
  gh.addIssue({ number: 7, body: BODY });
  const root = tmp();
  const won = await claim({ gh, issue: 7, root, host: 'box', waitMs: 0, nonce: 'aaaaaaaaaaaa' });
  if (won.status !== 'won') throw new Error('should win');
  if (label !== 'air:claimed') {
    await gh.addLabels(7, [label]);
    await gh.removeLabel(7, 'air:claimed');
  }
  updateState(won.dir, { phase: 'ready', job: { status: 'running', harness: 'claude', subscription: 'max', model: 'sonnet', runMs: 0, starts: 0, ...job } }, new Date());
  const ctx: ServeContext = {
    gh, api: {} as ServeGitHub, tmux: { listJobs: async () => [], stopJob: async () => {} } as unknown as Tmux, config: {} as Config,
    root, host: 'box', ghHost: 'github.com', env: process.env, stateDir: tmp(), trust: createTrust(gh),
    usage: async () => [], agentEnv: () => ({}), log: () => {}, now: () => new Date(), stopGraceMs: 0, resumeCheckMs: 0, agentReadyMs: 0,
  };
  return { gh, ctx, dir: won.dir, from: gh.log.length };
}

test('done (finishJob): result comment, then air:done, then air:running removed', async () => {
  const { gh, ctx, dir, from } = await held('air:running', { status: 'delivering' });
  writeFileSync(join(dir, 'out', 'REPORT.md'), 'The summary.\n');
  assert.equal(await finishJob(ctx, dir), 'delivered');
  assert.deepEqual(writes(gh, from), ['comment 7', 'addLabels 7 air:done', 'removeLabel 7 air:running', 'unassign 7 bot']);
  assert.equal(existsSync(dir), false, 'the delivered workspace is removed');
});

test('done, retried after the label change failed: the comment is not posted twice', async () => {
  const { gh, ctx, dir, from } = await held('air:running', { status: 'delivering' });
  writeFileSync(join(dir, 'out', 'REPORT.md'), 'The summary.\n');
  const add = gh.addLabels.bind(gh);
  gh.addLabels = async () => { throw new GhError('server', 'Bad Gateway (HTTP 502)', 502); };
  assert.equal(await finishJob(ctx, dir), 'undelivered');
  assert.equal(writes(gh, from)[0], 'comment 7');
  gh.addLabels = add;
  assert.equal(await finishJob(ctx, dir), 'delivered');
  const w = writes(gh, from);
  commentFirst(w);
  assert.deepEqual(w.slice(1), ['addLabels 7 air:done', 'removeLabel 7 air:running', 'unassign 7 bot']);
  assert.equal(existsSync(dir), false);
});

test('failed (failJob): failure comment, then air:failed, then air:running removed', async () => {
  const { gh, ctx, dir, from } = await held('air:running');
  await failJob(ctx, dir, 'the agent', 'It broke.');
  assert.deepEqual(writes(gh, from), ['comment 7', 'addLabels 7 air:failed', 'removeLabel 7 air:running', 'unassign 7 bot']);
});

test('partial (partialJob: early stop, quota stop, effort cap): checkpoint comment, then air:partial', async () => {
  const { gh, ctx, dir, from } = await held('air:running');
  await partialJob(ctx, dir, { why: 'subscription `max` ran out of quota.' });
  assert.deepEqual(writes(gh, from), ['comment 7', 'addLabels 7 air:partial', 'removeLabel 7 air:running', 'unassign 7 bot']);
  assert.equal(readState(dir).job!.status, 'partial');
});

test('timeout with nothing to keep (partialJob -> failJob): comment, then air:failed', async () => {
  const { gh, ctx, dir, from } = await held('air:running');
  await partialJob(ctx, dir, { why: 'its timeout passed.', timeout: true });
  assert.deepEqual(writes(gh, from), ['comment 7', 'addLabels 7 air:failed', 'removeLabel 7 air:running', 'unassign 7 bot']);
});

test('cancelled (cancelJob): release comment, then air:running removed', async () => {
  const { gh, ctx, dir, from } = await held('air:running');
  await cancelJob(ctx, dir, 'the requester added `air:cancel`');
  assert.deepEqual(writes(gh, from), ['comment 7', 'removeLabel 7 air:running', 'unassign 7 bot']);
});

test('long pause (expirePause): release comment, then air:paused removed', async () => {
  const { gh, ctx, dir, from } = await held('air:paused', { status: 'paused' });
  await expirePause(ctx, dir);
  assert.deepEqual(writes(gh, from), ['comment 7', 'removeLabel 7 air:paused', 'unassign 7 bot']);
});

test('release (air release, setup failure, interrupted claim): comment, then labels', async () => {
  const plain = await held('air:claimed');
  await release({ gh: plain.gh, issue: 7, root: plain.ctx.root, host: 'box' });
  assert.deepEqual(writes(plain.gh, plain.from), ['comment 7', 'removeLabel 7 air:claimed', 'unassign 7 bot']);

  const failed = await held('air:claimed');
  await release({ gh: failed.gh, issue: 7, root: failed.ctx.root, host: 'box', failure: { step: 'setup', detail: 'It broke.' } });
  assert.deepEqual(writes(failed.gh, failed.from), ['comment 7', 'addLabels 7 air:failed', 'removeLabel 7 air:claimed', 'unassign 7 bot']);
});

test('a won claim that cannot be labelled: release comment, then unassign', async () => {
  const gh = fakeGitHub();
  gh.addIssue({ number: 7, body: BODY });
  const add = gh.addLabels.bind(gh);
  gh.addLabels = async (n, labels) => {
    if (labels.includes('air:claimed')) throw new GhError('server', 'Bad Gateway (HTTP 502)', 502);
    return add(n, labels);
  };
  await assert.rejects(claim({ gh, issue: 7, root: tmp(), host: 'box', waitMs: 0, nonce: 'aaaaaaaaaaaa' }));
  const w = writes(gh, 0);
  // The claim comment, then the giving up: its comment before any label or assignment change.
  assert.deepEqual(w.slice(w.lastIndexOf('comment 7')), ['comment 7', 'unassign 7 bot']);
});

/** Makes the next `method` call fail with a 502, after which it works again. */
function failOnce(gh: FakeGitHub, method: 'addLabels' | 'removeLabel' | 'unassign'): void {
  const real = gh[method].bind(gh) as (...a: unknown[]) => Promise<void>;
  let failed = false;
  (gh as unknown as Record<string, unknown>)[method] = async (...a: unknown[]) => {
    if (!failed) {
      failed = true;
      throw new GhError('server', 'Bad Gateway (HTTP 502)', 502);
    }
    return real(...a);
  };
}

const finals = (gh: FakeGitHub) => gh.issues.get(7)!.comments.filter((c) => c.body.includes('air-result'));

test('a release whose label write failed after its comment is finished by the retry, with one comment', async () => {
  for (const [method, run, label] of [
    ['addLabels', (ctx: ServeContext, dir: string) => failJob(ctx, dir, 'the agent', 'It broke.'), 'air:failed'],
    ['addLabels', (ctx: ServeContext, dir: string) => partialJob(ctx, dir, { why: 'subscription `max` ran out of quota.' }), 'air:partial'],
    ['removeLabel', (ctx: ServeContext, dir: string) => cancelJob(ctx, dir, 'the requester added `air:cancel`'), undefined],
    ['unassign', (ctx: ServeContext, dir: string) => expirePause(ctx, dir), undefined],
    ['unassign', (ctx: ServeContext, dir: string) => failJob(ctx, dir, 'the agent', 'It broke.'), 'air:failed'],
  ] as const) {
    const { gh, ctx, dir } = await held('air:running');
    failOnce(gh, method);
    await assert.rejects(run(ctx, dir), /Bad Gateway/);
    assert.equal(finals(gh).length, 1, method);
    // Our own release is now the latest marker: nothing holds the issue, yet the retry finishes the release.
    await run(ctx, dir);
    assert.equal(finals(gh).length, 1, method);
    assert.deepEqual(gh.issues.get(7)!.labels, ['ai-request', ...(label ? [label] : [])], method);
    assert.deepEqual(gh.issues.get(7)!.assignees, [], method);
    assert.ok(['failed', 'released'].includes(readState(dir).phase), method);
    // Once finished, there is nothing left to release.
    assert.equal((await release({ gh, issue: 7, root: ctx.root, host: 'box' })).status, 'refused', method);
  }
});

test('a finished release of ours is not taken up again once another server claims the issue', async () => {
  const { gh, ctx, dir } = await held('air:running');
  failOnce(gh, 'addLabels');
  await assert.rejects(failJob(ctx, dir, 'the agent', 'It broke.'));
  // Another server claims it meanwhile: the retry must leave its labels alone.
  gh.post(7, 'other', 'OWNER', `Claimed.\n\n<!-- air-claim v0 host=rival nonce=bbbbbbbbbbbb -->\n`);
  const from = gh.log.length;
  await failJob(ctx, dir, 'the agent', 'It broke.');
  assert.deepEqual(writes(gh, from), []);
  assert.equal(readState(dir).phase, 'lost');
});
