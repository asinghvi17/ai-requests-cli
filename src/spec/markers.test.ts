import { test } from 'node:test';
import assert from 'node:assert/strict';
import { associationTrust, currentClaim, formatMarker, parseMarkers, type MarkedComment } from './markers.ts';

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
  assert.deepEqual(parseMarkers('`<!-- air-claim v0 nonce=abcdefgh -->`'), []);
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
