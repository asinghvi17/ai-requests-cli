import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatMarker, parseMarkers } from './markers.ts';
import { code, fenced, tail } from './text.ts';

const marker = formatMarker({ kind: 'claim', version: 0, host: 'evil', nonce: 'eeeeeeeeeeee' });

test('fenced text can neither close its fence nor carry a counted marker', () => {
  const nasty = `ok\n\`\`\`\n${marker}\n\`\`\`\`\`\n${marker}`;
  const block = fenced(nasty);
  assert.match(block, /^``````\n/);
  assert.deepEqual(parseMarkers(`before\n${block}\nafter`), []);
  assert.equal(fenced('x'), '```\nx\n```');
});

test('tail keeps the end and says what it cut', () => {
  const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
  const t = tail(lines, 10);
  assert.match(t, /^\[\.\.\. earlier output cut \.\.\.\]\nline 90\n/);
  assert.ok(t.endsWith('line 99'));
  assert.equal(tail('a\nb\n'), 'a\nb');
  const long = tail('x'.repeat(50) + '\n' + 'y'.repeat(50), 60, 60);
  assert.ok(long.endsWith('y'.repeat(50)) && !long.includes('x'));
});

test('code spans survive backticks and newlines', () => {
  assert.equal(code('make test'), '`make test`');
  assert.equal(code('echo `x`'), '`` echo `x` ``');
  assert.equal(code('a\nb'), '`a b`');
  assert.equal(code('`x`'), '`` `x` ``');
});
