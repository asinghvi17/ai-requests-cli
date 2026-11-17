import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeGitHub, type FakeGitHub } from '../gh/fake.ts';
import { GhError } from '../gh/gh.ts';
import { countedResults, currentClaim, formatMarker, parseMarkers, parseResult } from '../spec/markers.ts';
import { findWorkspaces, readState } from '../workspace/state.ts';
import { claim, defaultHost, deadlineTime, newNonce, release, type ClaimOptions } from './claim.ts';
import { createTrust, markedComments } from './trust.ts';

const roots: string[] = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
function root(): string {
  const r = mkdtempSync(join(tmpdir(), 'air-claim-'));
  roots.push(r);
  return r;
}

const BODY = `---
air: 0
effort: S
deliver: comment
---

## Task

Summarise the thing.

## Done when

- A summary is posted.
`;

const claimMarker = (host: string, nonce: string) => formatMarker({ kind: 'claim', version: 0, host, nonce });
const releaseMarker = (host: string, nonce: string) => formatMarker({ kind: 'release', version: 0, host, nonce });

function setup(body = BODY, issue: Partial<Parameters<FakeGitHub['addIssue']>[0]> = {}) {
  const gh = fakeGitHub();
  gh.addIssue({ number: 7, body, ...issue });
  return { gh, opts: { gh, issue: 7, root: root(), host: 'box-a', waitMs: 0, nonce: 'aaaaaaaaaaaa' } satisfies ClaimOptions };
}

/** Holder of #7 as a server would see it. */
async function holder(gh: FakeGitHub) {
  return currentClaim(await markedComments(await gh.comments(7), createTrust(gh)));
}

test('win: posts a claim, assigns, labels and creates the workspace', async () => {
  const { gh, opts } = setup();
  const r = await claim(opts);
  assert.equal(r.status, 'won');
  if (r.status !== 'won') return;
  const issue = gh.issues.get(7)!;
  assert.deepEqual(issue.labels, ['ai-request', 'air:claimed']);
  assert.deepEqual(issue.assignees, ['bot']);
  assert.equal(issue.comments.length, 1);
  assert.deepEqual(parseMarkers(issue.comments[0]!.body), [{ kind: 'claim', version: 0, host: 'box-a', nonce: 'aaaaaaaaaaaa' }]);
  // The label comes only after the claim was confirmed to hold.
  assert.ok(gh.log.indexOf('addLabels 7 air:claimed') > gh.log.lastIndexOf('comments 7'));
  assert.equal(readFileSync(join(r.dir, 'request.md'), 'utf8'), BODY);
  assert.ok(existsSync(join(r.dir, 'out')));
  const s = readState(r.dir);
  assert.equal(s.phase, 'claimed');
  assert.equal(s.nonce, 'aaaaaaaaaaaa');
  assert.equal(s.host, 'box-a');
  assert.equal(s.issue, 7);
  assert.equal(s.claimCommentId, issue.comments[0]!.id);
  assert.equal((await holder(gh))?.host, 'box-a');
});

test('lose: an earlier rival claim holds, so ours is deleted and we unassign', async () => {
  const { gh, opts } = setup();
  // The rival posts after our pre-check read but before our own claim.
  let once = false;
  gh.onComments = () => {
    if (!once) gh.post(7, 'carol', 'OWNER', claimMarker('box-b', 'bbbbbbbbbbbb'));
    once = true;
  };
  const r = await claim(opts);
  assert.deepEqual(r, { status: 'lost', holder: 'box-b' });
  const issue = gh.issues.get(7)!;
  assert.equal(issue.comments.length, 1);
  assert.equal(issue.comments[0]!.author, 'carol');
  assert.deepEqual(issue.assignees, []);
  assert.deepEqual(issue.labels, ['ai-request']);
  assert.ok(gh.log.includes('unassign 7 bot'));
  assert.deepEqual(findWorkspaces(opts.root, gh.repo, 7).map((w) => w.state.phase), ['lost']);
});

test('a rival that claims after us loses to us', async () => {
  const { gh, opts } = setup();
  const r = await claim({ ...opts, sleep: async () => { gh.post(7, 'carol', 'OWNER', claimMarker('box-b', 'bbbbbbbbbbbb')); } });
  assert.equal(r.status, 'won');
});

test('tie: two servers race; the lower comment id wins and the other backs off cleanly', async () => {
  const { gh, opts } = setup();
  const b = gh.as('dave');
  let waiting = 0;
  let release!: () => void;
  const barrier = new Promise<void>((r) => { release = r; });
  const sleep = async () => {
    if (++waiting === 2) release();
    await barrier;
  };
  const [ra, rb] = await Promise.all([
    claim({ ...opts, sleep }),
    claim({ ...opts, gh: b, host: 'box-b', nonce: 'bbbbbbbbbbbb', sleep, root: root() }),
  ]);
  const statuses = [ra.status, rb.status].sort();
  assert.deepEqual(statuses, ['lost', 'won']);
  const issue = gh.issues.get(7)!;
  assert.equal(issue.comments.length, 1);
  const winner = ra.status === 'won' ? 'bot' : 'dave';
  assert.equal(issue.comments[0]!.author, winner);
  assert.deepEqual(issue.assignees, [winner]);
  assert.deepEqual(issue.labels, ['ai-request', 'air:claimed']);
});

test('tie on one account: the loser keeps the shared assignment', async () => {
  const { gh, opts } = setup();
  let waiting = 0;
  let open!: () => void;
  const barrier = new Promise<void>((r) => { open = r; });
  const sleep = async () => {
    if (++waiting === 2) open();
    await barrier;
  };
  const results = await Promise.all([claim({ ...opts, sleep }), claim({ ...opts, host: 'box-b', nonce: 'bbbbbbbbbbbb', sleep, root: root() })]);
  assert.deepEqual(results.map((r) => r.status).sort(), ['lost', 'won']);
  assert.deepEqual(gh.issues.get(7)!.assignees, ['bot']);
  assert.ok(!gh.log.some((l) => l.startsWith('unassign')));
});

test('forged claims from untrusted or read-only accounts are ignored', async () => {
  const { gh, opts } = setup();
  gh.post(7, 'mallory', 'NONE', claimMarker('evil', 'eeeeeeeeeeee'));
  gh.post(7, 'reader', 'COLLABORATOR', claimMarker('evil2', 'ffffffffffff'));
  gh.setPermission('o/requests', 'reader', 'read');
  const r = await claim(opts);
  assert.equal(r.status, 'won');
  assert.ok(gh.log.includes('permission o/requests reader'));
});

test('a MEMBER with write access is a real rival', async () => {
  const { gh, opts } = setup();
  gh.post(7, 'erin', 'MEMBER', claimMarker('box-e', 'eeeeeeeeeeee'));
  gh.setPermission('o/requests', 'erin', 'maintain');
  const r = await claim(opts);
  assert.equal(r.status, 'refused');
  if (r.status === 'refused') assert.equal(r.reason, 'held');
  assert.equal(gh.issues.get(7)!.comments.length, 1);
});

test('edited markers: an edited earlier claim is ignored; an edit to our own claim makes it not count', async () => {
  {
    const { gh, opts } = setup();
    const c = gh.post(7, 'carol', 'OWNER', claimMarker('box-b', 'bbbbbbbbbbbb'));
    c.updatedAt = '2027-01-01T00:00:00Z';
    assert.equal((await claim(opts)).status, 'won');
  }
  {
    const { gh, opts } = setup();
    const r = await claim({ ...opts, sleep: async () => { gh.issues.get(7)!.comments.at(-1)!.updatedAt = '2027-01-01T00:00:00Z'; } });
    assert.deepEqual(r, { status: 'lost', holder: 'nobody (our claim did not count)' });
    assert.equal(gh.issues.get(7)!.comments.length, 0);
    assert.deepEqual(gh.issues.get(7)!.assignees, []);
  }
});

test('a released earlier claim no longer holds', async () => {
  const { gh, opts } = setup();
  gh.post(7, 'carol', 'OWNER', claimMarker('box-b', 'bbbbbbbbbbbb'));
  gh.post(7, 'carol', 'OWNER', releaseMarker('box-b', 'bbbbbbbbbbbb'));
  assert.equal((await claim(opts)).status, 'won');
  // a forged release of our claim changes nothing
  gh.post(7, 'mallory', 'NONE', releaseMarker('box-a', 'aaaaaaaaaaaa'));
  assert.equal((await holder(gh))?.host, 'box-a');
});

test('trust rule: untrusted and read-only authors are refused without a word', async () => {
  for (const [assoc, role] of [['NONE', undefined], ['CONTRIBUTOR', undefined], ['FIRST_TIMER', undefined], ['COLLABORATOR', 'read'], ['MEMBER', 'triage'], ['MEMBER', undefined]] as const) {
    const { gh, opts } = setup(BODY, { author: 'zed', authorAssociation: assoc });
    if (role) gh.setPermission('o/requests', 'zed', role);
    const r = await claim(opts);
    assert.equal(r.status, 'refused', assoc);
    if (r.status === 'refused') assert.equal(r.reason, 'untrusted', assoc);
    assert.equal(gh.issues.get(7)!.comments.length, 0, assoc);
    assert.deepEqual(gh.issues.get(7)!.assignees, [], assoc);
  }
  // collaborators with write are trusted
  const { gh, opts } = setup(BODY, { author: 'zed', authorAssociation: 'COLLABORATOR' });
  gh.setPermission('o/requests', 'zed', 'write');
  assert.equal((await claim(opts)).status, 'won');
});

test('trust rule: a permission API failure aborts rather than guessing', async () => {
  const { gh, opts } = setup(BODY, { author: 'zed', authorAssociation: 'MEMBER' });
  gh.permission = async () => { throw new GhError('server', 'Server Error (HTTP 502)', 502); };
  await assert.rejects(claim(opts), /502/);
  assert.equal(gh.issues.get(7)!.comments.length, 0);
});

test('lint refusal: one explanatory comment per body version', async () => {
  const bad = BODY.replace('effort: S', 'effort: huge').replace('deliver: comment', 'deliver: comment\ncolour: blue');
  const { gh, opts } = setup(bad);
  const r = await claim(opts);
  assert.equal(r.status, 'refused');
  if (r.status === 'refused') assert.equal(r.reason, 'invalid');
  const comments = gh.issues.get(7)!.comments;
  assert.equal(comments.length, 1);
  assert.match(comments[0]!.body, /line 3: .*effort/);
  assert.match(comments[0]!.body, /colour/);
  assert.match(comments[0]!.body, /^```$/m);
  assert.deepEqual(parseMarkers(comments[0]!.body), []);
  assert.deepEqual(gh.issues.get(7)!.labels, ['ai-request']);
  // polling again doesn't repeat it
  await claim(opts);
  assert.equal(gh.issues.get(7)!.comments.length, 1);
  // a new (still broken) edit gets its own answer
  gh.issues.get(7)!.body = bad.replace('colour', 'color');
  await claim(opts);
  assert.equal(gh.issues.get(7)!.comments.length, 2);
});

test('lint refusal: a marker in lint output cannot count', async () => {
  // An unknown key named like a marker ends up quoted in our comment, inside a fence.
  const sneaky = BODY.replace('deliver: comment', `deliver: comment\nx: "\\n${claimMarker('evil', 'eeeeeeeeeeee')}"`);
  const { gh, opts } = setup(sneaky);
  await claim(opts);
  assert.equal(await holder(gh), undefined);
});

test('a newer spec version gets one air-unsupported marker per host and version', async () => {
  const { gh, opts } = setup(BODY.replace('air: 0', 'air: 3'));
  const r = await claim(opts);
  assert.equal(r.status, 'refused');
  if (r.status === 'refused') assert.equal(r.reason, 'unsupported-version');
  await claim(opts);
  const comments = gh.issues.get(7)!.comments;
  assert.equal(comments.length, 1);
  assert.deepEqual(parseMarkers(comments[0]!.body), [{ kind: 'unsupported', version: 0, host: 'box-a', air: 3 }]);
  await claim({ ...opts, host: 'box-b' });
  assert.equal(gh.issues.get(7)!.comments.length, 2);
});

test('labels, state and deadline gate claiming', async () => {
  const cases: [Parameters<typeof setup>[1], string][] = [
    [{ state: 'closed' }, 'closed'],
    [{ isPullRequest: true }, 'pull-request'],
    [{ labels: [] }, 'not-a-request'],
    [{ labels: ['ai-request', 'air:cancel'] }, 'cancelled'],
    [{ labels: ['ai-request', 'air:failed'] }, 'state-label'],
    [{ labels: ['ai-request', 'air:running'] }, 'state-label'],
  ];
  for (const [issue, reason] of cases) {
    const { gh, opts } = setup(BODY, issue);
    const r = await claim(opts);
    assert.equal(r.status === 'refused' && r.reason, reason);
    assert.equal(gh.issues.get(7)!.comments.length, 0);
  }
  const late = setup(BODY.replace('deliver: comment', 'deliver: comment\ndeadline: 2026-11-06'));
  const r = await claim({ ...late.opts, now: () => new Date('2026-11-07T00:00:00Z') });
  assert.equal(r.status === 'refused' && r.reason, 'past-deadline');
  const today = setup(BODY.replace('deliver: comment', 'deliver: comment\ndeadline: 2026-11-07'));
  assert.equal((await claim({ ...today.opts, now: () => new Date('2026-11-07T23:00:00Z') })).status, 'won');
  assert.equal(deadlineTime('2026-11-07'), Date.parse('2026-11-07T23:59:59Z'));
  assert.equal(deadlineTime('2026-11-07T10:00:00+02:00'), Date.parse('2026-11-07T08:00:00Z'));
});

test('release: posts a counted release, clears labels and assignment, marks the workspace', async () => {
  const { gh, opts } = setup();
  const won = await claim(opts);
  assert.equal(won.status, 'won');
  if (won.status !== 'won') return;
  gh.issues.get(7)!.labels.push('air:running');
  const r = await release({ gh, issue: 7, root: opts.root, host: 'box-a' });
  assert.deepEqual(r, { status: 'released', nonce: 'aaaaaaaaaaaa' });
  const issue = gh.issues.get(7)!;
  assert.deepEqual(issue.labels, ['ai-request']);
  assert.deepEqual(issue.assignees, []);
  assert.deepEqual(parseMarkers(issue.comments.at(-1)!.body), [{ kind: 'release', version: 0, host: 'box-a', nonce: 'aaaaaaaaaaaa' }]);
  // The release is the claim's final comment: it ends with a counted `released` result (spec §10).
  assert.deepEqual(parseResult(issue.comments.at(-1)!.body), { ok: true, result: { status: 'released', deliver: 'comment', prs: [], host: 'box-a', nonce: 'aaaaaaaaaaaa' } });
  assert.deepEqual(countedResults(issue.comments.map((c) => ({ ...c, trusted: true }))).map((c) => c.result.status), ['released']);
  assert.equal(await holder(gh), undefined);
  assert.equal(readState(won.dir).phase, 'released');
  // and the issue can be claimed again
  assert.equal((await claim({ ...opts, nonce: 'cccccccccccc' })).status, 'won');
});

test('release with a failure sets air:failed before dropping air:claimed', async () => {
  const { gh, opts } = setup();
  const won = await claim(opts);
  if (won.status !== 'won') return assert.fail('should win');
  await release({ gh, issue: 7, root: opts.root, host: 'box-a', failure: { step: 'check', detail: 'it broke' } });
  const issue = gh.issues.get(7)!;
  assert.deepEqual(issue.labels, ['ai-request', 'air:failed']);
  assert.ok(gh.log.indexOf('addLabels 7 air:failed') < gh.log.indexOf('removeLabel 7 air:claimed'));
  assert.match(issue.comments.at(-1)!.body, /failed at check[\s\S]*it broke[\s\S]*Run `air retry 7` to offer it again/);
  assert.deepEqual(countedResults(issue.comments.map((c) => ({ ...c, trusted: true }))).map((c) => c.result.status), ['failed']);
  assert.equal(readState(won.dir).phase, 'failed');
  assert.equal(await holder(gh), undefined);
});

test('release refuses claims it does not hold and done issues', async () => {
  const { gh, opts } = setup();
  assert.equal((await release({ gh, issue: 7, root: opts.root, host: 'box-a' })).status, 'refused');
  gh.post(7, 'carol', 'OWNER', claimMarker('box-b', 'bbbbbbbbbbbb'));
  const r = await release({ gh, issue: 7, root: opts.root, host: 'box-a' });
  assert.deepEqual(r, { status: 'refused', message: '#7 is held by box-b, not box-a' });
  const done = setup(BODY, { labels: ['ai-request', 'air:done'] });
  done.gh.post(7, 'bot', 'OWNER', claimMarker('box-a', 'aaaaaaaaaaaa'));
  assert.equal((await release({ gh: done.gh, issue: 7, root: done.opts.root, host: 'box-a' })).status, 'refused');
  assert.equal(done.gh.issues.get(7)!.comments.length, 1);
});

test('host names and nonces fit the marker grammar', () => {
  assert.equal(defaultHost('my laptop (2).local'), 'my-laptop--2-.local');
  assert.equal(defaultHost('_x'), 'x');
  assert.equal(defaultHost(''), 'air-host');
  assert.equal(defaultHost('a'.repeat(100)).length, 64);
  const n = newNonce();
  assert.match(n, /^[A-Za-z0-9]{16}$/);
  assert.notEqual(n, newNonce());
});

test('an error after posting withdraws the claim instead of leaving it to hold the issue', async () => {
  const { gh, opts } = setup();
  let calls = 0;
  const real = gh.comments.bind(gh);
  gh.comments = async (n) => {
    if (++calls === 2) throw new GhError('server', 'Server Error (HTTP 502)', 502);
    return real(n);
  };
  await assert.rejects(claim(opts), /502/);
  assert.equal(gh.issues.get(7)!.comments.length, 0);
  assert.deepEqual(gh.issues.get(7)!.assignees, []);
  assert.deepEqual(findWorkspaces(opts.root, gh.repo, 7).map((w) => w.state.phase), ['released']);
});

test('the claim is recorded as a `claiming` workspace before it is posted, so a crash mid-claim is found later', async () => {
  const { gh, opts } = setup();
  const seen: string[] = [];
  const post = gh.comment.bind(gh);
  gh.comment = async (n, body) => {
    seen.push(...findWorkspaces(opts.root, gh.repo, 7).map((w) => w.state.phase));
    return post(n, body);
  };
  // The server dies during the claim wait: the workspace stays `claiming`, with the claim comment's id.
  await assert.rejects(claim({ ...opts, sleep: async () => { throw new Error('killed'); } }), /killed/);
  assert.deepEqual(seen, ['claiming']);
  // Here the withdrawal also could not be posted, so the claim still holds and the workspace says so.
  const { gh: gh2, opts: opts2 } = setup();
  gh2.deleteComment = async () => { throw new GhError('server', 'Server Error (HTTP 502)', 502); };
  const comment = gh2.comment.bind(gh2);
  gh2.comment = async (n, body) => (body.includes('Withdrawn') ? Promise.reject(new GhError('server', 'Server Error (HTTP 502)', 502)) : comment(n, body));
  await assert.rejects(claim({ ...opts2, sleep: async () => { throw new Error('killed'); } }), /killed/);
  const [ws] = findWorkspaces(opts2.root, gh2.repo, 7);
  assert.equal(ws?.state.phase, 'claiming');
  assert.equal(ws?.state.claimCommentId, gh2.issues.get(7)!.comments[0]!.id);
  assert.equal((await holder(gh2))?.nonce, 'aaaaaaaaaaaa');
  // ...and `release` (what a restarted `air serve` runs for it) gives it back.
  assert.equal((await release({ gh: gh2, issue: 7, root: opts2.root, host: 'box-a' })).status, 'released');
  assert.equal(await holder(gh2), undefined);
  assert.equal(readState(ws!.dir).phase, 'released');
});

test('regression: a claim comment that was never posted leaves no workspace; one that may have been posted is kept', async () => {
  const { gh, opts } = setup();
  gh.comment = async () => { throw new GhError('validation', 'Validation Failed (HTTP 422)', 422); };
  await assert.rejects(claim(opts), /422/);
  assert.deepEqual(findWorkspaces(opts.root, gh.repo, 7), []);
  // A timeout that posted it all the same: the `claiming` workspace stays, so the claim is given back later.
  const { gh: gh2, opts: opts2 } = setup();
  const post = gh2.comment.bind(gh2);
  gh2.comment = async (n, body) => {
    await post(n, body);
    throw new GhError('timeout', 'gh api timed out');
  };
  await assert.rejects(claim(opts2), /timed out/);
  assert.deepEqual(findWorkspaces(opts2.root, gh2.repo, 7).map((w) => w.state.phase), ['claiming']);
});

test('a claim that fails after posting and cannot be deleted is released instead', async () => {
  // Seen live: a gh that refused both the self-assign and the comment delete left the claim holding the issue.
  const { gh, opts } = setup();
  gh.assign = async () => { throw new GhError('other', 'unsupported API write route/method'); };
  gh.deleteComment = async () => { throw new GhError('other', 'unsupported API write route/method'); };
  await assert.rejects(claim(opts), /unsupported/);
  assert.equal(gh.issues.get(7)!.comments.length, 2);
  assert.equal(currentClaim(await markedComments(await gh.comments(7), createTrust(gh))), undefined);
});

test('release refuses a same-named host whose claim this machine has no workspace for', async () => {
  const { gh, opts } = setup();
  gh.post(7, 'bot', 'OWNER', claimMarker('box-a', 'zzzzzzzzzzzz'));
  gh.issues.get(7)!.labels.push('air:claimed');
  const r = await release({ gh, issue: 7, root: opts.root, host: 'box-a' });
  assert.equal(r.status, 'refused');
  assert.deepEqual(gh.issues.get(7)!.labels, ['ai-request', 'air:claimed']);
  assert.equal(gh.issues.get(7)!.comments.length, 1);
});

test('trust verdicts expire, so revoked access is noticed', async () => {
  const { gh } = setup();
  gh.setPermission('o/requests', 'erin', 'write');
  let t = 0;
  const trust = createTrust(gh, 1000, () => t);
  assert.equal(await trust('erin', 'MEMBER'), true);
  gh.setPermission('o/requests', 'erin', 'read');
  assert.equal(await trust('erin', 'MEMBER'), true);
  t = 2000;
  assert.equal(await trust('erin', 'MEMBER'), false);
});

test('release as partial: air:partial before dropping the held label, and a partial result with its resume', async () => {
  const { gh, opts } = setup();
  const won = await claim(opts);
  if (won.status !== 'won') return assert.fail('should win');
  const out = { url: 'https://github.com/o/requests/releases/download/air-artifacts/air-7-aaaaaaaaaaaa-out.zip', sha256: 'b'.repeat(64), bytes: 12 };
  const usage = { harness: 'claude' as const, tier: 'medium' as const, before_pct: 4, after_pct: 9.5, attempts: 2 };
  await release({ gh, issue: 7, root: opts.root, host: 'box-a', message: 'Stopped early.', result: { status: 'partial', report: 'comment', usage, resume: { branches: [], out } } });
  const issue = gh.issues.get(7)!;
  assert.deepEqual(issue.labels, ['ai-request', 'air:partial']);
  assert.ok(gh.log.indexOf('addLabels 7 air:partial') < gh.log.indexOf('removeLabel 7 air:claimed'));
  const [counted] = countedResults(issue.comments.map((c) => ({ ...c, trusted: true })));
  assert.deepEqual(counted?.result, { status: 'partial', deliver: 'comment', prs: [], report: 'comment', resume: { branches: [], out }, usage, host: 'box-a', nonce: 'aaaaaaaaaaaa' });
  assert.equal(readState(won.dir).phase, 'released');
  // air:partial is a state label: nobody claims the issue until it is retried
  const again = await claim({ ...opts, nonce: 'cccccccccccc' });
  assert.equal(again.status === 'refused' && again.reason, 'state-label');
});
