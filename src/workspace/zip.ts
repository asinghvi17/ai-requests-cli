// A small zip reader for context zips (spec/v0.md §5), on node:zlib only. It reads the central directory,
// checks every entry before anything is written, then extracts from the same verified file, counting
// the bytes it actually writes because the sizes in the central directory can lie.
import { closeSync, createReadStream, fstatSync, mkdirSync, openSync, readSync, rmSync, writeSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createInflateRaw } from 'node:zlib';

export class ZipError extends Error {}

export interface ZipEntry {
  name: string;
  dir: boolean;
  /** 0 stored, 8 deflate. */
  method: number;
  compressedSize: number;
  /** Uncompressed size claimed by the central directory. */
  size: number;
  crc: number;
  localOffset: number;
  /** Unix permission bits, when the archive records them. */
  mode?: number;
  /** Raw name bytes, compared with the local header's copy. */
  rawName: Buffer;
}

export interface CentralDirectory {
  entries: ZipEntry[];
  /** Where the central directory starts: no entry's data may run past it. */
  offset: number;
}

const GiB = 1024 ** 3;
/** Largest uncompressed total for a context zip of `bytes` bytes: 10 GiB or 20 × `bytes`, whichever is smaller. */
export function extractionCap(bytes: number): number {
  return Math.min(10 * GiB, 20 * bytes);
}

const MAX_CD_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 1_000_000;

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;

function readAt(fd: number, pos: number, len: number): Buffer {
  const buf = Buffer.alloc(len);
  let got = 0;
  while (got < len) {
    const n = readSync(fd, buf, got, len - got, pos + got);
    if (n === 0) throw new ZipError('zip is truncated');
    got += n;
  }
  return buf;
}

function u64(buf: Buffer, at: number): number {
  const v = buf.readBigUInt64LE(at);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipError('zip64 value out of range');
  return Number(v);
}

/** Reads and parses the central directory of the zip open on `fd`. Doesn't judge entry names or types. */
export function readCentralDirectory(fd: number): CentralDirectory {
  const fileSize = fstatSync(fd).size;
  if (fileSize < 22) throw new ZipError('not a zip: too short');
  const tailLen = Math.min(fileSize, 22 + 0xffff);
  const tail = readAt(fd, fileSize - tailLen, tailLen);
  // The end record must end the file exactly: take the last signature whose comment length fits.
  let eocd = -1;
  for (let i = tailLen - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tailLen) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError('not a zip: no end of central directory record');
  const eocdPos = fileSize - tailLen + eocd;
  let disk = tail.readUInt16LE(eocd + 4);
  let cdDisk = tail.readUInt16LE(eocd + 6);
  let diskEntries = tail.readUInt16LE(eocd + 8);
  let count = tail.readUInt16LE(eocd + 10);
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOffset = tail.readUInt32LE(eocd + 16);
  if (count === 0xffff || diskEntries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff || disk === 0xffff || cdDisk === 0xffff) {
    if (eocdPos < 20) throw new ZipError('zip64 locator missing');
    const loc = readAt(fd, eocdPos - 20, 20);
    if (loc.readUInt32LE(0) !== 0x07064b50) throw new ZipError('zip64 locator missing');
    if (loc.readUInt32LE(16) !== 1) throw new ZipError('multi-disk zips are not supported');
    const at = u64(loc, 8);
    if (at + 56 > eocdPos - 20) throw new ZipError('bad zip64 end record offset');
    const z = readAt(fd, at, 56);
    if (z.readUInt32LE(0) !== 0x06064b50) throw new ZipError('bad zip64 end record');
    disk = z.readUInt32LE(16);
    cdDisk = z.readUInt32LE(20);
    diskEntries = u64(z, 24);
    count = u64(z, 32);
    cdSize = u64(z, 40);
    cdOffset = u64(z, 48);
  }
  if (disk !== 0 || cdDisk !== 0 || diskEntries !== count) throw new ZipError('multi-disk zips are not supported');
  if (count > MAX_ENTRIES) throw new ZipError(`zip has ${count} entries (limit ${MAX_ENTRIES})`);
  if (cdSize > MAX_CD_BYTES) throw new ZipError('zip central directory is too large');
  if (cdOffset + cdSize > eocdPos) throw new ZipError('zip central directory runs past its end record');

  const cd = readAt(fd, cdOffset, cdSize);
  const entries: ZipEntry[] = [];
  let p = 0;
  while (p < cd.length) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) throw new ZipError(`bad central directory header at entry ${entries.length + 1}`);
    const madeBy = cd.readUInt16LE(p + 4);
    const flags = cd.readUInt16LE(p + 8);
    const method = cd.readUInt16LE(p + 10);
    const crc = cd.readUInt32LE(p + 16);
    let compressedSize = cd.readUInt32LE(p + 20);
    let size = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    let diskStart = cd.readUInt16LE(p + 34);
    const external = cd.readUInt32LE(p + 38);
    let localOffset = cd.readUInt32LE(p + 42);
    const end = p + 46 + nameLen + extraLen + commentLen;
    if (end > cd.length) throw new ZipError(`central directory entry ${entries.length + 1} is truncated`);
    const rawName = Buffer.from(cd.subarray(p + 46, p + 46 + nameLen));
    // zip64 extended information: the 64-bit values of the fields that are saturated, in this order.
    const extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
    for (let q = 0; q + 4 <= extra.length;) {
      const id = extra.readUInt16LE(q);
      const len = extra.readUInt16LE(q + 2);
      if (q + 4 + len > extra.length) throw new ZipError('bad extra field');
      if (id === 0x0001) {
        let r = q + 4;
        const take = () => {
          if (r + 8 > q + 4 + len) throw new ZipError('bad zip64 extra field');
          const v = u64(extra, r);
          r += 8;
          return v;
        };
        if (size === 0xffffffff) size = take();
        if (compressedSize === 0xffffffff) compressedSize = take();
        if (localOffset === 0xffffffff) localOffset = take();
        if (diskStart === 0xffff) {
          if (r + 4 > q + 4 + len) throw new ZipError('bad zip64 extra field');
          diskStart = extra.readUInt32LE(r);
        }
      }
      q += 4 + len;
    }
    if (diskStart !== 0) throw new ZipError('multi-disk zips are not supported');
    if (flags & 0x1) throw new ZipError(`${printable(rawName)}: encrypted entries are not supported`);
    let name: string;
    if (flags & 0x800) {
      try {
        name = new TextDecoder('utf-8', { fatal: true }).decode(rawName);
      } catch {
        throw new ZipError(`${printable(rawName)}: name is not valid UTF-8`);
      }
    } else {
      if (rawName.some((b) => b >= 0x80)) throw new ZipError(`${printable(rawName)}: non-ASCII name without the UTF-8 flag`);
      name = rawName.toString('latin1');
    }
    // Unix (3) and OS X (19) both keep st_mode in the high 16 bits.
    const unixMode = madeBy >> 8 === 3 || madeBy >> 8 === 19 ? external >>> 16 : 0;
    let dir: boolean;
    let mode: number | undefined;
    if (unixMode !== 0) {
      const type = unixMode & S_IFMT;
      if (type === S_IFDIR) dir = true;
      else if (type === S_IFREG) dir = false;
      else throw new ZipError(`${printable(rawName)}: ${type === 0o120000 ? 'symlink' : 'special file'} entries are not allowed`);
      mode = unixMode & 0o7777;
    } else {
      dir = name.endsWith('/') || (external & 0x10) !== 0;
    }
    if (dir !== name.endsWith('/')) throw new ZipError(`${printable(rawName)}: entry type and name disagree`);
    entries.push({ name, dir, method, compressedSize, size, crc, localOffset, rawName, ...(mode === undefined ? {} : { mode }) });
    if (entries.length > count) break;
    p = end;
  }
  if (entries.length !== count) throw new ZipError(`central directory lists ${entries.length} entries, end record says ${count}`);
  return { entries, offset: cdOffset };
}

function printable(raw: Buffer | string): string {
  return JSON.stringify(typeof raw === 'string' ? raw : raw.toString('latin1'));
}

/**
 * Checks every entry against the spec before anything is written: relative names that stay inside `dest`,
 * regular files and directories only, supported compression, no duplicates or file/directory clashes,
 * and a declared uncompressed total within `cap`.
 */
export function checkEntries(cd: CentralDirectory, dest: string, cap: number): void {
  const root = resolve(dest);
  const files = new Set<string>();
  const dirs = new Set<string>();
  let total = 0;
  for (const e of cd.entries) {
    const n = e.name;
    const what = printable(n);
    if (n === '' || n === '/') throw new ZipError(`${what}: empty entry name`);
    if (/[\x00-\x1f\x7f]/.test(n)) throw new ZipError(`${what}: control character in entry name`);
    if (n.startsWith('/') || n.startsWith('\\') || isAbsolute(n)) throw new ZipError(`${what}: absolute path`);
    if (/^[A-Za-z]:/.test(n)) throw new ZipError(`${what}: drive letter`);
    if (n.includes('\\')) throw new ZipError(`${what}: backslash in entry name`);
    const path = e.dir ? n.slice(0, -1) : n;
    const segs = path.split('/');
    if (segs.includes('..')) throw new ZipError(`${what}: \`..\` in entry name`);
    if (segs.some((s) => s === '' || s === '.')) throw new ZipError(`${what}: empty or \`.\` path segment`);
    const target = resolve(root, path);
    if (!target.startsWith(root + sep)) throw new ZipError(`${what}: resolves outside context/`);
    if (e.method !== 0 && e.method !== 8) throw new ZipError(`${what}: unsupported compression method ${e.method}`);
    if (e.dir && e.size !== 0) throw new ZipError(`${what}: directory entry with data`);
    if (e.method === 0 && e.compressedSize !== e.size) throw new ZipError(`${what}: stored entry sizes disagree`);
    if (e.localOffset + 30 + e.compressedSize > cd.offset) throw new ZipError(`${what}: entry data runs into the central directory`);
    if (files.has(path) || (!e.dir && dirs.has(path))) throw new ZipError(`${what}: duplicate entry`);
    (e.dir ? dirs : files).add(path);
    for (let i = 1; i < segs.length; i++) dirs.add(segs.slice(0, i).join('/'));
    total += e.size;
    if (total > cap) throw new ZipError(`zip expands to more than the cap of ${cap} bytes (central directory)`);
  }
  for (const f of files) if (dirs.has(f)) throw new ZipError(`${printable(f)}: both a file and a directory`);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Uint8Array, crc = 0): number {
  let c = ~crc >>> 0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return ~c >>> 0;
}

/**
 * Extracts the verified zip `file` into `dest` (created here; it must not exist). Checks the central
 * directory first and writes nothing if any entry fails. While writing, stops as soon as the bytes
 * written pass `cap` or an entry outgrows its declared size, and checks each entry's CRC. On any failure
 * `dest` is removed, so nothing stays extracted. Returns the bytes written.
 */
export async function extractZip(file: string, dest: string, cap: number): Promise<number> {
  const fd = openSync(file, 'r');
  try {
    const cd = readCentralDirectory(fd);
    checkEntries(cd, dest, cap);
    mkdirSync(dest, { mode: 0o755 });
    try {
      let written = 0;
      for (const e of cd.entries) {
        const path = e.dir ? e.name.slice(0, -1) : e.name;
        const target = join(dest, ...path.split('/'));
        if (e.dir) {
          mkdirSync(target, { recursive: true });
          continue;
        }
        const segs = path.split('/');
        if (segs.length > 1) mkdirSync(join(dest, ...segs.slice(0, -1)), { recursive: true });
        written = await extractEntry(fd, file, e, cd.offset, target, written, cap);
      }
      return written;
    } catch (err) {
      rmSync(dest, { recursive: true, force: true });
      throw err;
    }
  } finally {
    closeSync(fd);
  }
}

async function extractEntry(fd: number, file: string, e: ZipEntry, cdOffset: number, target: string, before: number, cap: number): Promise<number> {
  const what = printable(e.name);
  const local = readAt(fd, e.localOffset, 30);
  if (local.readUInt32LE(0) !== 0x04034b50) throw new ZipError(`${what}: bad local header`);
  if (local.readUInt16LE(6) & 0x1) throw new ZipError(`${what}: encrypted entries are not supported`);
  if (local.readUInt16LE(8) !== e.method) throw new ZipError(`${what}: local and central compression methods differ`);
  const nameLen = local.readUInt16LE(26);
  const extraLen = local.readUInt16LE(28);
  if (!readAt(fd, e.localOffset + 30, nameLen).equals(e.rawName)) throw new ZipError(`${what}: local and central names differ`);
  const start = e.localOffset + 30 + nameLen + extraLen;
  if (start + e.compressedSize > cdOffset) throw new ZipError(`${what}: entry data runs into the central directory`);

  const out = openSync(target, 'wx', e.mode !== undefined && e.mode & 0o111 ? 0o755 : 0o644);
  let total = before;
  let size = 0;
  let crc = 0;
  try {
    const sink = new Writable({
      write(chunk: Buffer, _enc, done) {
        size += chunk.length;
        total += chunk.length;
        if (total > cap) return done(new ZipError(`zip expands to more than the cap of ${cap} bytes (stopped while writing ${what})`));
        if (size > e.size) return done(new ZipError(`${what}: larger than the central directory says`));
        crc = crc32(chunk, crc);
        try {
          for (let off = 0; off < chunk.length;) off += writeSync(out, chunk, off);
        } catch (err) {
          return done(err as Error);
        }
        done();
      },
    });
    if (e.compressedSize > 0) {
      const src = createReadStream(file, { start, end: start + e.compressedSize - 1 });
      if (e.method === 8) await pipeline(src, createInflateRaw(), sink);
      else await pipeline(src, sink);
    } else if (e.method === 8) {
      throw new ZipError(`${what}: empty deflate stream`);
    }
  } finally {
    closeSync(out);
  }
  if (size !== e.size) throw new ZipError(`${what}: ${size} bytes, central directory says ${e.size}`);
  if (crc !== e.crc) throw new ZipError(`${what}: CRC mismatch`);
  return total;
}
