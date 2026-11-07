import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ArgError, parseArgs } from './args.ts';

const specs = {
  repo: { type: 'string' },
  manual: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  label: { type: 'string', multiple: true },
} as const;

test('parses positionals, string and boolean flags', () => {
  const p = parseArgs(['42', '--repo', 'o/r', '--manual', 'x'], specs);
  assert.deepEqual(p, { flags: { repo: 'o/r', manual: true }, positionals: ['42', 'x'] });
});

test('accepts --name=value and short aliases', () => {
  assert.deepEqual(parseArgs(['--repo=o/r', '-h'], specs).flags, { repo: 'o/r', help: true });
});

test('collects repeatable flags', () => {
  assert.deepEqual(parseArgs(['--label', 'a', '--label=b'], specs).flags, { label: ['a', 'b'] });
});

test('-- ends flag parsing', () => {
  assert.deepEqual(parseArgs(['--', '--repo', '-h'], specs).positionals, ['--repo', '-h']);
});

test('rejects unknown, duplicate, valueless and mis-valued flags', () => {
  assert.throws(() => parseArgs(['--nope'], specs), ArgError);
  assert.throws(() => parseArgs(['-x'], specs), ArgError);
  assert.throws(() => parseArgs(['--repo', 'a', '--repo', 'b'], specs), /more than once/);
  assert.throws(() => parseArgs(['--repo'], specs), /needs a value/);
  assert.throws(() => parseArgs(['--repo', '--manual'], specs), /needs a value/);
  assert.throws(() => parseArgs(['--manual=yes'], specs), /takes no value/);
});

test('a lone - is a positional and may be a value', () => {
  assert.deepEqual(parseArgs(['-', '--repo', '-'], specs), { flags: { repo: '-' }, positionals: ['-'] });
});

test('names shared with Object.prototype are unknown flags', () => {
  for (const arg of ['--toString', '--constructor', '--__proto__', '--hasOwnProperty=x', '--valueOf']) {
    assert.throws(() => parseArgs([arg], specs), (e: unknown) => e instanceof ArgError && /unknown flag/.test(e.message), arg);
  }
});

test('a declared flag named like a prototype member works', () => {
  assert.deepEqual(parseArgs(['--constructor', 'x'], { constructor: { type: 'string' } } as const).flags, { constructor: 'x' });
});

test('single-dash words are unknown flags, not positionals', () => {
  for (const arg of ['-repo', '-manual', '-r=value', '-hh', '-1']) {
    assert.throws(() => parseArgs([arg], specs), (e: unknown) => e instanceof ArgError && e.message === `unknown flag ${arg}`, arg);
  }
});
