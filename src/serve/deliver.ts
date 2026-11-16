// Delivery (spec/v0.md §6) once the agent has finished: a comment with its report, a pull request from its
// commits, or a zip of out/ as a release asset. Each returns the issue comment to post, or why it failed.
// A job stopped early gets a checkpoint instead (§11): its branch pushed, its out/ zipped to an asset.
// Steps already done (pushed branch, opened PR, uploaded asset) are recorded, so a retry skips them.
import { execFile } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { code } from '../claim/text.ts';
import type { Asset, Request, Resume } from '../spec/frontmatter.ts';
import { formatResult, type AirResult, type ResultUsage } from '../spec/markers.ts';
import { sha256File } from '../workspace/context.ts';
import { githubRepo } from '../workspace/setup.ts';
import { readState, updateState, type JobRecord, type State, type UploadedAsset } from '../workspace/state.ts';
import type { ServeContext } from './context.ts';
import { ARTIFACTS_TAG } from './github.ts';
import { zipDir } from './zipout.ts';

/** GitHub's limit on a comment body. */
export const COMMENT_LIMIT = 65_536;
export const REPORT_FILE = 'REPORT.md';
export const TRUNCATED_LINE = '**Truncated:** the full report is in the attached artifact.';
const GIT_TIMEOUT_MS = 10 * 60_000;

export type Delivered = { ok: true; comment: string } | { ok: false; step: string; detail: string };

/**
 * Text the server didn't write goes into a comment it signs: any line that could read as an air marker or
 * an `air-result` line (both are matched after trimming any whitespace) is defused, so an agent's report can
 * never claim, release, report a result or refer to an asset.
 */
export function defuseMarkers(text: string): string {
  return text.split('\n').map((line) => (line.trim().startsWith('<!--') ? line.replace('<!--', '&lt;!--') : line)).join('\n');
}

/** The fence that closes a code block left open at the end of `text`, or '' if none is open. */
export function openFence(text: string): string {
  let open: { ch: string; len: number } | undefined;
  for (const line of text.split('\n')) {
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!m) continue;
    const ch = m[1]![0]!, len = m[1]!.length;
    if (!open) open = { ch, len };
    else if (ch === open.ch && len >= open.len && m[2]!.trim() === '') open = undefined;
  }
  return open ? open.ch.repeat(open.len) : '';
}

const closeFence = (text: string) => {
  const f = openFence(text);
  return f ? `${text}\n${f}` : text;
};

/** The `air-result` block (spec/v0.md §10) that ends a `done` delivery comment. */
export function doneResult(state: State, deliver: Request['deliver'], usage: ResultUsage | undefined, r: Partial<AirResult> = {}): string {
  return formatResult({ status: 'done', deliver, prs: [], ...(usage ? { usage } : {}), host: state.host, nonce: state.nonce, ...r });
}

const assetOf = (a: Asset): Asset => ({ url: a.url, sha256: a.sha256, bytes: a.bytes, ...(a.expires ? { expires: a.expires } : {}) });

/**
 * The `comment` delivery's body: the report, `footer`, then the `air-result` block `result` makes for
 * the report's place. A report that doesn't fit goes to an asset (via `upload`), and the comment becomes
 * the truncation line, the start of the report, the footer and the block, cut to fit in COMMENT_LIMIT.
 */
export async function reportComment(report: string, footer: string, upload: () => Promise<Asset>, result: (report: string) => string): Promise<string> {
  const safe = defuseMarkers(report.replace(/\s+$/, ''));
  // A fence the report leaves open would swallow the footer and the result block: close it.
  const whole = `${closeFence(safe)}\n\n${footer}\n\n${result('comment')}`;
  if (whole.length <= COMMENT_LIMIT) return whole;
  const block = result((await upload()).url);
  const head = `${TRUNCATED_LINE}\n\n`;
  const cut = '\n\n[... cut ...]\n\n';
  const tailText = `${cut}${footer}\n\n${block}`;
  // Room for a closing fence of any length the cut may need.
  const room = COMMENT_LIMIT - head.length - tailText.length;
  let start = safe.slice(0, Math.max(0, room));
  for (;;) {
    if (/[\uD800-\uDBFF]$/.test(start)) start = start.slice(0, -1); // no dangling surrogate half
    const closed = closeFence(start);
    if (closed.length <= room) return `${head}${closed}${tailText}`;
    start = start.slice(0, room - (closed.length - start.length));
  }
}

function git(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, env: { ...env, GIT_TERMINAL_PROMPT: '0' }, timeout: GIT_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 64 << 20 },
      (err, stdout, stderr) => {
        const c = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
        resolve({ code: c, stdout: String(stdout), stderr: String(stderr) });
      });
  });
}

function readReport(dir: string): string | undefined {
  const f = join(dir, 'out', REPORT_FILE);
  try {
    if (!lstatSync(f).isFile()) return undefined; // a symlink is not followed (spec §6)
    const t = readFileSync(f, 'utf8');
    return t.trim() ? t : undefined;
  } catch {
    return undefined;
  }
}

function record(dir: string, job: JobRecord, patch: NonNullable<JobRecord['delivery']>, now: Date): JobRecord {
  const next = { ...job, delivery: { ...job.delivery, ...patch } };
  updateState(dir, { job: next }, now);
  return next;
}

/**
 * Uploads `file` as asset `name` once: the upload is recorded in `job.delivery`, so a retry after a later step
 * failed (say the comment) reuses it instead of replacing it. No `expires` is written: per spec §7 the asset
 * then expires 14 days after the issue closes.
 */
async function uploadOnce(ctx: ServeContext, dir: string, name: string, file: () => string, contentType: string, files?: number): Promise<UploadedAsset> {
  // (One asset per claim: a job is either delivered or checkpointed, and only an over-long report or an
  // artifact is uploaded on delivery.)
  const job = readState(dir).job!;
  const done = job.delivery?.asset;
  if (done?.name === name) return done;
  const path = file();
  const release = await ctx.api.release(ARTIFACTS_TAG);
  const { id, url } = await ctx.api.uploadAsset(release, name, path, contentType);
  const asset: UploadedAsset = { name, id, url, sha256: await sha256File(path), bytes: statSync(path).size, ...(files !== undefined ? { files } : {}) };
  record(dir, job, { asset }, ctx.now());
  return asset;
}

async function deliverComment(ctx: ServeContext, dir: string, state: State, footer: string, usage: ResultUsage | undefined): Promise<Delivered> {
  const report = readReport(dir);
  if (report === undefined) return { ok: false, step: 'delivery', detail: `The agent finished without writing its report to \`out/${REPORT_FILE}\`.` };
  const comment = await reportComment(report, footer, async () => {
    const name = `air-${state.issue}-${state.nonce}-report.md`;
    const tmp = join(dir, `.${name}`);
    try {
      return await uploadOnce(ctx, dir, name, () => (writeFileSync(tmp, report), tmp), 'text/markdown');
    } finally {
      rmSync(tmp, { force: true });
    }
  }, (where) => doneResult(state, 'comment', usage, { report: where }));
  return { ok: true, comment };
}

/**
 * Zips the regular files of `out/` and uploads the zip once as asset `name`. Resolves to the asset, or to
 * why there is none: `out/` missing, unzippable, or without a regular file.
 */
async function uploadOut(ctx: ServeContext, dir: string, name: string): Promise<UploadedAsset | { none: string }> {
  const done = readState(dir).job?.delivery?.asset;
  if (done?.name === name) return done;
  const zip = join(dir, `.${name}`);
  rmSync(zip, { force: true });
  try {
    const out = join(dir, 'out');
    let isDir = false;
    try {
      isDir = lstatSync(out).isDirectory();
    } catch {
      // missing
    }
    if (!isDir) return { none: '`out/` is missing or not a directory' };
    let summary;
    try {
      summary = zipDir(out, zip);
    } catch (e) {
      return { none: `\`out/\` could not be zipped: ${(e as Error).message}` };
    }
    if (summary.files === 0) return { none: 'the agent left no regular file in `out/`' };
    return await uploadOnce(ctx, dir, name, () => zip, 'application/zip', summary.files);
  } finally {
    rmSync(zip, { force: true });
  }
}

const files = (n: number | undefined) => `${n} file${n === 1 ? '' : 's'}`;

async function deliverArtifact(ctx: ServeContext, dir: string, state: State, footer: string, usage: ResultUsage | undefined): Promise<Delivered> {
  const a = await uploadOut(ctx, dir, `air-${state.issue}-${state.nonce}.zip`);
  if ('none' in a) return { ok: false, step: 'delivery', detail: `There is no artifact to deliver: ${a.none}.` };
  return { ok: true, comment: `The result is a zip of ${files(a.files)} from \`out/\`: ${a.url}\n\n${footer}\n\n${doneResult(state, 'artifact', usage, { artifact: assetOf(a) })}` };
}

/** Options that keep a repo's own config from running anything (hooks, fsmonitor) while air reads it. */
const SAFE = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];

type Pushed = { ok: true; branch: string; sha: string } | { ok: false; detail: string; noBase?: true };

/**
 * Pushes the agent's work in `repo/` to the first free `air/<N>[-k]` branch of the repo's url (§6), or says
 * why there is nothing to push: no commits beyond `ref`, or `ref` isn't a branch. The chosen branch and the
 * pushed commit are recorded, so a retry pushes the same branch. Transient failures throw.
 */
async function pushWork(ctx: ServeContext, dir: string, state: State, request: Request): Promise<Pushed> {
  const repoDir = join(dir, 'repo');
  const url = request.repos[0]!.url;
  const base = request.repos[0]!.ref!;
  let job = readState(dir).job!;
  if (job.delivery?.branch && job.delivery.sha) return { ok: true, branch: job.delivery.branch, sha: job.delivery.sha };
  // The agent controlled repo/ (its config, hooks, remotes): air only reads commits from it, without
  // credentials, into a fresh bare repo, and talks to repo.url (the URL the permission check covered)
  // from there with the volunteer's credentials.
  const clean = join(dir, '.air-push.git');
  rmSync(clean, { recursive: true, force: true });
  const init = await git(['init', '--quiet', '--bare', clean], dir, ctx.env);
  if (init.code !== 0) throw new Error(`git init failed: ${init.stderr.trim()}`);
  const g = (args: string[]) => git([...SAFE, ...args], clean, ctx.env);

  const ls = await g(['ls-remote', '--heads', '--', url]);
  if (ls.code !== 0) throw new Error(`git ls-remote failed: ${ls.stderr.trim()}`);
  const heads = new Map(ls.stdout.split('\n').filter(Boolean).map((l) => {
    const [sha, ref] = l.split('\t');
    return [ref!.replace(/^refs\/heads\//, ''), sha!] as const;
  }));
  if (!heads.has(base)) return { ok: false, noBase: true, detail: `\`repos[0].ref\` (${code(base)}) is not a branch of ${url}, so there is nothing to open a pull request against.` };
  const fetchBase = await g(['fetch', '--quiet', '--no-tags', '--', url, `+refs/heads/${base}:refs/air/base`]);
  if (fetchBase.code !== 0) throw new Error(`git fetch of ${base} failed: ${fetchBase.stderr.trim()}`);

  // The agent's commits: HEAD and its local branches, fetched without running anything of the agent's.
  const fetchWork = await g(['fetch', '--quiet', '--no-tags', '--', repoDir, '+HEAD:refs/air/head', '+refs/heads/*:refs/air/work/*']);
  if (fetchWork.code !== 0) {
    const onlyHead = await g(['fetch', '--quiet', '--no-tags', '--', repoDir, '+HEAD:refs/air/head']);
    if (onlyHead.code !== 0) return { ok: false, detail: `\`repo/\` has no commits air can read (${fetchWork.stderr.trim()}).` };
  }
  const ahead = async (rev: string) => Number((await g(['rev-list', '--count', `refs/air/base..${rev}`])).stdout.trim()) || 0;
  let head: string | undefined;
  if (await ahead('refs/air/head') > 0) head = (await g(['rev-parse', 'refs/air/head'])).stdout.trim();
  else {
    const refs = (await g(['for-each-ref', '--sort=-committerdate', '--format=%(objectname)', 'refs/air/work'])).stdout.split('\n').filter(Boolean);
    for (const sha of refs) if (await ahead(sha) > 0) { head = sha; break; }
  }
  if (!head || !/^[0-9a-f]{40,64}$/.test(head)) {
    return { ok: false, detail: `the agent made no commits beyond ${code(base)}. Uncommitted changes are not delivered.` };
  }
  let branch = job.delivery?.branch;
  if (!branch) {
    branch = `air/${state.issue}`;
    for (let k = 2; heads.has(branch); k++) branch = `air/${state.issue}-${k}`;
    // Recorded before the push, so a retry after a crash pushes the same branch rather than the next one.
    job = record(dir, job, { branch }, ctx.now());
  }
  const push = await g(['push', '--quiet', '--porcelain', '--force', '--', url, `${head}:refs/heads/${branch}`]);
  if (push.code !== 0) throw new Error(`git push of ${branch} failed: ${push.stderr.trim() || push.stdout.trim()}`);
  rmSync(clean, { recursive: true, force: true });
  record(dir, job, { sha: head }, ctx.now());
  return { ok: true, branch, sha: head };
}

async function deliverPr(ctx: ServeContext, dir: string, state: State, request: Request, footer: string, usage: ResultUsage | undefined): Promise<Delivered> {
  const base = request.repos[0]!.ref!;
  const target = githubRepo(request.repos[0]!.url, ctx.ghHost);
  if ('error' in target) return { ok: false, step: 'delivery', detail: target.error };

  if (!readState(dir).job!.delivery?.prUrl) {
    const pushed = await pushWork(ctx, dir, state, request);
    if (!pushed.ok) return { ok: false, step: 'delivery', detail: pushed.noBase ? pushed.detail : `No changes were produced: ${pushed.detail}` };
    const summary = readReport(dir) ?? '(The agent left no summary.)';
    const pr = { title: `air: ${state.title} (#${state.issue})`, head: pushed.branch, base, body: `Closes ${ctx.gh.repo}#${state.issue}\n\n${defuseMarkers(summary.trim())}\n` };
    let prUrl: string;
    try {
      prUrl = await ctx.api.createPull(target.repo, pr);
    } catch (e) {
      // A PR from an earlier attempt whose response was lost: use it.
      const existing = await ctx.api.findPull(target.repo, pushed.branch).catch(() => undefined);
      if (!existing) throw e;
      prUrl = existing;
    }
    record(dir, readState(dir).job!, { prUrl }, ctx.now());
  }
  const d = readState(dir).job!.delivery!;
  const prs = [{ repo: request.repos[0]!.path, url: d.prUrl! }];
  return { ok: true, comment: `Opened ${d.prUrl} from branch \`${d.branch}\`.\n\n${footer}\n\n${doneResult(state, 'pr', usage, { prs })}` };
}

/** A checkpoint (§11): what it keeps, as `resume` (undefined when it keeps nothing), and a description. */
export interface Checkpoint {
  resume?: Resume;
  text: string;
}

/**
 * Makes the checkpoint of a job stopped early (spec §11): with `deliver: pr`, the agent's commits pushed as
 * `air/<N>[-k]` (no pull request); and `out/`, if it holds a regular file, zipped and uploaded as
 * `air-<N>-<nonce>-out.zip`. Uncommitted changes are left out.
 */
export async function checkpoint(ctx: ServeContext, dir: string, state: State, request: Request): Promise<Checkpoint> {
  const lines: string[] = [];
  const resume: Resume = { branches: [] };
  const repo = request.repos[0];
  if (request.deliver === 'pr' && repo && existsSync(join(dir, 'repo'))) {
    const pushed = await pushWork(ctx, dir, state, request);
    if (pushed.ok) {
      resume.branches.push({ repo: repo.path, branch: pushed.branch, sha: pushed.sha });
      lines.push(`- \`${repo.path}\`: the agent's commits, pushed to branch \`${pushed.branch}\` of ${repo.url} (\`${pushed.sha.slice(0, 12)}\`). Uncommitted changes are not kept.`);
    } else {
      lines.push(`- \`${repo.path}\`: nothing pushed: ${pushed.detail}`);
    }
  }
  const out = await uploadOut(ctx, dir, `air-${state.issue}-${state.nonce}-out.zip`);
  if ('none' in out) lines.push(`- \`out/\`: nothing kept: ${out.none}.`);
  else {
    resume.out = assetOf(out);
    lines.push(`- \`out/\`: ${files(out.files)}, zipped: ${out.url}`);
  }
  const kept = resume.branches.length > 0 || resume.out !== undefined;
  return {
    ...(kept ? { resume } : {}),
    text: `${kept ? 'The checkpoint keeps the work so far' : 'There is no checkpoint: nothing of the work so far could be kept'}:\n\n${lines.join('\n')}`,
  };
}

export async function deliver(ctx: ServeContext, dir: string, state: State, request: Request, footer: string, usage: ResultUsage | undefined): Promise<Delivered> {
  if (request.deliver === 'comment') return deliverComment(ctx, dir, state, footer, usage);
  if (request.deliver === 'artifact') return deliverArtifact(ctx, dir, state, footer, usage);
  if (!existsSync(join(dir, 'repo'))) return { ok: false, step: 'delivery', detail: 'The workspace has no `repo/` checkout.' };
  return deliverPr(ctx, dir, state, request, footer, usage);
}
