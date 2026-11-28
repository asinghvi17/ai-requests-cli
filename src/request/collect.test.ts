import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { collectFiles, ignored, parseGitignore } from './collect.ts';
import { cleanup, tree } from './testing/submit.ts';

after(cleanup);

const match = (pattern: string, path: string, dir = false) => ignored(parseGitignore(pattern), path, dir);

test('gitignore patterns', () => {
  // Unanchored names match at any depth.
  assert.ok(match('*.log', 'a.log'));
  assert.ok(match('*.log', 'x/y/a.log'));
  assert.ok(!match('*.log', 'a.log.txt'));
  // A leading or inner slash anchors to the .gitignore's directory.
  assert.ok(match('/build', 'build', true));
  assert.ok(!match('/build', 'src/build', true));
  assert.ok(match('doc/*.txt', 'doc/a.txt'));
  assert.ok(!match('doc/*.txt', 'doc/x/a.txt'));
  assert.ok(!match('doc/*.txt', 'x/doc/a.txt'));
  // Trailing slash: directories only.
  assert.ok(match('out/', 'out', true));
  assert.ok(!match('out/', 'out', false));
  // ** forms.
  assert.ok(match('**/cache', 'a/b/cache', true));
  assert.ok(match('**/cache', 'cache', true));
  assert.ok(match('a/**/z', 'a/z'));
  assert.ok(match('a/**/z', 'a/b/c/z'));
  assert.ok(match('a/**', 'a/b/c'));
  assert.ok(!match('a/**', 'a', true));
  // ? and classes.
  assert.ok(match('file?.txt', 'file1.txt'));
  assert.ok(!match('file?.txt', 'file12.txt'));
  assert.ok(match('[ab].md', 'b.md'));
  assert.ok(!match('[!ab].md', 'b.md'));
  assert.ok(match('[!ab].md', 'c.md'));
  // A negated class never matches a path separator.
  assert.ok(!match('x[!ab]y', 'x/y'));
  assert.ok(!match('/x[!ab]y', 'x/y'));
  assert.ok(match('x[!ab]y', 'xcy'));
  // Negation: the last matching rule wins.
  assert.ok(!match('*.log\n!keep.log', 'keep.log'));
  assert.ok(match('*.log\n!keep.log\nkeep.log', 'keep.log'));
  // Comments, blanks, escapes and trailing spaces.
  assert.ok(!match('# a\n\n', 'a'));
  assert.ok(match('\\#x', '#x'));
  assert.ok(match('\\!x', '!x'));
  assert.ok(match('name   ', 'name'));
});

test('collectFiles honours nested .gitignore files and default excludes, and skips symlinks', () => {
  const root = tree({
    '.gitignore': '*.log\n/dist/\nsecret-dir/\n!important.log\n',
    'a.txt': 'a',
    'important.log': 'keep',
    'debug.log': 'drop',
    'dist/out.js': 'x',
    'src/dist/kept.js': 'x',
    'src/.gitignore': 'gen/\n*.tmp\n',
    'src/gen/x.ts': 'x',
    'src/main.ts': 'x',
    'src/a.tmp': 'x',
    'other/a.tmp': 'kept: src/.gitignore does not apply here',
    'secret-dir/x': 'x',
    'secret-dir-not/x': 'x',
    '.git/config': 'x',
    'node_modules/m/index.js': 'x',
    'pkg/node_modules/m/index.js': 'x',
    '.venv/bin/python': 'x',
  });
  symlinkSync(join(root, 'a.txt'), join(root, 'link'));
  const r = collectFiles(root);
  assert.deepEqual(r.files, [
    '.gitignore', 'a.txt', 'important.log', 'other/a.tmp', 'secret-dir-not/x', 'src/.gitignore', 'src/dist/kept.js', 'src/main.ts',
  ]);
  assert.deepEqual(r.skipped, ['link']);
  // The exclude list is configurable.
  const all = collectFiles(root, ['.git']);
  assert.ok(all.files.includes('node_modules/m/index.js'));
  assert.ok(all.files.includes('.venv/bin/python'));
  assert.ok(!all.files.some((f) => f.startsWith('.git/')));
});
