import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { check, type Rules } from './boundaries.ts';

const rules = (domain: Rules['domain'] = {}): Rules => ({
  may: { lib: [], gh: ['lib'], request: ['lib', 'gh'], agents: ['lib', 'request'], server: ['lib', 'gh', 'request', 'agents'] },
  domain, testHelpers: ['old/fake.ts'],
});

function tree(t: { after: (f: () => void) => void }, files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), 'air-boundaries-'));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(dirname(join(d, f)), { recursive: true });
    writeFileSync(join(d, f), text);
  }
  return d;
}

test('domain rules, index-only imports, the vocab exception and cycles', (t) => {
  const d = tree(t, {
    'lib/index.ts': "import { g } from '../gh/index.ts';\n",
    'gh/index.ts': "import { l } from '../lib/index.ts';\nimport { c } from './client.ts';\n",
    'gh/client.ts': "import { i } from './index.ts';\n",
    'request/vocab.ts': '',
    'request/index.ts': "import { c } from '../gh/client.ts';\n",
    'agents/index.ts': "import { v } from '../request/vocab.ts';\nimport { i } from '../request/index.ts';\n",
  });
  assert.deepEqual(check(d, rules()).violations.sort(), [
    'agents/index.ts -> request/index.ts: agents may not import request',
    'gh/client.ts -> gh/index.ts: file cycle',
    'gh/index.ts -> gh/client.ts: file cycle',
    'gh/index.ts -> lib/index.ts: directory cycle',
    'gh/index.ts -> lib/index.ts: file cycle',
    'lib/index.ts -> gh/index.ts: directory cycle',
    'lib/index.ts -> gh/index.ts: file cycle',
    'lib/index.ts -> gh/index.ts: lib may not import gh',
    'request/index.ts -> gh/client.ts: not via gh/index.ts',
  ]);
});

test('an import that is extensionless, .js, a directory or names no file is reported, not resolved', (t) => {
  const d = tree(t, {
    'gh/index.ts': '',
    'request/a.ts': "import '../gh';\nimport '../gh/index';\nimport '../gh/index.js';\nimport '../gh/nope.ts';\nimport './data.json';\n",
    'request/data.json': '{}',
  });
  const r = check(d, rules());
  assert.deepEqual(r.badImports, [
    'request/a.ts: ../gh: name the file with its .ts or .json extension',
    'request/a.ts: ../gh/index: name the file with its .ts or .json extension',
    'request/a.ts: ../gh/index.js: name the file with its .ts or .json extension',
    'request/a.ts: ../gh/nope.ts: no such file',
  ]);
  assert.deepEqual(r.violations, [], 'bad imports take no part in the rules');
});

test('an unmapped production file is reported, and only the domain-free rules judge its imports', (t) => {
  const d = tree(t, { 'stray.ts': "import './x/a.ts';\n", 'x/a.ts': "import '../stray.ts';\n", 'gh/index.ts': "import '../stray.ts';\n" });
  const r = check(d, rules());
  assert.deepEqual(r.unmapped, ['stray.ts', 'x/a.ts']);
  assert.deepEqual(r.violations, ['stray.ts -> x/a.ts: file cycle', 'stray.ts -> x/a.ts: directory cycle',
    'x/a.ts -> stray.ts: file cycle', 'x/a.ts -> stray.ts: directory cycle']);
});

test('tests, testing/, fixtures/, e2e/ and listed helpers may import anything; production may not import them', (t) => {
  const d = tree(t, {
    'lib/index.ts': "import '../gh/testing/fake.ts';\n",
    'lib/a.test.ts': "import '../server/x.ts';\n",
    'gh/testing/fake.ts': "import '../../server/x.ts';\n",
    'e2e/run.ts': "import '../server/x.ts';\n",
    'old/fake.ts': "import '../server/x.ts';\n",
    'server/x.ts': '',
  });
  const r = check(d, rules());
  assert.deepEqual(r.violations, ['lib/index.ts -> gh/testing/fake.ts: test code']);
  assert.deepEqual(r.unmapped, []);
});

test('DOMAIN keys that match nothing or repeat what a path already says are reported', (t) => {
  const d = tree(t, {
    'toml.ts': '', 'gh/client.ts': '', 'gh/other.ts': '', 'claim/claim.ts': '', 'claim/text.ts': '', 'claim/other.ts': '',
    'spec/a.ts': '', 'lib/x/y.ts': '',
  });
  const r = check(d, rules({
    'toml.ts': 'lib', 'gh/client.ts': 'gh', 'gh/': 'gh', 'claim/': 'server', 'claim/claim.ts': 'server',
    'claim/text.ts': 'request', 'spec/': 'request', 'lib/x/': 'lib', 'gone.ts': 'lib',
  }));
  assert.deepEqual(r.unused, ['gone.ts']);
  assert.deepEqual(r.redundant, ['gh/client.ts', 'gh/', 'claim/claim.ts', 'lib/x/']);
  assert.deepEqual(r.unmapped, []);
});
