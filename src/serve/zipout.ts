// Zips `out/` for `deliver: artifact` (spec/v0.md §6): regular files and directories only. Symlinks and
// special files are neither followed nor included. Each file is read, deflated and written in turn; no
// zip64, so the archive and every entry must stay under 4 GiB.
import { closeSync, lstatSync, openSync, readdirSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { crc32 } from '../workspace/zip.ts';

const LIMIT = 0xffffffff;

export interface ZipSummary {
  /** Regular files written. Zero means there is nothing to deliver. */
  files: number;
  bytes: number;
}

/** Relative paths under `dir`, directories with a trailing `/`, depth first in name order. */
export function listTree(dir: string): { name: string; dir: boolean }[] {
  const out: { name: string; dir: boolean }[] = [];
  const walk = (rel: string) => {
    for (const entry of readdirSync(join(dir, rel)).sort()) {
      const name = rel ? `${rel}/${entry}` : entry;
      const st = lstatSync(join(dir, name));
      if (st.isDirectory()) {
        out.push({ name: `${name}/`, dir: true });
        walk(name);
      } else if (st.isFile()) {
        out.push({ name, dir: false });
      }
    }
  };
  walk('');
  return out;
}

/** Writes the zip of `dir` to `dest` (a new file). */
export function zipDir(dir: string, dest: string): ZipSummary {
  const entries = listTree(dir);
  const fd = openSync(dest, 'wx', 0o600);
  const central: Buffer[] = [];
  let offset = 0;
  let files = 0;
  const write = (b: Buffer) => {
    for (let off = 0; off < b.length;) off += writeSync(fd, b, off);
    offset += b.length;
  };
  try {
    for (const e of entries) {
      const raw = e.dir ? Buffer.alloc(0) : readFileSync(join(dir, e.name));
      const body = raw.length ? deflateRawSync(raw) : raw;
      const method = raw.length ? 8 : 0;
      const crc = crc32(raw);
      const name = Buffer.from(e.name, 'utf8');
      if (raw.length > LIMIT || offset + body.length > LIMIT) throw new Error(`out/ is too large to zip (over 4 GiB)`);
      const mode = e.dir ? 0o040755 : 0o100644;

      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0);
      lh.writeUInt16LE(20, 4);
      lh.writeUInt16LE(0x800, 6); // UTF-8 names
      lh.writeUInt16LE(method, 8);
      lh.writeUInt32LE(crc, 14);
      lh.writeUInt32LE(body.length, 18);
      lh.writeUInt32LE(raw.length, 22);
      lh.writeUInt16LE(name.length, 26);

      const ch = Buffer.alloc(46);
      ch.writeUInt32LE(0x02014b50, 0);
      ch.writeUInt16LE((3 << 8) | 20, 4); // made by Unix
      ch.writeUInt16LE(20, 6);
      ch.writeUInt16LE(0x800, 8);
      ch.writeUInt16LE(method, 10);
      ch.writeUInt32LE(crc, 16);
      ch.writeUInt32LE(body.length, 20);
      ch.writeUInt32LE(raw.length, 24);
      ch.writeUInt16LE(name.length, 28);
      ch.writeUInt32LE(((mode << 16) | (e.dir ? 0x10 : 0)) >>> 0, 38);
      ch.writeUInt32LE(offset, 42);
      central.push(ch, name);

      write(lh);
      write(name);
      write(body);
      if (!e.dir) files++;
    }
    const cd = Buffer.concat(central);
    if (entries.length > 0xffff || offset + cd.length > LIMIT) throw new Error('out/ has too many entries to zip');
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(cd.length, 12);
    end.writeUInt32LE(offset, 16); // the central directory starts here
    write(cd);
    write(end);
    return { files, bytes: offset };
  } finally {
    closeSync(fd);
  }
}
