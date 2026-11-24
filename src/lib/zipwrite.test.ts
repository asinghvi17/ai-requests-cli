import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { extractZip, readCentralDirectory } from './zip.ts';
import { badEntryName, writeZip, ZipWriteError } from './zipwrite.ts';
import { cleanup, tmp, tree } from '../submit/fixture.ts';

after(cleanup);

test('writeZip output round-trips through the workspace zip reader', async () => {
  const random = randomBytes(300_000);
  const files: Record<string, string | Buffer> = {
    'a.txt': 'hello\n',
    'empty': '',
    'data/big.csv': 'x,y\n1,2\n'.repeat(50_000),
    'data/random.bin': random,
    'deep/er/still/ünïcode name.md': '# hi\n',
  };
  const src = tree(files);
  chmodSync(join(src, 'a.txt'), 0o755);
  const out = join(tmp(), 'c.zip');
  const names = Object.keys(files);
  const bytes = await writeZip(out, names.map((n) => ({ name: n, path: join(src, ...n.split('/')) })));
  assert.equal(bytes, statSync(out).size);

  const fd = openSync(out, 'r');
  const cd = readCentralDirectory(fd);
  closeSync(fd);
  assert.deepEqual(cd.entries.map((e) => e.name), names);
  assert.equal(cd.entries.find((e) => e.name === 'empty')!.method, 0);
  assert.equal(cd.entries.find((e) => e.name === 'data/big.csv')!.method, 8);
  assert.ok(cd.entries.find((e) => e.name === 'data/big.csv')!.compressedSize < 50_000, 'deflated');

  const dest = join(tmp(), 'context');
  const written = await extractZip(out, dest, 1 << 30);
  assert.equal(written, Object.values(files).reduce((n, d) => n + Buffer.byteLength(d), 0));
  for (const [n, d] of Object.entries(files)) assert.deepEqual(readFileSync(join(dest, ...n.split('/'))), Buffer.from(d), n);
  assert.ok(statSync(join(dest, 'a.txt')).mode & 0o100, 'executable bit kept');
  assert.equal(statSync(join(dest, 'empty')).mode & 0o111, 0);
});

test('writeZip writes a valid empty archive and refuses to overwrite', async () => {
  const out = join(tmp(), 'e.zip');
  assert.equal(await writeZip(out, []), 22);
  const fd = openSync(out, 'r');
  assert.deepEqual(readCentralDirectory(fd).entries, []);
  closeSync(fd);
  await assert.rejects(writeZip(out, []), /EEXIST/);
});

test('non-ASCII names are stored as flagged UTF-8 and mode bits survive', async () => {
  const names = ['日本語/ファイル.txt', 'emoji-😀.md', 'Ελληνικά', 'run.sh'];
  const src = tree(Object.fromEntries(names.map((n) => [n, `content of ${n}\n`])));
  chmodSync(join(src, 'run.sh'), 0o750);
  chmodSync(join(src, 'Ελληνικά'), 0o600);
  const out = join(tmp(), 'u.zip');
  await writeZip(out, names.map((n) => ({ name: n, path: join(src, ...n.split('/')) })));
  const fd = openSync(out, 'r');
  const cd = readCentralDirectory(fd);
  closeSync(fd);
  assert.deepEqual(cd.entries.map((e) => e.name), names);
  // The writer records 0o755 for any executable file and 0o644 otherwise.
  assert.deepEqual(cd.entries.map((e) => e.mode! & 0o777), [0o644, 0o644, 0o644, 0o755]);
  const raw = readFileSync(out);
  assert.equal(raw.readUInt16LE(6) & 0x0800, 0x0800, 'UTF-8 flag in the local header');
  const dest = join(tmp(), 'context');
  await extractZip(out, dest, 1 << 20);
  for (const n of names) assert.equal(readFileSync(join(dest, ...n.split('/')), 'utf8'), `content of ${n}\n`);
  assert.ok(statSync(join(dest, 'run.sh')).mode & 0o100);
});

test('writeZip rejects names the spec forbids, before creating anything', async () => {
  const src = tree({ 'a.txt': 'a' });
  const bad: [string, RegExp][] = [
    ['/etc/passwd', /absolute/], ['\\x', /absolute/], ['C:/x', /drive letter/], ['c:x', /drive letter/], ['a\\b', /backslash/],
    ['../x', /\.\./], ['a/../../x', /\.\./], ['a/..', /\.\./], ['a//b', /empty/], ['./a', /`\.`/], ['a/', /empty/], ['', /empty/],
    ['a\nb', /control/],
  ];
  for (const [name, re] of bad) {
    const out = join(tmp(), 'bad.zip');
    await assert.rejects(writeZip(out, [{ name, path: join(src, 'a.txt') }]), (e: unknown) => e instanceof ZipWriteError && re.test(e.message), JSON.stringify(name));
    assert.ok(!existsSync(out), JSON.stringify(name));
  }
  for (const name of ['a..b', '..a/b', 'x/...', 'a b/c']) assert.equal(badEntryName(name), undefined, name);
});

test('writeZip refuses symlinks and other non-regular files, and removes the partial zip', async () => {
  const src = tree({ 'a.txt': 'a'.repeat(100_000), 'target.txt': 'secret' });
  symlinkSync(join(src, 'target.txt'), join(src, 'link'));
  mkdirSync(join(src, 'dir'));
  for (const [name, path] of [['link', join(src, 'link')], ['dir', join(src, 'dir')]] as const) {
    const out = join(tmp(), 'p.zip');
    // The good first entry is written before the bad one is reached.
    await assert.rejects(writeZip(out, [{ name: 'a.txt', path: join(src, 'a.txt') }, { name, path }]), (e: unknown) =>
      e instanceof ZipWriteError && /not a regular file/.test(e.message));
    assert.ok(!existsSync(out), `${name}: partial zip removed`);
    // So a retry doesn't trip over EEXIST.
    await writeZip(out, [{ name: 'a.txt', path: join(src, 'a.txt') }]);
    assert.ok(existsSync(out));
  }
  const out = join(tmp(), 'm.zip');
  await assert.rejects(writeZip(out, [{ name: 'gone', path: join(src, 'missing') }]), /ENOENT/);
  assert.ok(!existsSync(out));
});
