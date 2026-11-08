import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, closeSync, openSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { extractZip, readCentralDirectory } from '../workspace/zip.ts';
import { writeZip } from './zipwrite.ts';
import { cleanup, tmp, tree } from './fixture.ts';

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
