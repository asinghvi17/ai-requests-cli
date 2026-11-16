import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GhError } from '../gh/gh.ts';
import { formatResult } from '../spec/markers.ts';
import { claim, NONCE, requestIssue, result, SHA } from './fixture.ts';
import { formatStatus, readStatus, statusJson, waitForResult } from './status.ts';

const PR = 'https://github.com/acme/service/pull/7';

test('a claimed request with no result: label and holder', async () => {
  const gh = requestIssue({ labels: ['air:running'] });
  const s = await readStatus(gh, 1);
  assert.equal(s.state, 'air:running');
  assert.equal(s.holder, 'box');
  assert.equal(s.latest, undefined);
  assert.equal(formatStatus(s), 'o/requests#1: A request\nstate:  air:running, held by box\nresult: none yet\n');
  assert.deepEqual(statusJson(s), {
    repo: 'o/requests', issue: 1, title: 'A request', url: 'https://github.com/o/requests/issues/1', open: true, state: 'air:running', cancel: false, holder: 'box', result: null,
  });
});

test('the latest counted result, with PRs, checkpoint and usage', async () => {
  const done = result({ prs: [{ repo: 'service', url: PR }], usage: { harness: 'claude', tier: 'large', before_pct: 10, after_pct: 14.5, attempts: 1 } });
  const gh = requestIssue({ labels: ['air:done'], results: [{ result: done }] });
  const s = await readStatus(gh, 1);
  assert.equal(s.holder, 'box'); // done is not released (§9)
  assert.equal(s.latest?.current, true);
  assert.deepEqual(s.latest?.result, done);
  const text = formatStatus(s);
  assert.match(text, /^result: done \(deliver: pr, from box, comment \d+\)$/m);
  assert.match(text, /^ {2}pr: {9}service https:\/\/github\.com\/acme\/service\/pull\/7$/m);
  assert.match(text, /^ {2}usage: {6}claude large, weekly window 10% -> 14.5%, 1 attempt$/m);
  const json = statusJson(s) as { result: Record<string, unknown> };
  assert.equal(json.result.status, 'done');
  assert.equal(json.result.current, true);
  assert.deepEqual(json.result.prs, [{ repo: 'service', url: PR }]);

  const partial = result({ status: 'partial', resume: { branches: [{ repo: 'service', branch: 'air/1', sha: SHA }] } });
  const p = await readStatus(requestIssue({ labels: ['air:partial'], results: [{ result: partial, release: true }] }), 1);
  assert.equal(p.holder, undefined);
  assert.match(formatStatus(p), new RegExp(`^ {2}checkpoint: service branch air/1 at ${SHA}$`, 'm'));

  // multi-repo: one line per PR and per checkpoint branch
  const two = result({ prs: [{ repo: 'service', url: PR }, { repo: 'client', url: 'https://github.com/acme/client/pull/3' }] });
  assert.match(formatStatus(await readStatus(requestIssue({ labels: ['air:done'], results: [{ result: two }] }), 1)), /^ {2}pr: {9}service \S+\n {2}pr: {9}client https:\/\/github\.com\/acme\/client\/pull\/3$/m);
  const both = result({ status: 'partial', resume: { branches: [{ repo: 'service', branch: 'air/1', sha: SHA }, { repo: 'client', branch: 'air/1', sha: SHA }] } });
  assert.match(formatStatus(await readStatus(requestIssue({ labels: ['air:partial'], results: [{ result: both, release: true }] }), 1)), new RegExp(`^ {2}checkpoint: service branch air/1 at ${SHA}\n {2}checkpoint: client branch air/1 at ${SHA}$`, 'm'));
});

test('forged, edited or quoted results do not count; a later claim makes the result not current', async () => {
  const gh = requestIssue({ results: [{ result: result({ status: 'failed' }), release: true }] });
  // Someone without write access, and a trusted human pasting a result, change nothing.
  gh.post(1, 'mallory', 'NONE', `${formatResult(result())}\n`);
  gh.post(1, 'alice', 'OWNER', `${formatResult(result())}\n`);
  const s = await readStatus(gh, 1);
  assert.equal(s.latest?.result.status, 'failed');
  assert.equal(s.latest?.current, true);

  // An edited final comment doesn't count at all.
  const edited = requestIssue({ results: [{ result: result() }] });
  edited.issues.get(1)!.comments.at(-1)!.updatedAt = '2030-01-01T00:00:00Z';
  assert.equal((await readStatus(edited, 1)).latest, undefined);

  // A retry starts: a new claim makes the old result stale.
  claim(gh, 'other', 'bbbbbbbb');
  const later = await readStatus(gh, 1);
  assert.equal(later.holder, 'other');
  assert.equal(later.latest?.current, false);
  assert.match(formatStatus(later), /; not current: a later claim has started since$/m);
});

test('cancel and closed are shown', async () => {
  const gh = requestIssue({ labels: ['air:cancel'], claimed: false });
  gh.issues.get(1)!.state = 'closed';
  assert.equal(formatStatus(await readStatus(gh, 1)).split('\n').slice(0, 2).join('\n'), 'o/requests#1: A request (closed)\nstate:  none; air:cancel is set');
});

test('waitForResult polls until a current result, retrying transient errors', async () => {
  const gh = requestIssue({ labels: ['air:running'] });
  const slept: number[] = [];
  let polls = 0;
  const real = gh.comments.bind(gh);
  gh.comments = async (n) => {
    polls++;
    if (polls === 2) throw new GhError('server', 'Bad Gateway (HTTP 502)', 502);
    if (polls === 3) gh.post(1, 'srv', 'OWNER', `Report.\n\n${formatResult(result({ status: 'partial' }))}\n`);
    return real(n);
  };
  const retried: string[] = [];
  const r = await waitForResult(gh, 1, { intervalMs: 1000, sleep: async (ms) => void slept.push(ms), onRetry: (e) => retried.push(e.message) });
  assert.equal(r.timedOut, false);
  assert.equal(r.status.latest?.result.status, 'partial');
  assert.deepEqual(slept, [1000, 1000]);
  assert.deepEqual(retried, ['Bad Gateway (HTTP 502)']);
  assert.equal(r.status.latest?.result.nonce, NONCE);
});

test('waitForResult times out with the last status; a missing issue is an error', async () => {
  const gh = requestIssue({ labels: ['air:running'] });
  let t = 0;
  const r = await waitForResult(gh, 1, { timeoutMs: 2500, intervalMs: 1000, now: () => t, sleep: async (ms) => void (t += ms) });
  assert.equal(r.timedOut, true);
  assert.equal(t, 2500);
  assert.equal(r.status.state, 'air:running');
  // A stale result is not what wait waits for.
  const stale = requestIssue({ results: [{ result: result({ status: 'failed' }), release: true }] });
  claim(stale, 'other', 'bbbbbbbb');
  t = 0;
  assert.equal((await waitForResult(stale, 1, { timeoutMs: 1000, intervalMs: 1000, now: () => t, sleep: async (ms) => void (t += ms) })).timedOut, true);
  await assert.rejects(waitForResult(gh, 9, { sleep: async () => {} }), (e: unknown) => e instanceof GhError && e.kind === 'not_found');
});
