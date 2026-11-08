// Builds zips for tests, including malformed and hostile ones: every header field can be overridden.
import { deflateRawSync } from 'node:zlib';
import { crc32 } from './zip.ts';

export interface FixtureEntry {
  name: string;
  data?: Buffer | string;
  /** Compress with deflate (default true for files with data). */
  deflate?: boolean;
  /** Unix mode (type and permission bits) in the external attributes; 0 for none. */
  mode?: number;
  /** "Version made by" host byte: 3 Unix (default), 0 MS-DOS. */
  hostOs?: number;
  /** Override the uncompressed size written to the central directory. */
  declaredSize?: number;
  crc?: number;
  flags?: number;
  method?: number;
  /** Name in the local header, when it should differ from the central one. */
  localName?: string;
}

/** `zip64`: central sizes and offsets go in zip64 extra fields, with a zip64 end record and locator. */
export function buildZip(entries: FixtureEntry[], opts: { trailing?: Buffer; zip64?: boolean } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const raw = Buffer.from(e.data ?? '');
    const isDir = e.name.endsWith('/');
    const deflate = e.deflate ?? (!isDir && raw.length > 0);
    const body = deflate ? deflateRawSync(raw) : raw;
    const method = e.method ?? (deflate ? 8 : 0);
    const name = Buffer.from(e.name, 'utf8');
    const localName = Buffer.from(e.localName ?? e.name, 'utf8');
    const flags = e.flags ?? 0x800;
    const crc = e.crc ?? crc32(raw);
    const size = e.declaredSize ?? raw.length;
    const mode = e.mode ?? (isDir ? 0o040755 : 0o100644);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(flags, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(size, 22);
    lh.writeUInt16LE(localName.length, 26);
    locals.push(lh, localName, body);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(((e.hostOs ?? 3) << 8) | 20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(flags, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(opts.zip64 ? 0xffffffff : body.length, 20);
    ch.writeUInt32LE(opts.zip64 ? 0xffffffff : size, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(((mode << 16) | (isDir ? 0x10 : 0)) >>> 0, 38);
    ch.writeUInt32LE(opts.zip64 ? 0xffffffff : offset, 42);
    let extra = Buffer.alloc(0);
    if (opts.zip64) {
      extra = Buffer.alloc(28);
      extra.writeUInt16LE(0x0001, 0);
      extra.writeUInt16LE(24, 2);
      extra.writeBigUInt64LE(BigInt(size), 4);
      extra.writeBigUInt64LE(BigInt(body.length), 12);
      extra.writeBigUInt64LE(BigInt(offset), 20);
      ch.writeUInt16LE(extra.length, 30);
    }
    centrals.push(ch, name, extra);
    offset += 30 + localName.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  let z64 = Buffer.alloc(0);
  if (opts.zip64) {
    end.writeUInt16LE(0xffff, 8);
    end.writeUInt16LE(0xffff, 10);
    end.writeUInt32LE(0xffffffff, 12);
    end.writeUInt32LE(0xffffffff, 16);
    const rec = Buffer.alloc(56);
    rec.writeUInt32LE(0x06064b50, 0);
    rec.writeBigUInt64LE(44n, 4);
    rec.writeUInt16LE(45, 12);
    rec.writeUInt16LE(45, 14);
    rec.writeBigUInt64LE(BigInt(entries.length), 24);
    rec.writeBigUInt64LE(BigInt(entries.length), 32);
    rec.writeBigUInt64LE(BigInt(cd.length), 40);
    rec.writeBigUInt64LE(BigInt(offset), 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0);
    loc.writeBigUInt64LE(BigInt(offset + cd.length), 8);
    loc.writeUInt32LE(1, 16);
    z64 = Buffer.concat([rec, loc]);
  } else {
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(cd.length, 12);
    end.writeUInt32LE(offset, 16);
  }
  return Buffer.concat([...locals, cd, z64, end, opts.trailing ?? Buffer.alloc(0)]);
}
