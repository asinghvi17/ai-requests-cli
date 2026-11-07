import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentClaim, formatMarker, parseMarkers } from './markers.ts';

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
    { id: 20, body: claim('b', 'bbbbbbbb') },
    { id: 10, body: claim('a', 'aaaaaaaa') },
  ];
  assert.equal(currentClaim(race)?.host, 'a');
  // a release by the holder frees it; a mismatched release doesn't
  assert.equal(currentClaim([...race, { id: 30, body: release('a', 'aaaaaaaa') }]), undefined);
  assert.equal(currentClaim([...race, { id: 30, body: release('b', 'bbbbbbbb') }])?.host, 'a');
  // after a release, the next claim holds; claims made while held stay ignored
  const later = [...race, { id: 30, body: release('a', 'aaaaaaaa') }, { id: 40, body: claim('c', 'cccccccc') }];
  assert.equal(currentClaim(later)?.commentId, 40);
});
