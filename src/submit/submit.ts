// `air submit`: lint a request body, zip and upload its context directory to the `air-context` release,
// fill in `context:` and file the issue with the `ai-request` label (spec/v0.md §2, §5).
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { CONTEXT_TAG, releases as releasesApi, type Releases } from '../gh/releases.ts';
import { fitTitle, lint, taskSummary, type LintResult } from '../spec/lint.ts';
import { splitLines, type Diagnostic } from '../spec/frontmatter.ts';
import { sha256File } from '../workspace/context.ts';
import { DEFAULT_EXCLUDES, collectFiles } from './collect.ts';
import { allowed, findSecrets } from './secrets.ts';
import { writeZip, ZipWriteError } from './zipwrite.ts';

export const REQUEST_LABEL = 'ai-request';
const MAX_ASSET_BYTES = 2 * 1024 ** 3;

export interface ContextFields {
  url: string;
  sha256: string;
  bytes: number;
  expires?: string;
}

export class SubmitError extends Error {
  /** Lint result, when the body was refused for failing lint. */
  readonly lint: LintResult | undefined;
  constructor(message: string, result?: LintResult) {
    super(message);
    this.lint = result;
  }
}

export interface SubmitOptions {
  /** `owner/name` of the requests repo. */
  repo: string;
  /** The request body (front matter and sections), or a filled-in copy of the issue template. */
  body: string;
  title?: string;
  /** Directory to zip as the request's context. */
  dir?: string;
  dryRun?: boolean;
  /** Paths (relative to `dir`) that look like secrets but may be included. */
  allowFiles?: readonly string[];
  /** Directory names skipped at any depth. Default `DEFAULT_EXCLUDES`. */
  excludes?: readonly string[];
  /**
   * `context.expires`, `YYYY-MM-DD`. Absent by default, so spec §7's default applies: the zip is kept 14
   * days after the issue closes.
   */
  expires?: string;
  now?: Date;
  /** Injectable for tests; default: the real repo through gh. */
  releases?: Releases;
  /** Progress lines, without trailing newlines. */
  log?: (line: string) => void;
}

export interface SubmitResult {
  title: string;
  body: string;
  /** Files in the context zip, relative to `dir`. */
  files: string[];
  /** Set when an issue was filed. */
  issue?: { number: number; url: string };
  context?: ContextFields;
}

/**
 * Blanks out GitHub's issue-template header (`name:`, `about:` ...) when it precedes the request's front
 * matter, so a filled-in copy of the template lints with the line numbers of the file.
 */
export function blankTemplateHeader(body: string): string {
  const lines = splitLines(body);
  let i = 0;
  while (i < lines.length && lines[i]!.trim() === '') i++;
  if (lines[i]?.trimEnd() !== '---') return lines.join('\n');
  let close = i + 1;
  while (close < lines.length && lines[close]!.trimEnd() !== '---') close++;
  const header = lines.slice(i + 1, close);
  const isTemplate = close < lines.length && header.some((l) => /^about:/.test(l)) && header.some((l) => /^name:/.test(l)) && !header.some((l) => /^air:/.test(l));
  if (isTemplate) for (let k = i; k <= close; k++) lines[k] = '';
  return lines.join('\n');
}

/**
 * Inserts a `context:` map at the end of the front matter. Returns the new body and where the block went
 * (0-based line index and length), so diagnostics can be mapped back to the original lines.
 */
export function fillContext(body: string, ctx: ContextFields): { body: string; at: number; count: number } {
  const lines = splitLines(body);
  let open = 0;
  while (open < lines.length && lines[open]!.trim() === '') open++;
  let close = open + 1;
  while (close < lines.length && lines[close]!.trimEnd() !== '---') close++;
  if (lines[open]?.trimEnd() !== '---' || close >= lines.length) throw new SubmitError('the body must start with a `---` front-matter block');
  const block = ['context:', `  url: ${ctx.url}`, `  sha256: ${ctx.sha256}`, `  bytes: ${ctx.bytes}`];
  if (ctx.expires !== undefined) block.push(`  expires: ${ctx.expires}`);
  return { body: [...lines.slice(0, close), ...block, ...lines.slice(close)].join('\n'), at: close, count: block.length };
}

function hasContextKey(body: string): boolean {
  const lines = splitLines(body);
  let open = 0;
  while (open < lines.length && lines[open]!.trim() === '') open++;
  for (let i = open + 1; i < lines.length && lines[i]!.trimEnd() !== '---'; i++) if (/^context\s*:/.test(lines[i]!)) return true;
  return false;
}

/** A title from the first line of `## Task`, for bodies submitted without `--title`. */
export function titleFromTask(result: LintResult): string | undefined {
  const line = taskSummary(result.sections);
  return line === undefined ? undefined : fitTitle(line);
}

function assetName(dir: string, now: Date): string {
  const slug = basename(resolve(dir)).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+|-+$/g, '').slice(0, 40) || 'context';
  return `${slug}-${now.toISOString().slice(0, 10).replaceAll('-', '')}-${randomBytes(4).toString('hex')}.zip`;
}

/** Maps diagnostics on the filled-in body back to the lines of the body as given. */
function refuseLint(result: LintResult, inserted?: { at: number; count: number }): never {
  if (inserted) {
    const map = (d: Diagnostic): Diagnostic => {
      const i = d.line - 1;
      if (i < inserted.at) return d;
      if (i < inserted.at + inserted.count) return { ...d, line: inserted.at + 1, message: `in the generated \`context:\`: ${d.message}` };
      return { ...d, line: d.line - inserted.count };
    };
    result = { ...result, errors: result.errors.map(map), warnings: result.warnings.map(map) };
  }
  throw new SubmitError('the request does not pass `air lint`', result);
}

export async function submit(opts: SubmitOptions): Promise<SubmitResult> {
  const now = opts.now ?? new Date();
  const log = opts.log ?? (() => {});
  let body = blankTemplateHeader(opts.body);
  let inserted: { at: number; count: number } | undefined;
  const expires = opts.expires;
  if (expires !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expires) || Number.isNaN(Date.parse(`${expires}T00:00:00Z`))) throw new SubmitError(`--expires must be YYYY-MM-DD, got ${JSON.stringify(expires)}`);
    if (expires < now.toISOString().slice(0, 10)) throw new SubmitError(`--expires ${expires} is in the past`);
  }

  let files: string[] = [];
  let zip: { path: string; tmp: string; ctx: SubmitResult['context'] & {} } | undefined;
  try {
    if (opts.dir !== undefined) {
      if (hasContextKey(body)) throw new SubmitError('the body already sets `context:`; remove it, or submit without a directory');
      const dir = resolve(opts.dir);
      const collected = collectFiles(dir, opts.excludes ?? DEFAULT_EXCLUDES);
      for (const s of collected.skipped) log(`skipping ${s}: not a regular file`);
      const secrets = findSecrets(dir, collected.files).filter((s) => !allowed(s.path, opts.allowFiles ?? []));
      if (secrets.length > 0) {
        const list = secrets.map((s) => `  ${s.path}: ${s.reason}`).join('\n');
        throw new SubmitError(`refusing to upload files that look like secrets:\n${list}\nRemove them, add them to .gitignore, or pass --allow-file PATH for each one you are sure about.`);
      }
      files = collected.files;
      if (files.length === 0) throw new SubmitError(`${opts.dir}: no files to zip`);
      const tmp = mkdtempSync(join(tmpdir(), 'air-submit-'));
      const path = join(tmp, assetName(dir, now));
      zip = { path, tmp, ctx: { url: '', sha256: '', bytes: 0, ...(expires !== undefined ? { expires } : {}) } };
      try {
        zip.ctx.bytes = await writeZip(path, files.map((f) => ({ name: f, path: join(dir, ...f.split('/')) })));
      } catch (e) {
        if (e instanceof ZipWriteError) throw new SubmitError(`can't zip ${opts.dir}: ${e.message}`);
        throw e;
      }
      if (zip.ctx.bytes > MAX_ASSET_BYTES) throw new SubmitError(`the context zip is ${zip.ctx.bytes} bytes; release assets are limited to 2 GiB`);
      zip.ctx.sha256 = await sha256File(path);
      // Where GitHub will serve it; replaced by the uploaded asset's own URL below.
      zip.ctx.url = `https://github.com/${opts.repo}/releases/download/${CONTEXT_TAG}/${basename(path)}`;
      const filled = fillContext(body, zip.ctx);
      body = filled.body;
      inserted = filled;
    }

    let result = lint(body);
    if (!result.ok) refuseLint(result, inserted);
    const title = opts.title?.trim() || titleFromTask(result);
    if (!title) throw new SubmitError('no title: pass --title or start `## Task` with a one-line summary');

    // Leading blank lines (a blanked template header) mean nothing on GitHub.
    body = body.replace(/^\n+/, '');
    if (opts.dryRun) return zip ? { title, body, files, context: zip.ctx } : { title, body, files };

    const api = opts.releases ?? releasesApi(opts.repo);
    let uploaded: { id: number } | undefined;
    try {
      if (zip) {
        log(`uploading ${basename(zip.path)} (${zip.ctx.bytes} bytes) to ${opts.repo} release ${CONTEXT_TAG}`);
        const asset = await api.upload(CONTEXT_TAG, zip.path);
        uploaded = asset;
        if (asset.size !== zip.ctx.bytes) throw new SubmitError(`uploaded ${asset.name} is ${asset.size} bytes, expected ${zip.ctx.bytes}`);
        if (asset.url !== zip.ctx.url) {
          body = body.replace(`  url: ${zip.ctx.url}\n`, `  url: ${asset.url}\n`);
          zip.ctx.url = asset.url;
          result = lint(body);
          if (!result.ok) refuseLint(result);
        }
      }
      const issue = await api.createIssue(title, body, [REQUEST_LABEL]);
      return zip ? { title, body, files, issue, context: zip.ctx } : { title, body, files, issue };
    } catch (e) {
      // Nothing refers to the zip without its issue, so `air sweep` would never collect it.
      if (uploaded) await api.deleteAsset(uploaded.id).catch(() => {});
      throw e;
    }
  } finally {
    if (zip) rmSync(zip.tmp, { recursive: true, force: true });
  }
}
