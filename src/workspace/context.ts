// Context zips (spec/v0.md §5): download once into one file, verify its size and SHA-256, check the
// central directory, then extract from that same file. No streaming extraction, no second download.
import { createHash } from 'node:crypto';
import { closeSync, createReadStream, openSync, rmSync, statSync, writeSync } from 'node:fs';
import type { ContextZip } from '../spec/frontmatter.ts';
import { extractZip, extractionCap } from './zip.ts';

export class ContextError extends Error {}

/** Writes the resource at `url` into `dest` (a new file), failing as soon as more than `maxBytes` arrive. */
export type Download = (url: string, dest: string, maxBytes: number) => Promise<void>;

const DOWNLOAD_TIMEOUT_MS = 60 * 60 * 1000;

/**
 * Downloads with the runtime's fetch. No credentials are sent. The body is streamed to `dest` and the
 * download aborts the moment it passes `maxBytes`, whatever Content-Length said.
 */
export const fetchDownload: Download = async (url, dest, maxBytes) => {
  const fd = openSync(dest, 'wx', 0o600);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new ContextError('download timed out')), DOWNLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctl.signal, redirect: 'follow' });
    if (!res.ok || !res.body) throw new ContextError(`download failed: HTTP ${res.status}`);
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) throw new ContextError(`download is ${declared} bytes, more than the ${maxBytes} declared`);
    let got = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.byteLength;
      if (got > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new ContextError(`download passed the ${maxBytes} bytes declared; aborted`);
      }
      for (let off = 0; off < value.byteLength;) off += writeSync(fd, value, off);
    }
  } catch (e) {
    ctl.abort(); // drop the connection rather than leave an unread body holding it open
    throw e;
  } finally {
    clearTimeout(timer);
    closeSync(fd);
  }
};

export async function sha256File(path: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest('hex');
}

/**
 * Downloads `ctx` into `zipPath`, verifies it and extracts it into `dest` (which must not exist). On any
 * failure nothing is left in `dest`. Returns the bytes extracted.
 */
export async function fetchContext(ctx: ContextZip, zipPath: string, dest: string, download: Download = fetchDownload): Promise<number> {
  rmSync(zipPath, { force: true });
  try {
    await download(ctx.url, zipPath, ctx.bytes);
  } catch (e) {
    throw e instanceof ContextError ? e : new ContextError(`download failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  const size = statSync(zipPath).size;
  if (size !== ctx.bytes) throw new ContextError(`context zip is ${size} bytes, the request says ${ctx.bytes}`);
  const sha = await sha256File(zipPath);
  if (sha !== ctx.sha256.toLowerCase()) throw new ContextError(`context zip SHA-256 is ${sha}, the request says ${ctx.sha256}`);
  try {
    return await extractZip(zipPath, dest, extractionCap(ctx.bytes));
  } catch (e) {
    throw new ContextError(`context zip rejected: ${e instanceof Error ? e.message : String(e)}`);
  }
}
