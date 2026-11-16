import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lint } from '../spec/lint.ts';
import { claim, requestBody, requestIssue, result, SHA } from './fixture.ts';
import { editFrontMatter, retry, RetryError } from './retry.ts';

const OUT = { url: 'https://github.com/o/requests/releases/download/air-artifacts/air-1-aaaaaaaa-out.zip', sha256: 'b'.repeat(64), bytes: 100 };
const RESUME = { branches: [{ repo: 'service', branch: 'air/1', sha: SHA }], out: OUT };

test('editFrontMatter sets effort in place and replaces resume, keeping the rest', () => {
  const old = '﻿' + requestBody(['resume:', '  out:', `    url: ${OUT.url}`, `    sha256: ${'c'.repeat(64)}`, '    bytes: 5', '', '# keep me', 'timeout: 2h']).replace(/\n/g, '\r\n');
  const body = editFrontMatter(old, { effort: 'L', resume: RESUME });
  const r = lint(body);
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.equal(r.request!.effort, 'L');
  assert.deepEqual(r.request!.resume, RESUME);
  assert.equal(r.request!.timeoutMinutes, 120);
  assert.match(body, /\n\n# keep me\ntimeout: 2h\nresume:\n {2}branches:\n/);
  assert.ok(!body.includes('\r') && !body.includes('c'.repeat(64)));
  // No edits: the same body, LF.
  assert.equal(editFrontMatter(requestBody(), {}), requestBody());
});

test('a partial result is resumed: body first, then every air:* label goes', async () => {
  const gh = requestIssue({ labels: ['air:partial', 'air:cancel'], results: [{ result: result({ status: 'partial', resume: RESUME }), release: true }] });
  const r = await retry({ gh, issue: 1, effort: 'M' });
  assert.deepEqual(r, { resumed: true, edited: true, removed: ['air:partial', 'air:cancel'] });
  const issue = gh.issues.get(1)!;
  assert.deepEqual(issue.labels, ['ai-request']);
  const linted = lint(issue.body);
  assert.deepEqual(linted.request?.resume, RESUME);
  assert.equal(linted.request?.effort, 'M');
  const writes = gh.log.filter((l) => /^(alice: )?(editBody|removeLabel)/.test(l));
  assert.deepEqual(writes, ['alice: editBody 1', 'alice: removeLabel 1 air:partial', 'alice: removeLabel 1 air:cancel']);
});

test('a failed or released result leaves resume as it is; nothing to edit means no edit', async () => {
  const old = requestBody(['resume:', '  branches:', '    - repo: service', '      branch: air/1', `      sha: "${SHA}"`]);
  const gh = requestIssue({ body: old, labels: ['air:failed'], results: [{ result: result({ status: 'failed' }), release: true }] });
  assert.deepEqual(await retry({ gh, issue: 1 }), { resumed: false, edited: false, removed: ['air:failed'] });
  assert.equal(gh.issues.get(1)!.body, old);
  assert.ok(!gh.log.some((l) => l.includes('editBody')));
});

test('refusals: held, closed, not a request, no permission, a body that does not lint', async () => {
  const no = (p: Promise<unknown>, re: RegExp) => assert.rejects(p, (e: unknown) => e instanceof RetryError && re.test(e.message));
  // Held: the claim was never released.
  await no(retry({ gh: requestIssue({ labels: ['air:running'] }), issue: 1 }), /held by box/);
  const closed = requestIssue({ labels: ['air:failed'], claimed: false });
  closed.issues.get(1)!.state = 'closed';
  await no(retry({ gh: closed, issue: 1 }), /closed; reopen it first/);
  const plain = requestIssue({ claimed: false });
  plain.issues.get(1)!.labels = [];
  await no(retry({ gh: plain, issue: 1 }), /not a request/);

  // Someone else needs write access; the author doesn't.
  const other = requestIssue({ labels: ['air:failed'], claimed: false });
  other.issues.get(1)!.author = 'bob';
  await no(retry({ gh: other, issue: 1 }), /only the issue's author \(bob\) or someone with write access.*alice has none/);
  other.setPermission('o/requests', 'alice', 'maintain');
  assert.deepEqual((await retry({ gh: other, issue: 1 })).removed, ['air:failed']);

  const broken = requestIssue({ body: requestBody().replace('effort: S', 'effort: Q'), labels: ['air:failed'], claimed: false });
  await no(retry({ gh: broken, issue: 1 }), /doesn't pass lint/);
  // A checkpoint for a repo the body no longer has would not lint.
  const moved = requestIssue({ labels: ['air:partial'], results: [{ result: result({ status: 'partial', resume: { branches: [{ repo: 'gone', branch: 'air/1', sha: SHA }] } }), release: true }] });
  await no(retry({ gh: moved, issue: 1 }), /would not pass lint/);
  assert.deepEqual(moved.issues.get(1)!.labels, ['ai-request', 'air:partial']);
});

test('the latest result counts even when a later claim was withdrawn without one', async () => {
  const gh = requestIssue({ labels: ['air:partial'], results: [{ result: result({ status: 'partial', resume: RESUME }), release: true }] });
  claim(gh, 'other', 'bbbbbbbb');
  gh.post(1, 'srv', 'OWNER', 'Withdrawn.\n\n<!-- air-release v0 host=other nonce=bbbbbbbb -->\n');
  assert.equal((await retry({ gh, issue: 1 })).resumed, true);
  assert.deepEqual(lint(gh.issues.get(1)!.body).request?.resume, RESUME);
});
