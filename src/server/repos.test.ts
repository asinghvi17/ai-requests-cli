// Claim-time `repos` checks (spec/v0.md §5 Repos, §6 `pr`): resolution to commits and push permissions.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeGitHub } from '../gh/testing/fake.ts';
import { parseMarkers } from '../request/markers.ts';
import { insteadOfAll, makeBareRepo, type BareRepo } from '../lib/git-fixture.ts';
import { readState } from './workspace-state.ts';
import { claim, type ClaimOptions } from './claim.ts';

const SERVICE = 'https://github.com/o/service.git';
const GUIDE = 'https://github.com/o/guide.git';
const dirs: string[] = [];
let service: BareRepo, guide: BareRepo;
before(() => {
  const d = mkdtempSync(join(tmpdir(), 'air-repos-'));
  dirs.push(d);
  service = makeBareRepo(join(d, 's'));
  guide = makeBareRepo(join(d, 'g'));
});
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const body = (fm: string[]) => `---\nair: 0\neffort: S\n${fm.join('\n')}\n---\n\n## Task\n\nDo it.\n\n## Done when\n\n- done\n\n## Context\n\nThe repos.\n`;
const TWO = ['repos:', `  - url: ${SERVICE}`, '    ref: main', `  - url: ${GUIDE}`, '    pr: 5', '    path: docs/guide', '    deliver: none'];

function world(b: string, perms: [repo: string, login: string, role: 'write' | 'read' | 'none' | 'triage' | 'admin'][] = [['o/service', 'alice', 'write'], ['o/service', 'bot', 'write']]) {
  const gh = fakeGitHub();
  gh.addIssue({ number: 7, body: b, author: 'alice' });
  for (const [r, l, role] of perms) gh.setPermission(r, l, role);
  const root = mkdtempSync(join(tmpdir(), 'air-repos-root-'));
  dirs.push(root);
  const opts: ClaimOptions = { gh, issue: 7, root, host: 'box-a', waitMs: 0, ghHost: 'github.com', env: insteadOfAll([[service.bare, SERVICE], [guide.bare, GUIDE]]) };
  return { gh, opts, comments: () => gh.issues.get(7)!.comments.map((c) => c.body) };
}

test('every repo resolves to a commit before the claim, which lists them; state.json records them', async () => {
  const { gh, opts, comments } = world(body(['deliver: pr', ...TWO]));
  const r = await claim(opts);
  assert.equal(r.status, 'won', JSON.stringify(r));
  if (r.status !== 'won') return;
  assert.deepEqual(r.state.repos, [{ path: 'service', sha: service.main }, { path: 'docs/guide', sha: guide.dangling }]);
  assert.deepEqual(readState(r.dir).repos, r.state.repos);
  assert.equal(comments().length, 1);
  assert.match(comments()[0]!, new RegExp(`Repos, checked out at:\n\n- \`service\`: \`${service.main}\`\n- \`docs/guide\`: \`${guide.dangling}\``));
  assert.deepEqual(parseMarkers(comments()[0]!).map((m) => m.kind), ['claim']);
  // The read-only repo needs no permission check.
  assert.ok(!gh.log.some((l) => l.startsWith('permission o/guide')));
  assert.ok(gh.log.includes('permission o/service alice') && gh.log.includes('permission o/service bot'));
});

test('a request without repos is claimed with no repos recorded', async () => {
  const { opts, comments } = world(body(['deliver: comment']));
  const r = await claim(opts);
  assert.equal(r.status === 'won' && JSON.stringify(r.state.repos), '[]');
  assert.doesNotMatch(comments()[0]!, /Repos/);
});

test('an entry that does not resolve is not claimed; the requester gets one comment per body version', async () => {
  const { gh, opts, comments } = world(body(['deliver: comment', ...TWO.slice(0, 2), '    ref: nope', ...TWO.slice(3)]));
  for (let i = 0; i < 2; i++) {
    const r = await claim(opts);
    assert.equal(r.status === 'refused' && r.reason, 'repos');
  }
  assert.equal(comments().length, 1);
  assert.match(comments()[0]!, /^air can't claim this request: `repos\[0\]` \(`service`\) can't be resolved to a commit: `nope` is not a branch, tag or commit of https:\/\/github.com\/o\/service.git\./);
  assert.deepEqual(parseMarkers(comments()[0]!), []);
  assert.deepEqual(gh.issues.get(7)!.labels, ['ai-request']);
  assert.deepEqual(gh.issues.get(7)!.assignees, []);
  // A new body version gets its own comment.
  gh.issues.get(7)!.body = body(['deliver: comment', ...TWO.slice(0, 2), '    ref: nope2', ...TWO.slice(3)]);
  await claim(opts);
  assert.equal(comments().length, 2);
});

test('a pull request entry resolves to its head; one that does not exist is refused', async () => {
  const { opts, comments } = world(body(['deliver: comment', 'repos:', `  - url: ${GUIDE}`, '    pr: 6']));
  const r = await claim(opts);
  assert.equal(r.status === 'refused' && r.reason, 'repos');
  assert.match(comments()[0]!, /`repos\[0\]` \(`guide`\) can't be resolved to a commit: pull request #6 of https:\/\/github.com\/o\/guide.git was not found/);
});

test('with deliver: pr, a ref that is not a branch is refused', async () => {
  const { comments, opts } = world(body(['deliver: pr', 'repos:', `  - url: ${SERVICE}`, '    ref: v1']));
  const r = await claim(opts);
  assert.equal(r.status === 'refused' && r.reason, 'repos');
  assert.match(comments()[0]!, /`v1` is not a branch of https:\/\/github.com\/o\/service.git, and `deliver: pr` opens a pull request against it/);
  // The same ref is fine where nothing is pushed.
  const ok = world(body(['deliver: comment', 'repos:', `  - url: ${SERVICE}`, '    ref: v1']));
  const won = await claim(ok.opts);
  assert.equal(won.status === 'won' && won.state.repos[0]!.sha, service.first);
});

test('deliver: pr needs the author to have write access to every repo it delivers to', async () => {
  for (const role of ['read', 'triage', 'none'] as const) {
    const { gh, opts, comments } = world(body(['deliver: pr', ...TWO]), [['o/service', 'alice', role], ['o/service', 'bot', 'write']]);
    const r = await claim(opts);
    assert.equal(r.status === 'refused' && r.reason, 'repos', role);
    assert.match(comments()[0]!, new RegExp(`\`repos\\[0\\]\` \\(\`service\`\\): @alice has ${role} access to o/service; \`deliver: pr\` needs write or admin there`), role);
    assert.ok(!gh.log.some((l) => l.startsWith('assign')), role);
  }
});

test('a repo to deliver to that is not on the requests host is refused without a permission call', async () => {
  const { gh, opts, comments } = world(body(['deliver: pr', 'repos:', '  - url: https://gitlab.com/o/service.git', '    ref: main']));
  const r = await claim(opts);
  assert.equal(r.status === 'refused' && r.reason, 'repos');
  assert.match(comments()[0]!, /not on github\.com, the requests repo's host/);
  assert.ok(!gh.log.some((l) => l.startsWith('permission')));
});

test('the host falls back to GH_HOST from the environment', async () => {
  const { opts, comments } = world(body(['deliver: pr', ...TWO]));
  const r = await claim({ ...opts, ghHost: undefined, env: { ...opts.env, GH_HOST: 'ghe.example.com' } });
  assert.equal(r.status === 'refused' && r.reason, 'repos');
  assert.match(comments()[0]!, /not on ghe\.example\.com/);
});

test("a server whose account can't push to a repo to deliver to leaves the request alone, without a comment", async () => {
  const { gh, opts, comments } = world(body(['deliver: pr', ...TWO]), [['o/service', 'alice', 'write'], ['o/service', 'bot', 'read']]);
  const r = await claim(opts);
  assert.equal(r.status === 'refused' && r.reason, 'cannot-push');
  // GitHub won't show a read-only account even its own role (403): it reads as none.
  assert.match(r.status === 'refused' ? r.message : '', /this server's account \(bot\) can't push to o\/service \(none access\)/);
  assert.deepEqual(comments(), []);
  assert.deepEqual(gh.issues.get(7)!.labels, ['ai-request']);
  // Without push, no one's role is visible: the requester is not blamed for it.
  const blind = world(body(['deliver: pr', ...TWO]), [['o/service', 'alice', 'read']]);
  const b = await claim(blind.opts);
  assert.equal(b.status === 'refused' && b.reason, 'cannot-push');
  assert.deepEqual(blind.comments(), []);
  assert.ok(!blind.gh.log.includes('permission o/service alice'));
});
