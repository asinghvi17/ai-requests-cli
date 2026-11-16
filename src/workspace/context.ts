// Context zips (spec/v0.md §5): download once into one file, verify its size and SHA-256, check the
// central directory, then extract from that same file. No streaming extraction, no second download.
import { createHash } from 'node:crypto';
import { closeSync, createReadStream, openSync, rmSync, statSync, writeSync } from 'node:fs';
import { GhError, type Gh } from '../gh/gh.ts';
import type { Asset } from '../spec/frontmatter.ts';
import { extractZip, extractionCap } from './zip.ts';

export class ContextError extends Error {}

/** Writes the resource at `url` into `dest` (a new file), failing as soon as more than `maxBytes` arrive. */
export type Download = (url: string, dest: string, maxBytes: number) => Promise<void>;

const DOWNLOAD_TIMEOUT_MS = 60 * 60 * 1000;

/**
 * Downloads with the runtime's fetch, for URLs that aren't release assets on the requests repo's host. No
 * credentials are sent. The body is streamed to `dest` and the
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

/** `owner/name`, tag and asset name of a release asset download URL on `host`, if `url` is one. */
export function releaseAssetUrl(url: string, host: string): { repo: string; tag: string; name: string } | undefined {
  const m = /^https:\/\/([^/:]+)\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/releases\/download\/([^/?#]+)\/([^/?#]+)$/.exec(url);
  if (!m || m[1]!.toLowerCase() !== host.toLowerCase()) return undefined;
  try {
    return { repo: `${m[2]}/${m[3]}`, tag: decodeURIComponent(m[4]!), name: decodeURIComponent(m[5]!) };
  } catch {
    return undefined; // malformed percent-encoding
  }
}

/**
 * Downloads release assets on `host` (`https://<host>/<owner>/<repo>/releases/download/<tag>/<name>`)
 * through gh, so assets of private repos work: gh holds the credentials and air never sees them. It looks
 * the asset up by tag and name and GETs its bytes with `Accept: application/octet-stream`. Any other URL is
 * fetched without credentials (`fetchDownload`).
 */
export function releaseDownload(gh: Gh, host: string): Download {
  return async (url, dest, maxBytes) => {
    const a = releaseAssetUrl(url, host);
    if (!a) return fetchDownload(url, dest, maxBytes);
    try {
      const release = await gh.api<{ id: number }>(`repos/${a.repo}/releases/tags/${encodeURIComponent(a.tag)}`);
      const assets = await gh.paginate<{ id: number; name: string }>(`repos/${a.repo}/releases/${release.id}/assets?per_page=100`);
      const asset = assets.find((x) => x.name === a.name);
      if (!asset) throw new ContextError(`download failed: ${a.repo} has no asset ${a.name} on its ${a.tag} release`);
      await gh.download(`repos/${a.repo}/releases/assets/${asset.id}`, dest, maxBytes, { timeoutMs: DOWNLOAD_TIMEOUT_MS });
    } catch (e) {
      if (e instanceof GhError && e.kind === 'not_found') throw new ContextError(`download failed: ${url} was not found (or gh's account can't read ${a.repo})`);
      throw e instanceof GhError && /passed the \d+ bytes declared/.test(e.message) ? new ContextError(e.message) : e;
    }
  };
}

export async function sha256File(path: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest('hex');
}

/**
 * Downloads `ctx` into `zipPath`, verifies it and extracts it into `dest` (which must not exist). On any
 * failure nothing is left in `dest`. Returns the bytes extracted. `label` names the zip and where its size
 * and hash come from in messages (default: a request's context zip; a checkpoint's `resume.out` follows the
 * same rules).
 */
export async function fetchContext(
  ctx: Asset, zipPath: string, dest: string, download: Download,
  label: { what: string; from: string } = { what: 'context zip', from: 'the request' },
): Promise<number> {
  rmSync(zipPath, { force: true });
  try {
    await download(ctx.url, zipPath, ctx.bytes);
  } catch (e) {
    throw e instanceof ContextError ? e : new ContextError(`download failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  const size = statSync(zipPath).size;
  if (size !== ctx.bytes) throw new ContextError(`${label.what} is ${size} bytes, ${label.from} says ${ctx.bytes}`);
  const sha = await sha256File(zipPath);
  if (sha !== ctx.sha256.toLowerCase()) throw new ContextError(`${label.what} SHA-256 is ${sha}, ${label.from} says ${ctx.sha256}`);
  try {
    return await extractZip(zipPath, dest, extractionCap(ctx.bytes));
  } catch (e) {
    throw new ContextError(`${label.what} rejected: ${e instanceof Error ? e.message : String(e)}`);
  }
}
