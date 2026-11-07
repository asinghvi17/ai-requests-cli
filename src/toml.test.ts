import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TomlError, parseToml } from './toml.ts';

// Tables have a null prototype; compare their content as plain objects.
const plain = (v: unknown) => JSON.parse(JSON.stringify(v));

test('parses tables, scalars and arrays', () => {
  const doc = plain(parseToml(`
# top comment
repo = "acme/ai-requests"   # trailing comment
max_jobs = 2
ratio = 0.25
big = 1_000
neg = -3
on = true
off = false
lit = 'C:\\path\\no-escapes'
esc = "tab\\there \\u00e9 \\"q\\""
list = [ "a", 'b',
  3, # comment inside
  true, ]

[subscriptions.work]
harness = "claude"
"quoted key" = 1

[subscriptions."my.home"]
harness = "codex"
dotted.key = "x"
`));
  assert.deepEqual(doc, {
    repo: 'acme/ai-requests',
    max_jobs: 2,
    ratio: 0.25,
    big: 1000,
    neg: -3,
    on: true,
    off: false,
    lit: 'C:\\path\\no-escapes',
    esc: 'tab\there é "q"',
    list: ['a', 'b', 3, true],
    subscriptions: {
      work: { harness: 'claude', 'quoted key': 1 },
      'my.home': { harness: 'codex', dotted: { key: 'x' } },
    },
  });
});

test('empty document and empty array', () => {
  assert.deepEqual(plain(parseToml('')), {});
  assert.deepEqual(plain(parseToml('a = []\n')), { a: [] });
});

test('rejects malformed and unsupported input with a line number', () => {
  const cases: [string, RegExp][] = [
    ['a = 1\na = 2', /line 2: key a defined twice/],
    ['[t]\n[t]', /line 2: table t defined twice/],
    ['a = 1\n[a]', /a is not a table/],
    ['a = "open', /unterminated string/],
    ['a = 1 2', /unexpected "2"/],
    ['a = {b = 1}', /inline tables/],
    ['[[t]]', /arrays of tables/],
    ['a = [[1]]', /nested arrays/],
    ['a = """x"""', /multi-line strings/],
    ['a = 1979-05-27', /unsupported value/],
    ['a = 01', /unsupported value/],
    ['a =', /expected a value/],
    ['= 1', /expected a key/],
    ['a 1', /expected =/],
    ['a = "\\q"', /bad escape/],
    ['x = 1\na = "open\nb = 2', /^line 2: unterminated string$/],
    ["x = 1\na = 'open\nb = 2", /^line 2: unterminated string$/],
    ['x = 1\na = "\\uD800"', /^line 2: \\uD800 is not a Unicode scalar value$/],
    ['a = "\\uDFFF"', /not a Unicode scalar value/],
    ['a = "\\U00110000"', /^line 1: \\U00110000 is not a Unicode scalar value$/],
    ['a = "\\u12"', /bad unicode escape/],
  ];
  for (const [src, re] of cases) assert.throws(() => parseToml(src), (e: unknown) => e instanceof TomlError && re.test(e.message), src);
});

test('rejects keys that reach Object.prototype', () => {
  const cases = ['[__proto__]\nx = 1', '__proto__.x = 1', '__proto__ = 1', '"__proto__" = 1', '[a.constructor]', 'prototype = 1', '[t]\nconstructor.x = 1'];
  for (const src of cases) assert.throws(() => parseToml(src), (e: unknown) => e instanceof TomlError && /is not allowed/.test(e.message), src);
  assert.equal(({} as Record<string, unknown>).x, undefined);
});

test('names shared with Object.prototype are ordinary keys', () => {
  const doc = parseToml('[toString]\nvalueOf = 1\n[hasOwnProperty.x]\ny = true\n');
  assert.equal(Object.getPrototypeOf(doc), null);
  assert.equal(Object.getPrototypeOf(doc.toString), null);
  assert.deepEqual(plain(doc), { toString: { valueOf: 1 }, hasOwnProperty: { x: { y: true } } });
  assert.throws(() => parseToml('[toString]\n[toString]'), /table toString defined twice/);
  assert.throws(() => parseToml('valueOf = 1\nvalueOf = 2'), /key valueOf defined twice/);
});

test('unicode escapes', () => {
  assert.equal(parseToml('a = "\\u00e9\\U0001F600\\uFFFF"').a, 'é😀\uffff');
});
