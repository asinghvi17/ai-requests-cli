// A small zip writer for context zips, on node:zlib only. Each file is streamed through raw deflate into
// the output; its local header is written first with zero sizes and patched once the CRC and sizes are
// known, so no data descriptors are needed. No zip64: context zips stay under GitHub's 2 GiB asset limit.
import { closeSync, createReadStream, openSync, statSync, writeSync } from 'node:fs';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createDeflateRaw } from 'node:zlib';
import { crc32 } from '../workspace/zip.ts';

export class ZipWriteError extends Error {}

export interface ZipInput {
  /** Entry name: a relative path with `/` separators. */
  name: string;
  /** File on disk to read the entry's bytes from. */
  path: string;
}

const MAX_U32 = 0xffffffff;
const UTF8 = 0x0800;
const UNIX = 3 << 8;
const VERSION = 20;

function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.min(Math.max(d.getFullYear(), 1980), 2107);
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

function writeAll(fd: number, buf: Buffer, pos: number): void {
  for (let off = 0; off < buf.length;) off += writeSync(fd, buf, off, buf.length - off, pos + off);
}

/** Writes `entries`, in order, to a new zip at `out`. Returns the zip's size in bytes. */
export async function writeZip(out: string, entries: ZipInput[]): Promise<number> {
  if (entries.length > 0xffff) throw new ZipWriteError(`too many files for a zip without zip64 (${entries.length})`);
  const fd = openSync(out, 'wx', 0o644);
  try {
    let pos = 0;
    const central: Buffer[] = [];
    for (const e of entries) {
      const name = Buffer.from(e.name, 'utf8');
      if (name.length > 0xffff) throw new ZipWriteError(`${e.name}: name too long`);
      const st = statSync(e.path);
      const { time, date } = dosDateTime(st.mtime);
      const method = st.size === 0 ? 0 : 8;
      const headerAt = pos;
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(VERSION, 4);
      local.writeUInt16LE(UTF8, 6);
      local.writeUInt16LE(method, 8);
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      local.writeUInt16LE(name.length, 26);
      writeAll(fd, Buffer.concat([local, name]), pos);
      pos += 30 + name.length;

      let crc = 0;
      let size = 0;
      let compressed = 0;
      if (method === 8) {
        const start = pos;
        const sink = new Writable({
          write(chunk: Buffer, _enc, done) {
            try {
              writeAll(fd, chunk, start + compressed);
              compressed += chunk.length;
              if (start + compressed > MAX_U32) return done(new ZipWriteError('zip is larger than 4 GiB'));
              done();
            } catch (err) {
              done(err as Error);
            }
          },
        });
        const count = new Transform({
          transform(chunk: Buffer, _enc, done) {
            crc = crc32(chunk, crc);
            size += chunk.length;
            done(null, chunk);
          },
        });
        await pipeline(createReadStream(e.path), count, createDeflateRaw({ level: 6 }), sink);
        if (size > MAX_U32) throw new ZipWriteError(`${e.name}: larger than 4 GiB`);
        pos += compressed;
      }
      const sizes = Buffer.alloc(12);
      sizes.writeUInt32LE(crc, 0);
      sizes.writeUInt32LE(compressed, 4);
      sizes.writeUInt32LE(size, 8);
      writeAll(fd, sizes, headerAt + 14);

      const mode = (st.mode & 0o111 ? 0o100755 : 0o100644) >>> 0;
      const cd = Buffer.alloc(46);
      cd.writeUInt32LE(0x02014b50, 0);
      cd.writeUInt16LE(UNIX | VERSION, 4);
      cd.writeUInt16LE(VERSION, 6);
      cd.writeUInt16LE(UTF8, 8);
      cd.writeUInt16LE(method, 10);
      cd.writeUInt16LE(time, 12);
      cd.writeUInt16LE(date, 14);
      sizes.copy(cd, 16);
      cd.writeUInt16LE(name.length, 28);
      cd.writeUInt32LE((mode << 16) >>> 0, 38);
      cd.writeUInt32LE(headerAt, 42);
      central.push(cd, name);
    }
    const cd = Buffer.concat(central);
    if (pos + cd.length > MAX_U32) throw new ZipWriteError('zip is larger than 4 GiB');
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(cd.length, 12);
    end.writeUInt32LE(pos, 16);
    writeAll(fd, Buffer.concat([cd, end]), pos);
    return pos + cd.length + 22;
  } finally {
    closeSync(fd);
  }
}
