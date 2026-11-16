import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  associationTrust, countedResults, currentClaim, formatMarker, formatResult, parseMarkers, parseResult, RESULT_MARKER,
  type AirResult, type AuthoredComment, type MarkedComment,
} from './markers.ts';

const T = '2026-11-07T12:00:00Z';
/** A trusted, never-edited comment. */
const c = (id: number, body: string, extra: Partial<MarkedComment> = {}): MarkedComment => ({ id, body, createdAt: T, updatedAt: T, trusted: true, ...extra });

test('format and parse round-trip', () => {
  const claim = formatMarker({ kind: 'claim', version: 0, host: 'anshul-mbp.local', nonce: 'k3J9xQ2mP7' });
  assert.equal(claim, '<!-- air-claim v0 host=anshul-mbp.local nonce=k3J9xQ2mP7 -->');
  const unsupported = formatMarker({ kind: 'unsupported', version: 0, host: 'box', air: 2 });
  assert.equal(unsupported, '<!-- air-unsupported v0 host=box air=2 -->');
  assert.deepEqual(parseMarkers(`Claimed by box.\n\n${claim}\n${unsupported}`), [
    { kind: 'claim', version: 0, host: 'anshul-mbp.local', nonce: 'k3J9xQ2mP7' },
    { kind: 'unsupported', version: 0, host: 'box', air: 2 },
  ]);
});

test('invalid markers are rejected or ignored', () => {
  assert.throws(() => formatMarker({ kind: 'claim', version: 0, host: 'a b', nonce: 'abcdefgh' }));
  assert.throws(() => formatMarker({ kind: 'claim', version: 0, host: 'box', nonce: 'short' }));
  assert.deepEqual(parseMarkers('<!-- air-claim v0 host=box nonce=x -->'), []);
  assert.deepEqual(parseMarkers('<!-- air-claim v0 host=box -->'), []);
});

test('currentClaim: earliest unreleased claim holds', () => {
  const claim = (host: string, nonce: string) => formatMarker({ kind: 'claim', version: 0, host, nonce });
  const release = (host: string, nonce: string) => formatMarker({ kind: 'release', version: 0, host, nonce });
  assert.equal(currentClaim([]), undefined);
  // race: lower id wins regardless of order returned by the API
  const race = [
    c(20, claim('b', 'bbbbbbbb')),
    c(10, claim('a', 'aaaaaaaa')),
  ];
  assert.equal(currentClaim(race)?.host, 'a');
  // a release by the holder frees it; a mismatched release doesn't
  assert.equal(currentClaim([...race, c(30, release('a', 'aaaaaaaa'))]), undefined);
  assert.equal(currentClaim([...race, c(30, release('b', 'bbbbbbbb'))])?.host, 'a');
  // after a release, the next claim holds; claims made while held stay ignored
  const later = [...race, c(30, release('a', 'aaaaaaaa')), c(40, claim('c', 'cccccccc'))];
  assert.equal(currentClaim(later)?.commentId, 40);
});

test('currentClaim ignores markers from untrusted authors and edited comments', () => {
  const claim = (host: string, nonce: string) => formatMarker({ kind: 'claim', version: 0, host, nonce });
  const release = (host: string, nonce: string) => formatMarker({ kind: 'release', version: 0, host, nonce });
  // a forged earlier claim from a read-only user doesn't win the race
  const forged = [c(5, claim('evil', 'eeeeeeee'), { trusted: false }), c(10, claim('a', 'aaaaaaaa'))];
  assert.equal(currentClaim(forged)?.host, 'a');
  // nor can a forged release free a held issue
  assert.equal(currentClaim([c(10, claim('a', 'aaaaaaaa')), c(11, release('a', 'aaaaaaaa'), { trusted: false })])?.host, 'a');
  // a comment edited after posting (e.g. a marker pasted into an old comment) doesn't count
  const edited = [c(5, `hi\n${claim('b', 'bbbbbbbb')}`, { updatedAt: '2026-11-07T12:05:00Z' }), c(10, claim('a', 'aaaaaaaa'))];
  assert.equal(currentClaim(edited)?.host, 'a');
  assert.equal(currentClaim([c(10, claim('a', 'aaaaaaaa')), c(11, release('a', 'aaaaaaaa'), { updatedAt: '2026-11-07T13:00:00Z' })])?.host, 'a');
});

test('associationTrust', () => {
  assert.equal(associationTrust('OWNER'), 'trusted');
  assert.equal(associationTrust('MEMBER'), 'check');
  assert.equal(associationTrust('COLLABORATOR'), 'check');
  for (const a of ['CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER', 'MANNEQUIN', 'NONE']) assert.equal(associationTrust(a), 'untrusted');
});

test('markers count only alone on their line, outside code', () => {
  const m = formatMarker({ kind: 'claim', version: 0, host: 'box', nonce: 'abcdefgh' });
  const want = [{ kind: 'claim', version: 0, host: 'box', nonce: 'abcdefgh' }];
  assert.deepEqual(parseMarkers(m), want);
  assert.deepEqual(parseMarkers(`Claimed.\r\n  ${m}  \r\n`), want);
  // well-formed markers quoted in code or prose don't count
  assert.deepEqual(parseMarkers(`\`${m}\``), []);
  assert.deepEqual(parseMarkers(`The marker looks like \`${m}\`.`), []);
  assert.deepEqual(parseMarkers(`see ${m}`), []);
  assert.deepEqual(parseMarkers(`${m} and more`), []);
  assert.deepEqual(parseMarkers(`\`\`\`\n${m}\n\`\`\``), []);
  assert.deepEqual(parseMarkers(`~~~~md\n${m}\n\`\`\`\n${m}\n~~~~\n`), []);
  // a fence left open hides everything after it; after a closed fence, markers count again
  assert.deepEqual(parseMarkers(`\`\`\`\n${m}`), []);
  assert.deepEqual(parseMarkers(`\`\`\`\nx\n\`\`\`\n${m}`), want);
  // a forged claim in a fenced block can't take an issue
  const T2 = '2026-11-07T12:00:00Z';
  const comments = [
    { id: 1, body: `Example:\n\`\`\`\n${formatMarker({ kind: 'claim', version: 0, host: 'x', nonce: 'xxxxxxxx' })}\n\`\`\``, createdAt: T2, updatedAt: T2, trusted: true },
    { id: 2, body: m, createdAt: T2, updatedAt: T2, trusted: true },
  ];
  assert.equal(currentClaim(comments)?.host, 'box');
});

// ---------------------------------------------------------------------------------------------
// air-result blocks

const SHA = 'f'.repeat(40);
const PARTIAL: AirResult = {
  status: 'partial',
  deliver: 'pr',
  prs: [],
  report: 'comment',
  resume: {
    branches: [{ repo: 'service', branch: 'air/12', sha: SHA }, { repo: 'deps/client', branch: 'air/12-2', sha: '1'.repeat(40) }],
    out: { url: 'https://github.com/o/requests/releases/download/air-artifacts/air-12-aaaaaaaa-out.zip', sha256: 'a'.repeat(64), bytes: 4096 },
  },
  usage: { harness: 'claude', tier: 'large', before_pct: 12, after_pct: 31.5, attempts: 2 },
  host: 'box',
  nonce: 'aaaaaaaa',
};
const DONE: AirResult = {
  status: 'done',
  deliver: 'pr',
  prs: [{ repo: 'service', url: 'https://github.com/o/service/pull/4' }, { repo: 'client', url: 'https://github.com/o/client/pull/9' }],
  report: 'https://github.com/o/requests/releases/download/air-artifacts/air-12-aaaaaaaa-report.md',
  host: '1234',
  nonce: 'aaaaaaaa',
};
const ARTIFACT: AirResult = {
  status: 'done',
  deliver: 'artifact',
  prs: [],
  artifact: { url: 'https://github.com/o/requests/releases/download/air-artifacts/air-12-aaaaaaaa.zip', sha256: 'b'.repeat(64), bytes: 10, expires: '2026-12-31' },
  host: 'box',
  nonce: 'aaaaaaaa',
};

test('formatResult and parseResult round-trip', () => {
  const only = (r: Partial<AirResult>): AirResult => ({ ...PARTIAL, ...r });
  const valid: AirResult[] = [
    PARTIAL, DONE, ARTIFACT,
    { status: 'released', deliver: 'comment', prs: [], host: 'box', nonce: 'aaaaaaaa' },
    only({ resume: { branches: [], out: PARTIAL.resume!.out! } }), // no branches: `branches` is left out
    only({ resume: { branches: PARTIAL.resume!.branches } }), // no out
    { status: 'partial', deliver: 'comment', prs: [], usage: { harness: 'codex', tier: 'small', attempts: 1 }, host: 'box', nonce: 'aaaaaaaa' }, // nothing to resume, no readings
  ];
  for (const r of valid) {
    const block = formatResult(r);
    assert.ok(block.startsWith(`${RESULT_MARKER}\n\`\`\`yaml\n`));
    assert.deepEqual(parseResult(`The report.\n\n${block}\n`), { ok: true, result: r });
  }
  // a numeric-looking host and an all-digit SHA are quoted so that YAML reads them as strings
  assert.match(formatResult(DONE), /^host: "1234"$/m);
  assert.match(formatResult(PARTIAL), new RegExp(`^      sha: "${'1'.repeat(40)}"$`, 'm'));
  assert.throws(() => formatResult({ ...DONE, nonce: 'short' }));
  // a result that wouldn't read back is never written
  assert.throws(() => formatResult(only({ resume: { branches: [] } })), /invalid result: `resume`/);
  assert.throws(() => formatResult({ ...DONE, prs: [] }), /needs `prs`/);
  assert.throws(() => formatResult({ ...DONE, artifact: ARTIFACT.artifact }), /`artifact` is only for/);
  assert.equal(parseResult('no block here'), undefined);
});

test('parseResult: only a block that ends the comment, outside code, counts', () => {
  const block = formatResult(PARTIAL);
  const ok = (body: string) => assert.equal(parseResult(body)?.ok, true, body);
  const none = (body: string) => assert.equal(parseResult(body), undefined, body);
  const bad = (body: string, re: RegExp) => {
    const r = parseResult(body);
    assert.equal(r?.ok, false, body);
    assert.ok(r && !r.ok && r.errors.some((e) => re.test(e.message)), JSON.stringify(r));
  };
  ok(`${block}\r\n\r\n`);
  ok(`text\n  ${block}`); // spaces around the marker are allowed
  // quoted: in a fence, in a block quote, inline
  none(`\`\`\`\n${block}\n\`\`\``);
  none(`~~~~md\n${block}\n~~~~\nafter`);
  none(block.split('\n').map((l) => `> ${l}`).join('\n'));
  none(`see \`${RESULT_MARKER}\``);
  // not last: text after the block
  bad(`${block}\nP.S. one more thing`, /must end the comment/);
  // the marker without its fence on the next line
  bad(`${RESULT_MARKER}\n\n${block.split('\n').slice(1).join('\n')}`, /followed by a \`\`\`yaml fence/);
  bad(`${RESULT_MARKER}\n\`\`\`yml\nstatus: done\n\`\`\``, /followed by a \`\`\`yaml fence/);
  bad(`${RESULT_MARKER}\n\`\`\`yaml\nstatus: done`, /not closed/);
  // only the last marker line counts: a report that quotes one higher up can't replace the server's
  const forged = formatResult({ ...DONE, host: 'box' });
  assert.equal((parseResult(`${forged}\n\nfooter\n\n${block}`) as { result: AirResult }).result.status, 'partial');
  // a newer version's marker is not ours to read
  none(block.replace('air-result v0', 'air-result v1'));
});

test('parseResult validates the fields', () => {
  const yaml = (lines: string) => parseResult(`${RESULT_MARKER}\n\`\`\`yaml\n${lines}\n\`\`\``);
  const base = 'deliver: comment\nhost: box\nnonce: aaaaaaaa';
  assert.equal(yaml(`status: done\n${base}`)?.ok, true);
  const bad = (lines: string, re: RegExp) => {
    const r = yaml(lines);
    assert.ok(r && !r.ok && r.errors.some((e) => re.test(e.message)), `${lines} → ${JSON.stringify(r)}`);
  };
  bad(`status: finished\n${base}`, /`status` must be one of done, partial, failed, released/);
  bad(base, /missing `status`/);
  bad(`status: done\n${base}\nextra: x`, /unknown key `air-result.extra`/);
  bad(`status: done\n${base}\nresume:\n  branches: []`, /`resume` is only for `status: partial`/);
  bad(`status: done\n${base}\nprs:\n  - repo: a\n    url: https://github.com/o/a/pull/1`, /`prs` is only for `status: done` with `deliver: pr`/);
  const pr = (n: string) => `\n  - repo: ${n}\n    url: https://github.com/o/${n}/pull/1`;
  bad('status: done\ndeliver: pr\nhost: box\nnonce: aaaaaaaa', /`status: done` with `deliver: pr` needs `prs`/);
  bad('status: done\ndeliver: pr\nhost: box\nnonce: aaaaaaaa\nprs: []', /`prs` must list at least one pull request/);
  bad(`status: done\ndeliver: pr\nhost: box\nnonce: aaaaaaaa\nprs:${pr('a')}${pr('a')}`, /`prs` lists `a` twice/);
  bad(`status: failed\ndeliver: pr\nhost: box\nnonce: aaaaaaaa\nprs:${pr('a')}`, /`prs` is only for `status: done`/);
  bad('status: done\ndeliver: artifact\nhost: box\nnonce: aaaaaaaa', /needs `artifact`/);
  bad(`status: done\n${base}\nartifact:\n  url: https://h/a.zip\n  sha256: ${'a'.repeat(64)}\n  bytes: 1`, /`artifact` is only for `status: done` with `deliver: artifact`/);
  bad(`status: done\n${base}\nreport: nowhere`, /`report` must be `comment` or the URL/);
  bad(`status: done\n${base}\nusage:\n  harness: any\n  tier: large\n  attempts: 1`, /claude or codex/);
  bad(`status: done\n${base}\nusage:\n  harness: claude\n  tier: large\n  attempts: 1\n  after_pct: 120`, /from 0 to 100/);
  bad(`status: done\n${base}\nusage:\n  harness: claude\n  tier: large\n  attempts: "1"`, /positive unquoted integer/);
  bad('status: done\ndeliver: comment\nhost: 1234\nnonce: aaaaaaaa', /YAML reads unquoted `1234` as a number/);
  bad(`status: partial\n${base}\nresume:\n  branches:\n    - repo: ../x\n      branch: air/1\n      sha: ${SHA}`, /must be a repo's `path`/);
});

test('countedResults: only the claim holder\'s own, unedited result counts', () => {
  const claim = (host: string, nonce: string) => formatMarker({ kind: 'claim', version: 0, host, nonce });
  const release = (host: string, nonce: string) => formatMarker({ kind: 'release', version: 0, host, nonce });
  const a = (id: number, body: string, extra: Partial<AuthoredComment> = {}): AuthoredComment => ({ ...c(id, body), author: 'bot', ...extra });
  const result = (r: Partial<AirResult> = {}) => `Report.\n\n${formatResult({ ...PARTIAL, ...r })}`;
  const doneResult = (nonce = 'aaaaaaaa') => `Done.\n\n${formatResult({ ...DONE, host: 'box', nonce })}`;
  const claimed = [a(10, claim('box', 'aaaaaaaa'))];
  const ids = (cs: AuthoredComment[]) => countedResults(cs).map((r) => r.commentId);

  assert.deepEqual(countedResults([...claimed, a(11, result())]), [{ commentId: 11, claimCommentId: 10, result: PARTIAL }]);
  // forged: an untrusted author, another trusted account, another host or nonce, or no claim at all
  assert.deepEqual(ids([...claimed, a(11, result(), { trusted: false })]), []);
  assert.deepEqual(ids([...claimed, a(11, result(), { author: 'mallory' })]), []);
  assert.deepEqual(ids([...claimed, a(11, result({ host: 'other' }))]), []);
  assert.deepEqual(ids([...claimed, a(11, result({ nonce: 'bbbbbbbb' }))]), []);
  assert.deepEqual(ids([a(11, result())]), []);
  // a loser's claim never held, so its result doesn't count
  assert.deepEqual(ids([...claimed, a(11, claim('two', 'bbbbbbbb'), { author: 'bot2' }), a(12, result({ host: 'two', nonce: 'bbbbbbbb' }), { author: 'bot2' })]), []);
  // edited after posting (say, `partial` changed to `done`)
  assert.deepEqual(ids([...claimed, a(11, result(), { updatedAt: '2026-11-07T12:01:00Z' })]), []);
  // quoted in someone's (trusted, unedited) reply
  assert.deepEqual(ids([...claimed, a(11, `> ${result().split('\n').join('\n> ')}`), a(12, `\`\`\`\n${result()}\n\`\`\``)]), []);
  // a release in the same comment comes after its result; a result after the release is stale
  const released = formatResult({ status: 'released', deliver: 'pr', prs: [], host: 'box', nonce: 'aaaaaaaa' });
  assert.deepEqual(ids([...claimed, a(11, `Released.\n\n${release('box', 'aaaaaaaa')}\n\n${released}`)]), [11]);
  assert.deepEqual(ids([...claimed, a(11, release('box', 'aaaaaaaa')), a(12, result())]), []);
  // a retry: the next claim's results are tied to it
  const retry = [...claimed, a(11, `${release('box', 'aaaaaaaa')}\n\n${result()}`), a(20, claim('box', 'cccccccc')), a(21, doneResult('cccccccc'))];
  assert.deepEqual(countedResults(retry).map((r) => [r.commentId, r.claimCommentId, r.result.status]), [[11, 10, 'partial'], [21, 20, 'done']]);
  // a `done` claim is never released, but its final result is its last: a later block by the same server does nothing
  const done = [...claimed, a(11, doneResult()), a(12, result()), a(13, doneResult())];
  assert.deepEqual(countedResults(done).map((r) => [r.commentId, r.result.status]), [[11, 'done']]);
  // a result that doesn't count (here, edited) doesn't use up the claim's one result
  assert.deepEqual(ids([...claimed, a(11, doneResult(), { updatedAt: '2026-11-07T12:01:00Z' }), a(12, result())]), [12]);
});
