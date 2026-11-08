import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeReleases, type FakeReleases } from '../gh/releases-fake.ts';
import type { IssueSummary } from '../gh/releases.ts';
import { artifactBlocks, normalizeUrl, sweep } from './sweep.ts';

const NOW = new Date('2026-11-07T12:00:00Z');
const trustOwners = async (_login: string, association: string) => association === 'OWNER';

function request(url: string, expires?: string): string {
  return `---\nair: 0\neffort: S\ndeliver: comment\ncontext:\n  url: ${url}\n  sha256: ${'a'.repeat(64)}\n  bytes: 100\n${expires ? `  expires: ${expires}\n` : ''}---\n\n## Task\n\nx\n\n## Done when\n\n- y\n\n## Context\n\nz\n`;
}

function issue(gh: FakeReleases, i: Partial<IssueSummary> & { number: number; body?: string }): void {
  gh.issueList.push({ state: 'closed', labels: ['ai-request'], body: '', closedAt: '2026-10-01T00:00:00Z', ...i });
}

function artifact(gh: FakeReleases, issueNo: number, url: string, opts: { expires?: string; association?: string; edited?: boolean } = {}): void {
  const t = '2026-10-01T00:00:00Z';
  gh.commentList.push({
    id: gh.commentList.length + 1, issue: issueNo, author: 'server', authorAssociation: opts.association ?? 'OWNER',
    createdAt: t, updatedAt: opts.edited ? '2026-10-02T00:00:00Z' : t,
    body: `Done.\n\n\`\`\`air-artifact\nurl: ${url}\nsha256: ${'b'.repeat(64)}\nbytes: 10\n${opts.expires ? `expires: ${opts.expires}   # keep a while\n` : ''}\`\`\`\n`,
  });
}

function scenario() {
  const gh = fakeReleases();
  const a = {
    expired: gh.addAsset('air-context', 'expired.zip'),
    future: gh.addAsset('air-context', 'future.zip'),
    open: gh.addAsset('air-context', 'open.zip'),
    paused: gh.addAsset('air-context', 'paused.zip'),
    recent: gh.addAsset('air-context', 'recent.zip'),
    defaulted: gh.addAsset('air-context', 'defaulted.zip'),
    shared: gh.addAsset('air-context', 'shared.zip'),
    orphan: gh.addAsset('air-context', 'orphan.zip'),
    art: gh.addAsset('air-artifacts', 'air-1-abcdefgh.zip'),
    artFuture: gh.addAsset('air-artifacts', 'air-2-abcdefgh.zip'),
    artUntrusted: gh.addAsset('air-artifacts', 'air-3-abcdefgh.zip'),
    artEdited: gh.addAsset('air-artifacts', 'air-4-abcdefgh.zip'),
  };
  issue(gh, { number: 1, body: request(a.expired.url, '2026-11-01') });
  issue(gh, { number: 2, body: request(a.future.url, '2026-12-01') });
  issue(gh, { number: 3, state: 'open', closedAt: undefined, body: request(a.open.url, '2026-01-01') });
  issue(gh, { number: 4, labels: ['ai-request', 'air:paused'], body: request(a.paused.url, '2026-01-01') });
  // Closed five days ago with no expires: kept for 14 days.
  issue(gh, { number: 5, closedAt: '2026-11-02T00:00:00Z', body: request(a.recent.url) });
  // Closed 37 days ago with no expires: gone.
  issue(gh, { number: 6, body: request(a.defaulted.url) });
  // Shared by an expired issue and a claimed one: kept.
  issue(gh, { number: 7, body: request(a.shared.url, '2026-01-01') });
  issue(gh, { number: 8, labels: ['ai-request', 'air:claimed'], body: request(a.shared.url.replace('github.com/o/requests', 'GitHub.com/O/Requests'), '2026-01-01') });
  artifact(gh, 1, a.art.url, { expires: '2026-10-15' });
  artifact(gh, 2, a.artFuture.url, { expires: '2027-01-01' });
  artifact(gh, 1, a.artUntrusted.url, { association: 'NONE' });
  artifact(gh, 1, a.artEdited.url, { edited: true });
  return { gh, a };
}

test('sweep deletes exactly the assets whose references have all expired', async () => {
  const { gh, a } = scenario();
  const lines: string[] = [];
  const r = await sweep({ repo: 'o/requests', releases: gh, trust: trustOwners, now: NOW, log: (s) => lines.push(s) });
  assert.deepEqual(r.deleted.map((x) => x.name).sort(), ['air-1-abcdefgh.zip', 'defaulted.zip', 'expired.zip']);
  assert.deepEqual(r.failed, []);
  assert.deepEqual(gh.log.sort(), [a.art.id, a.defaulted.id, a.expired.id].sort().map((id) => `deleteAsset ${id}`).sort());
  const kept = Object.fromEntries(r.kept.map((k) => [k.asset.name, k.reason]));
  assert.deepEqual(kept, {
    'future.zip': 'held by #2 until 2026-12-02',
    'open.zip': 'held by open issue #3',
    'paused.zip': 'held by #4 (air:paused)',
    'recent.zip': 'held by #5 until 2026-11-16',
    'shared.zip': 'held by #8 (air:claimed)',
    'orphan.zip': 'no issue refers to it',
    'air-2-abcdefgh.zip': 'held by #2 until 2027-01-02',
    'air-3-abcdefgh.zip': 'no issue refers to it',
    'air-4-abcdefgh.zip': 'no issue refers to it',
  });
  assert.equal(lines.length, 3);
  assert.match(lines.join('\n'), /^deleted air-context\/expired\.zip \(100 bytes; #1\)$/m);

  // Idempotent: a second run finds nothing more to delete.
  gh.log.length = 0;
  const again = await sweep({ repo: 'o/requests', releases: gh, trust: trustOwners, now: NOW });
  assert.deepEqual(again.deleted, []);
  assert.deepEqual(gh.log, []);
});

test('--dry-run lists what would go and deletes nothing', async () => {
  const { gh } = scenario();
  const lines: string[] = [];
  const r = await sweep({ repo: 'o/requests', releases: gh, trust: trustOwners, now: NOW, dryRun: true, log: (s) => lines.push(s) });
  assert.equal(r.deleted.length, 3);
  assert.deepEqual(gh.log, []);
  assert.ok(lines.every((l) => l.startsWith('would delete ')));
  assert.equal(gh.assetsByTag.get('air-context')!.length, 8);
});

test('a failed delete is reported and the sweep carries on', async () => {
  const { gh, a } = scenario();
  gh.failDelete.add(a.defaulted.id);
  const r = await sweep({ repo: 'o/requests', releases: gh, trust: trustOwners, now: NOW });
  assert.deepEqual(r.failed.map((f) => f.asset.name), ['defaulted.zip']);
  assert.match(r.failed[0]!.error, /HTTP 502/);
  assert.deepEqual(r.deleted.map((x) => x.name).sort(), ['air-1-abcdefgh.zip', 'expired.zip']);
  assert.ok(gh.assetsByTag.get('air-context')!.some((x) => x.name === 'defaulted.zip'));
});

test('an issue whose body no longer parses still holds any asset it names', async () => {
  const gh = fakeReleases();
  const asset = gh.addAsset('air-context', 'x.zip');
  issue(gh, { number: 1, closedAt: '2026-11-01T00:00:00Z', body: `broken front matter\nsee ${asset.url}` });
  const r = await sweep({ repo: 'o/requests', releases: gh, trust: trustOwners, now: NOW });
  assert.deepEqual(r.kept.map((k) => k.reason), ['held by #1 until 2026-11-15']);
});

test('MEMBER and COLLABORATOR comments count only with write access', async () => {
  const gh = fakeReleases();
  const asset = gh.addAsset('air-artifacts', 'air-1-abcdefgh.zip');
  issue(gh, { number: 1 });
  artifact(gh, 1, asset.url, { association: 'COLLABORATOR' });
  const asked: string[] = [];
  const r = await sweep({ repo: 'o/requests', releases: gh, now: NOW, trust: async (login) => { asked.push(login); return true; } });
  assert.deepEqual(asked, ['server']);
  assert.deepEqual(r.deleted.map((x) => x.name), ['air-1-abcdefgh.zip']);
});

test('artifactBlocks and normalizeUrl', () => {
  assert.deepEqual(artifactBlocks('```air-artifact\nurl: "https://h/x"\nexpires: 2026-01-02 # c\n```\n```\nurl: https://no\n```\n````text\n```air-artifact\nurl: https://quoted\n```\n````'), [
    { url: 'https://h/x', expires: '2026-01-02' },
  ]);
  assert.equal(normalizeUrl('https://GitHub.com/O/R/releases/download/air-context/A%20B.zip'), 'github.com/o/r/releases/download/air-context/A B.zip');
  assert.equal(normalizeUrl('https://github.com/o/r/issues/1'), undefined);
  assert.equal(normalizeUrl('not a url'), undefined);
});
