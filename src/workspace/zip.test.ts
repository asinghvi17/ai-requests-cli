import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextError, fetchContext, fetchDownload, type Download } from './context.ts';
import { buildZip, type FixtureEntry } from './zip-fixture.ts';
import { crc32, extractZip, extractionCap, ZipError } from './zip.ts';

const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'air-zip-'));
  dirs.push(d);
  return d;
}

/** Writes `zip` and extracts it into a fresh `context/`; returns that dir. */
async function extract(zip: Buffer, cap = 1 << 30): Promise<string> {
  const d = tmp();
  writeFileSync(join(d, 'c.zip'), zip);
  await extractZip(join(d, 'c.zip'), join(d, 'context'), cap);
  return join(d, 'context');
}

/** Asserts extraction fails with `re` and leaves no `context/` behind. */
async function rejects(zip: Buffer, re: RegExp, cap = 1 << 30): Promise<void> {
  const d = tmp();
  writeFileSync(join(d, 'c.zip'), zip);
  await assert.rejects(extractZip(join(d, 'c.zip'), join(d, 'context'), cap), (e: unknown) => e instanceof ZipError && re.test(e.message));
  assert.ok(!existsSync(join(d, 'context')), 'nothing extracted');
  assert.deepEqual(readdirSync(d), ['c.zip']);
}

const GOOD: FixtureEntry[] = [
  { name: 'data/' },
  { name: 'data/a.csv', data: 'x,y\n1,2\n'.repeat(100) },
  { name: 'data/nested/deep/b.txt', data: 'stored', deflate: false },
  { name: 'run.sh', data: '#!/bin/sh\necho hi\n', mode: 0o100755 },
  { name: 'empty.txt' },
  { name: 'dos.txt', data: 'from windows', hostOs: 0, mode: 0 },
  { name: 'ünïcode.md', data: '# hi' },
];

test('a good archive extracts exactly', async () => {
  const ctx = await extract(buildZip(GOOD));
  assert.equal(readFileSync(join(ctx, 'data/a.csv'), 'utf8'), 'x,y\n1,2\n'.repeat(100));
  assert.equal(readFileSync(join(ctx, 'data/nested/deep/b.txt'), 'utf8'), 'stored');
  assert.equal(readFileSync(join(ctx, 'empty.txt'), 'utf8'), '');
  assert.equal(readFileSync(join(ctx, 'dos.txt'), 'utf8'), 'from windows');
  assert.equal(readFileSync(join(ctx, 'ünïcode.md'), 'utf8'), '# hi');
  assert.equal(statSync(join(ctx, 'run.sh')).mode & 0o111, 0o111);
  assert.equal(statSync(join(ctx, 'data/a.csv')).mode & 0o111, 0);
});

test('zip64 central directories are read', async () => {
  const ctx = await extract(buildZip(GOOD, { zip64: true }));
  assert.equal(readFileSync(join(ctx, 'data/nested/deep/b.txt'), 'utf8'), 'stored');
});

test('path traversal is rejected before anything is written', async () => {
  for (const name of ['../evil', 'a/../../evil', 'a/..', 'ok/../../../etc/passwd', '..']) {
    await rejects(buildZip([{ name: 'first.txt', data: 'x' }, { name, data: 'pwned' }]), /`\.\.`/);
  }
});

test('absolute paths, drive letters and backslashes are rejected', async () => {
  await rejects(buildZip([{ name: '/etc/evil', data: 'x' }]), /absolute path/);
  await rejects(buildZip([{ name: '\\evil', data: 'x' }]), /absolute path/);
  await rejects(buildZip([{ name: 'C:/evil', data: 'x' }]), /drive letter/);
  await rejects(buildZip([{ name: 'c:evil', data: 'x' }]), /drive letter/);
  await rejects(buildZip([{ name: 'a\\..\\..\\evil', data: 'x' }]), /backslash/);
  await rejects(buildZip([{ name: 'a//b', data: 'x' }]), /empty or `\.` path segment/);
  await rejects(buildZip([{ name: './a', data: 'x' }]), /empty or `\.` path segment/);
  await rejects(buildZip([{ name: 'a\nb', data: 'x' }]), /control character/);
});

test('symlinks and special files are rejected', async () => {
  await rejects(buildZip([{ name: 'link', data: '/etc/passwd', mode: 0o120777, deflate: false }]), /symlink/);
  await rejects(buildZip([{ name: 'link', data: '/etc/passwd', mode: 0o120777, hostOs: 19, deflate: false }]), /symlink/);
  await rejects(buildZip([{ name: 'fifo', mode: 0o010644 }]), /special file/);
  await rejects(buildZip([{ name: 'dev', mode: 0o060644 }]), /special file/);
  await rejects(buildZip([{ name: 'sock', mode: 0o140644 }]), /special file/);
  // a directory mode on a name without a trailing slash, and vice versa
  await rejects(buildZip([{ name: 'd', mode: 0o040755 }]), /type and name disagree/);
});

test('a bomb over the cap is rejected from the central directory', async () => {
  const zeros = Buffer.alloc(2 << 20);
  await rejects(buildZip([{ name: 'a', data: zeros }, { name: 'b', data: zeros }]), /cap of 3000000 bytes \(central directory\)/, 3_000_000);
});

test('a bomb that lies about its size is stopped while writing', async () => {
  const zeros = Buffer.alloc(8 << 20);
  // Central directory says 100 bytes; the stream inflates to 8 MiB.
  await rejects(buildZip([{ name: 'bomb', data: zeros, declaredSize: 100 }]), /cap of 1000 bytes \(stopped while writing/, 1000);
  // Under a generous cap, the per-entry declared size still stops it.
  await rejects(buildZip([{ name: 'bomb', data: zeros, declaredSize: 100 }]), /larger than the central directory says/);
  await rejects(buildZip([{ name: 'short', data: 'abc', declaredSize: 10 }]), /3 bytes, central directory says 10/);
});

test('corrupt or unsupported archives are rejected', async () => {
  await rejects(Buffer.from('not a zip at all, just text that is long enough'), /no end of central directory/);
  await rejects(buildZip(GOOD, { trailing: Buffer.from('junk') }), /no end of central directory/);
  await rejects(buildZip([{ name: 'a', data: 'hello', crc: 1234 }]), /CRC mismatch/);
  await rejects(buildZip([{ name: 'a', data: 'hello', flags: 0x801 }]), /encrypted/);
  await rejects(buildZip([{ name: 'a', data: 'hello', method: 12, deflate: false }]), /compression method 12/);
  await rejects(buildZip([{ name: 'a', data: 'x' }, { name: 'a', data: 'y' }]), /duplicate/);
  await rejects(buildZip([{ name: 'a', data: 'x' }, { name: 'a/b', data: 'y' }]), /both a file and a directory/);
  await rejects(buildZip([{ name: 'a/', data: '' }, { name: 'a', data: 'y' }]), /duplicate/);
  await rejects(buildZip([{ name: 'a', data: 'x', localName: 'b' }]), /names differ/);
  await rejects(buildZip([{ name: 'caf\xe9', data: 'x', flags: 0 }]), /non-ASCII name without the UTF-8 flag/);
});

test('extraction cap is the smaller of 10 GiB and 20 × bytes', () => {
  assert.equal(extractionCap(1000), 20_000);
  assert.equal(extractionCap(2 * 1024 ** 3), 10 * 1024 ** 3);
});

test('crc32 matches the standard check value', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

// ---- context: download, verify, extract

function ctxFor(zip: Buffer, over: Partial<{ sha256: string; bytes: number }> = {}) {
  return { url: 'https://example.com/c.zip', sha256: createHash('sha256').update(zip).digest('hex'), bytes: zip.length, ...over };
}
const serve = (zip: Buffer): Download => async (_url, dest, max) => {
  if (zip.length > max) throw new ContextError(`download passed the ${max} bytes declared; aborted`);
  writeFileSync(dest, zip, { flag: 'wx' });
};

test('fetchContext verifies and extracts', async () => {
  const zip = buildZip(GOOD);
  const d = tmp();
  const n = await fetchContext(ctxFor(zip), join(d, 'c.zip'), join(d, 'context'), serve(zip));
  assert.ok(n > 800);
  assert.equal(readFileSync(join(d, 'context/data/nested/deep/b.txt'), 'utf8'), 'stored');
});

test('fetchContext rejects a sha256 mismatch and a size mismatch without extracting', async () => {
  const zip = buildZip(GOOD);
  const d = tmp();
  await assert.rejects(fetchContext(ctxFor(zip, { sha256: '0'.repeat(64) }), join(d, 'c.zip'), join(d, 'context'), serve(zip)), /SHA-256 is [0-9a-f]{64}, the request says 0{64}/);
  assert.ok(!existsSync(join(d, 'context')));
  await assert.rejects(fetchContext(ctxFor(zip, { bytes: zip.length + 5 }), join(d, 'c.zip'), join(d, 'context'), serve(zip)), /is \d+ bytes, the request says \d+/);
  await assert.rejects(fetchContext(ctxFor(zip, { bytes: zip.length - 5 }), join(d, 'c.zip'), join(d, 'context'), serve(zip)), /aborted/);
  assert.ok(!existsSync(join(d, 'context')));
});

test('fetchContext caps extraction at 20 × bytes', async () => {
  const zip = buildZip([{ name: 'z', data: Buffer.alloc(1 << 20) }]); // ~1 KiB compressed, 1 MiB inflated
  const d = tmp();
  await assert.rejects(fetchContext(ctxFor(zip), join(d, 'c.zip'), join(d, 'context'), serve(zip)), /context zip rejected: zip expands to more than the cap/);
  assert.ok(!existsSync(join(d, 'context')));
});

test('fetchDownload streams to one file and aborts past the declared size', async () => {
  const payload = Buffer.alloc(300_000, 7);
  const server = createServer((req, res) => {
    if (req.url === '/chunked') {
      res.writeHead(200); // no Content-Length
      res.write(payload.subarray(0, 150_000));
      setTimeout(() => res.end(payload.subarray(150_000)), 10);
    } else if (req.url === '/missing') {
      res.writeHead(404).end();
    } else {
      res.writeHead(200, { 'Content-Length': String(payload.length) }).end(payload);
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const d = tmp();
    await fetchDownload(`${base}/ok`, join(d, 'a'), payload.length);
    assert.ok(readFileSync(join(d, 'a')).equals(payload));
    await assert.rejects(fetchDownload(`${base}/ok`, join(d, 'b'), 1000), /more than the 1000 declared/);
    await assert.rejects(fetchDownload(`${base}/chunked`, join(d, 'c'), 200_000), /passed the 200000 bytes declared; aborted/);
    assert.ok(statSync(join(d, 'c')).size <= 200_000);
    await assert.rejects(fetchDownload(`${base}/missing`, join(d, 'e'), 10), /HTTP 404/);
    // never overwrites an existing file
    await assert.rejects(fetchDownload(`${base}/ok`, join(d, 'a'), payload.length), /EEXIST/);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
