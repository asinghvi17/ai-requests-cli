import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
