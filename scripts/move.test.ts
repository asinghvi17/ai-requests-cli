import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const move = join(import.meta.dirname, 'move.ts');

test('move.ts moves a file with its tests, re-points imports both ways, and a second run changes nothing', (t) => {
  const d = mkdtempSync(join(tmpdir(), 'air-move-'));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  const tree: Record<string, string> = {
    'src/workspace/git.ts': "import { x } from '../spec/frontmatter.ts';\nimport type { E } from './exec.ts';\n",
    'src/workspace/git.test.ts': "import { clone } from './git.ts';\n",
    'src/workspace/git.integration.test.ts': "import { clone } from './git.ts';\nimport { f } from './git-fixture.ts';\n",
    'src/workspace/git-fixture.ts': '',
    'src/workspace/exec.ts': '',
    'src/spec/frontmatter.ts': '',
    'src/claim/repos.ts': "import { clone } from '../workspace/git.ts';\nconst m = await import('../workspace/git.ts');\n",
    'scripts/tool.ts': "import { clone } from '../src/workspace/git.ts';\n",
    'src/boundaries.test.ts': "const DOMAIN = { 'workspace/git.ts': 'lib' };\n  'claim/repos.ts -> workspace/git.ts: not via lib/index.ts',\n",
  };
  for (const [f, text] of Object.entries(tree)) {
    mkdirSync(dirname(join(d, f)), { recursive: true });
    writeFileSync(join(d, f), text);
  }
  const run = () => execFileSync(process.execPath, [move, 'src/workspace/git.ts', 'src/lib/git.ts'], { cwd: d, encoding: 'utf8' });
  const read = (f: string) => readFileSync(join(d, f), 'utf8');
  run();
  assert.equal(existsSync(join(d, 'src/workspace/git.ts')), false);
  assert.equal(read('src/lib/git.ts'), "import { x } from '../spec/frontmatter.ts';\nimport type { E } from '../workspace/exec.ts';\n");
  assert.equal(read('src/lib/git.test.ts'), "import { clone } from './git.ts';\n");
  assert.equal(read('src/lib/git.integration.test.ts'), "import { clone } from './git.ts';\nimport { f } from '../workspace/git-fixture.ts';\n");
  assert.ok(existsSync(join(d, 'src/workspace/git-fixture.ts')), 'a file that only shares the prefix stays');
  assert.equal(read('src/claim/repos.ts'), "import { clone } from '../lib/git.ts';\nconst m = await import('../lib/git.ts');\n");
  assert.equal(read('scripts/tool.ts'), "import { clone } from '../src/lib/git.ts';\n");
  assert.equal(read('src/boundaries.test.ts'), "const DOMAIN = { 'lib/git.ts': 'lib' };\n  'claim/repos.ts -> lib/git.ts: not via lib/index.ts',\n");
  const before = Object.keys(tree).map((f) => existsSync(join(d, f)) && read(f));
  assert.match(run(), /nothing to move/);
  assert.deepEqual(Object.keys(tree).map((f) => existsSync(join(d, f)) && read(f)), before);
});

test('move.ts moves a directory and refuses to overwrite', (t) => {
  const d = mkdtempSync(join(tmpdir(), 'air-move-'));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  mkdirSync(join(d, 'src/serve/fixtures/panes'), { recursive: true });
  writeFileSync(join(d, 'src/serve/fixtures/panes/a.txt'), 'a');
  writeFileSync(join(d, 'src/serve/fixtures/fake.ts'), "import { y } from '../state.ts';\n");
  writeFileSync(join(d, 'src/serve/state.ts'), '');
  execFileSync(process.execPath, [move, 'src/serve/fixtures', 'src/agents/testing/fixtures'], { cwd: d });
  assert.equal(readFileSync(join(d, 'src/agents/testing/fixtures/panes/a.txt'), 'utf8'), 'a');
  assert.equal(readFileSync(join(d, 'src/agents/testing/fixtures/fake.ts'), 'utf8'), "import { y } from '../../../serve/state.ts';\n");
  assert.equal(existsSync(join(d, 'src/serve/fixtures')), false, 'emptied directories go');
  writeFileSync(join(d, 'src/serve/other.ts'), '');
  assert.throws(() => execFileSync(process.execPath, [move, 'src/serve/other.ts', 'src/serve/state.ts'], { cwd: d, stdio: 'pipe' }),
    /src\/serve\/state.ts exists/);
});

function tree(t: { after: (f: () => void) => void }, files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), 'air-move-'));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(dirname(join(d, f)), { recursive: true });
    writeFileSync(join(d, f), text);
  }
  return d;
}
const runIn = (d: string, ...args: string[]) => spawnSync(process.execPath, [move, ...args], { cwd: d, encoding: 'utf8' });

test('a file takes x-<y>.test.ts and multi-part x.<a>.<b>.test.ts along, but not tests of a longer source name', (t) => {
  const d = tree(t, {
    'src/serve/deliver.ts': '', 'src/serve/deliver-lock.test.ts': '', 'src/serve/deliver.a.b.test.ts': '',
    'src/serve/deliver-x.ts': '', 'src/serve/deliver-x.test.ts': '', 'src/serve/deliverable.test.ts': '',
  });
  assert.equal(runIn(d, 'src/serve/deliver.ts', 'src/server/deliver.ts').status, 0);
  for (const f of ['deliver.ts', 'deliver-lock.test.ts', 'deliver.a.b.test.ts']) assert.ok(existsSync(join(d, 'src/server', f)), f);
  for (const f of ['deliver-x.ts', 'deliver-x.test.ts', 'deliverable.test.ts']) assert.ok(existsSync(join(d, 'src/serve', f)), f);
});

test('an import not naming its .ts file stops the move before anything changes', (t) => {
  for (const spec of ['../a/x', '../a/x.js', '../a']) {
    const d = tree(t, { 'src/a/x.ts': '', 'src/a/index.ts': '', 'src/b/y.ts': `import '${spec}';\n` });
    const r = runIn(d, 'src/a/x.ts', 'src/c/x.ts');
    assert.equal(r.status, 1, spec);
    assert.match(r.stderr, /src\/b\/y.ts: .*name the file with its .ts or .json extension/);
    assert.ok(existsSync(join(d, 'src/a/x.ts')) && !existsSync(join(d, 'src/c')), 'nothing moved');
  }
});

test('two files moving to one path stop the move before anything changes', (t) => {
  const d = tree(t, { 'src/a/x.ts': '', 'src/b/x.ts': '' });
  const r = runIn(d, 'src/a/x.ts', 'src/c/x.ts', 'src/b/x.ts', 'src/c/x.ts');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /src\/a\/x.ts and src\/b\/x.ts would both move to src\/c\/x.ts/);
  assert.ok(existsSync(join(d, 'src/a/x.ts')) && existsSync(join(d, 'src/b/x.ts')));
});

test('a directory move renames its DOMAIN key', (t) => {
  const d = tree(t, { 'src/spec/a.ts': '', 'src/boundaries.test.ts': "const DOMAIN = { 'spec/': 'request', 'spec/a.ts': 'lib' };\n" });
  assert.equal(runIn(d, 'src/spec', 'src/request/spec').status, 0);
  assert.equal(readFileSync(join(d, 'src/boundaries.test.ts'), 'utf8'),
    "const DOMAIN = { 'request/spec/': 'request', 'request/spec/a.ts': 'lib' };\n");
});

test('running the moves again finishes an interrupted run', (t) => {
  // As if a run had renamed git.ts and stopped: its test is left behind, nothing rewritten.
  const d = tree(t, {
    'src/lib/git.ts': "import { e } from './exec.ts';\n",
    'src/workspace/git.test.ts': "import { clone } from './git.ts';\n",
    'src/workspace/exec.ts': '',
    'src/claim/repos.ts': "import { clone } from '../workspace/git.ts';\n",
  });
  const r = runIn(d, 'src/workspace/git.ts', 'src/lib/git.ts');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(d, 'src/lib/git.ts'), 'utf8'), "import { e } from '../workspace/exec.ts';\n");
  assert.equal(readFileSync(join(d, 'src/lib/git.test.ts'), 'utf8'), "import { clone } from './git.ts';\n");
  assert.equal(readFileSync(join(d, 'src/claim/repos.ts'), 'utf8'), "import { clone } from '../lib/git.ts';\n");
  assert.match(runIn(d, 'src/workspace/git.ts', 'src/lib/git.ts').stdout, /nothing to move/);
});
