import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TomlError, parseToml } from './toml.ts';

test('parses tables, scalars and arrays', () => {
  const doc = parseToml(`
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
`);
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
  assert.deepEqual(parseToml(''), {});
  assert.deepEqual(parseToml('a = []\n'), { a: [] });
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
  ];
  for (const [src, re] of cases) assert.throws(() => parseToml(src), (e: unknown) => e instanceof TomlError && re.test(e.message), src);
});
