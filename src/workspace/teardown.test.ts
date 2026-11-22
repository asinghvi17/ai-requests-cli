import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeWorkspace } from './teardown.ts';

const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'air-teardown-'));
  dirs.push(d);
  return d;
};

/** A workspace with a file, a nested dir and a symlink out of it, under a fresh root. */
function workspace(root = tmp()) {
  const dir = join(root, 'o__requests', '7-aaaaaaaaaaaa');
  mkdirSync(join(dir, 'repo', 'x'), { recursive: true });
  writeFileSync(join(dir, 'state.json'), '{}');
  const outside = join(tmp(), 'precious');
  writeFileSync(outside, 'keep me');
  symlinkSync(outside, join(dir, 'repo', 'link'));
  return { root, dir, outside };
}

test('a workspace goes with everything in it; what its symlinks point at, and its repo dir, stay', () => {
  const { root, dir, outside } = workspace();
  removeWorkspace(root, dir);
  assert.equal(existsSync(dir), false);
  assert.equal(existsSync(outside), true);
  assert.equal(existsSync(join(root, 'o__requests')), true);
});

test('a workspace_root that is itself a symlink is fine', () => {
  const { root, dir } = workspace();
  const link = join(tmp(), 'root');
  symlinkSync(root, link);
  removeWorkspace(link, join(link, 'o__requests', '7-aaaaaaaaaaaa'));
  assert.equal(existsSync(dir), false);
});

test('nothing but <root>/<owner>__<name>/<issue>-<nonce> is ever removed', () => {
  const { root, dir } = workspace();
  const elsewhere = workspace();
  const refused = (d: string, why: RegExp) => assert.throws(() => removeWorkspace(root, d), why);
  refused(join(root, 'o__requests', '..', '..', 'etc'), /not in a requests repo directory|not a workspace/);
  refused(join(root, 'o__requests', '7-aaaaaaaaaaaa', '..', '7-aaaaaaaaaaaa', 'repo'), /not in a requests repo directory/);
  refused(join(root, 'o__requests'), /not in a requests repo directory/);
  refused(elsewhere.dir, /not a workspace directly under/);
  refused(join(root, 'o__requests', 'notes'), /not a workspace directly under/);
  // A symlinked workspace, or repo dir, pointing elsewhere.
  symlinkSync(elsewhere.dir, join(root, 'o__requests', '8-bbbbbbbbbbbb'));
  refused(join(root, 'o__requests', '8-bbbbbbbbbbbb'), /is a symlink/);
  symlinkSync(join(elsewhere.root, 'o__requests'), join(root, 'o__other'));
  refused(join(root, 'o__other', '7-aaaaaaaaaaaa'), /is a symlink/);
  assert.equal(existsSync(dir), true);
  assert.equal(existsSync(elsewhere.dir), true);
});
