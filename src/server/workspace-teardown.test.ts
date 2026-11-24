import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTrash, removeWorkspace } from './workspace-teardown.ts';

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

test('a trailing slash is resolved first: a symlinked workspace given as dir/ is still refused', () => {
  const { root, dir } = workspace();
  const elsewhere = workspace();
  const link = join(root, 'o__requests', '8-bbbbbbbbbbbb');
  symlinkSync(elsewhere.dir, link);
  // lstat of 'link/' would follow the link and see a directory.
  assert.throws(() => removeWorkspace(root, `${link}/`), /is a symlink/);
  assert.throws(() => removeWorkspace(root, `${link}//`), /is a symlink/);
  assert.equal(existsSync(elsewhere.dir), true);
  removeWorkspace(root, `${dir}/`);
  assert.equal(existsSync(dir), false);
  assert.deepEqual(readdirSync(join(root, 'o__requests')), ['8-bbbbbbbbbbbb'], 'no trash left');
});

test('what is removed is checked after it is renamed aside: an entry swapped for a symlink is never followed', () => {
  // The state removeWorkspace's check after the rename sees when the workspace was swapped for a symlink in
  // between (or a crash left a trash entry that was then swapped): removeTrash runs the same check.
  const { root } = workspace();
  const elsewhere = workspace();
  const trash = join(root, 'o__requests', '.9-cccccccccccc.trash-0123456789ab');
  symlinkSync(elsewhere.dir, trash);
  assert.throws(() => removeTrash(root, 'o/requests'), /swapped for a symlink/);
  assert.equal(existsSync(join(elsewhere.dir, 'state.json')), true);
  rmSync(trash);
  // A repo dir swapped for a symlink: the renamed entry's real path is outside root.
  const real = join(root, 'o__real');
  mkdirSync(join(elsewhere.root, 'o__requests', '.9-cccccccccccc.trash-0123456789ab', 'x'), { recursive: true });
  symlinkSync(join(elsewhere.root, 'o__requests'), real);
  assert.throws(() => removeTrash(root, 'o/real'), /swapped for a symlink|outside/);
  assert.equal(existsSync(join(elsewhere.root, 'o__requests', '.9-cccccccccccc.trash-0123456789ab')), true);
  // A real one a crash left behind goes.
  const left = join(root, 'o__requests', '.7-aaaaaaaaaaaa.trash-0123456789ab');
  mkdirSync(join(left, 'repo'), { recursive: true });
  assert.deepEqual(removeTrash(root, 'o/requests'), [left]);
  assert.equal(existsSync(left), false);
});
