// Delivery (spec/v0.md §6) once the agent has finished: a comment with its report, a pull request per repo
// it changed, or a zip of out/ as a release asset. Each returns the issue comment to post, or why it failed.
// A job stopped early gets a checkpoint instead (§11): its branches pushed, its out/ zipped to an asset.
// Steps already done (pushed branches, opened PRs, uploaded asset) are recorded, so a retry skips them.
import { existsSync, lstatSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { code } from '../claim/text.ts';
import { delivers } from '../claim/repos.ts';
import type { Asset, RepoEntry, Request, Resume } from '../spec/frontmatter.ts';
import { formatResult, type AirResult, type ResultUsage } from '../spec/markers.ts';
import { sha256File } from '../workspace/context.ts';
import { githubRepo, gitOut } from '../workspace/git.ts';
import { readState, updateState, type JobRecord, type RepoDelivery, type State, type UploadedAsset } from '../workspace/state.ts';
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
  return `${head}${cutToFit(safe, COMMENT_LIMIT - head.length - tailText.length)}${tailText}`;
}

/** The start of `text`, with any fence the cut leaves open closed, in at most `room` characters. */
function cutToFit(text: string, room: number): string {
  let start = text.slice(0, Math.max(0, room));
  for (;;) {
    if (/[\uD800-\uDBFF]$/.test(start)) start = start.slice(0, -1); // no dangling surrogate half
    const closed = closeFence(start);
    if (closed.length <= room) return closed;
    start = start.slice(0, room - (closed.length - start.length));
  }
}

const git = (args: string[], cwd: string, env: NodeJS.ProcessEnv) => gitOut(args, { cwd, env, timeoutMs: GIT_TIMEOUT_MS });

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

/** What delivery recorded for the repo at `path` so far. */
function repoRecord(dir: string, path: string): RepoDelivery {
  return readState(dir).job!.delivery?.repos?.[path] ?? {};
}

function recordRepo(ctx: ServeContext, dir: string, path: string, patch: RepoDelivery): void {
  const job = readState(dir).job!;
  const repos = { ...job.delivery?.repos, [path]: { ...job.delivery?.repos?.[path], ...patch } };
  record(dir, job, { repos }, ctx.now());
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

/** Uploads the full report once, as `air-<N>-<nonce>-report.md`, for a comment or PR body it doesn't fit in (§6). */
async function uploadReport(ctx: ServeContext, dir: string, state: State, report: string): Promise<UploadedAsset> {
  const name = `air-${state.issue}-${state.nonce}-report.md`;
  const tmp = join(dir, `.${name}`);
  try {
    return await uploadOnce(ctx, dir, name, () => (writeFileSync(tmp, report), tmp), 'text/markdown');
  } finally {
    rmSync(tmp, { force: true });
  }
}

async function deliverComment(ctx: ServeContext, dir: string, state: State, footer: string, usage: ResultUsage | undefined): Promise<Delivered> {
  const report = readReport(dir);
  if (report === undefined) return { ok: false, step: 'delivery', detail: `The agent finished without writing its report to \`out/${REPORT_FILE}\`.` };
  const comment = await reportComment(report, footer, () => uploadReport(ctx, dir, state, report), (where) => doneResult(state, 'comment', usage, { report: where }));
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

type Pushed = { ok: true; branch: string; sha: string } | { ok: false; detail: string };

/**
 * Pushes the agent's work in `repo/<path>` (§6), or says why there is nothing to push: no commits beyond the
 * commit the entry resolved to when claimed. A resumed request continues its checkpoint's branch (`resume`,
 * §11): the push moves that branch on, as long as it still points where the checkpoint left it. Otherwise the
 * work goes to the first free `air/<N>[-k]` branch of the entry's url. The chosen branch and the pushed commit
 * are recorded per repo, so a retry pushes the same branch. Transient failures throw.
 */
async function pushWork(ctx: ServeContext, dir: string, state: State, request: Request, entry: RepoEntry): Promise<Pushed> {
  const repoDir = join(dir, 'repo', entry.path);
  const url = entry.url;
  const base = state.repos.find((r) => r.path === entry.path)?.sha;
  if (!base) throw new Error(`the claim recorded no commit for repo/${entry.path}`);
  const done = repoRecord(dir, entry.path);
  if (done.branch && done.sha) return { ok: true, branch: done.branch, sha: done.sha };
  // The agent controlled repo/<path> (its config, hooks, remotes): air only reads commits from it, without
  // credentials, into a fresh bare repo, and talks to the entry's url (the URL the permission checks
  // covered) from there with the volunteer's credentials.
  const clean = join(dir, '.air-push.git');
  rmSync(clean, { recursive: true, force: true });
  const init = await git(['init', '--quiet', '--bare', clean], dir, ctx.env);
  if (init.code !== 0) throw new Error(`git init failed: ${init.stderr.trim()}`);
  const g = (args: string[]) => git([...SAFE, ...args], clean, ctx.env);

  // The agent's commits: HEAD and its local branches, fetched without running anything of the agent's.
  const fetchWork = await g(['fetch', '--quiet', '--no-tags', '--', repoDir, '+HEAD:refs/air/head', '+refs/heads/*:refs/air/work/*']);
  if (fetchWork.code !== 0) {
    const onlyHead = await g(['fetch', '--quiet', '--no-tags', '--', repoDir, '+HEAD:refs/air/head']);
    if (onlyHead.code !== 0) return { ok: false, detail: `\`repo/${entry.path}\` has no commits air can read (${fetchWork.stderr.trim()}).` };
  }
  // Commits count from the commit the entry resolved to; if the agent's history doesn't hold it, fetch it.
  if ((await g(['cat-file', '-e', `${base}^{commit}`])).code !== 0) {
    const fetchBase = await g(['fetch', '--quiet', '--no-tags', '--', url, base]);
    if (fetchBase.code !== 0) throw new Error(`git fetch of ${base} from ${url} failed: ${fetchBase.stderr.trim()}`);
  }
  const ahead = async (rev: string) => Number((await g(['rev-list', '--count', rev, '--not', base])).stdout.trim()) || 0;
  let head: string | undefined;
  if (await ahead('refs/air/head') > 0) head = (await g(['rev-parse', 'refs/air/head'])).stdout.trim();
  else {
    const refs = (await g(['for-each-ref', '--sort=-committerdate', '--format=%(objectname)', 'refs/air/work'])).stdout.split('\n').filter(Boolean);
    for (const sha of refs) if (await ahead(sha) > 0) { head = sha; break; }
  }
  if (!head || !/^[0-9a-f]{40,64}$/.test(head)) {
    return { ok: false, detail: `no commits beyond \`${base.slice(0, 12)}\`. Uncommitted changes are not delivered.` };
  }
  const ls = await g(['ls-remote', '--heads', '--', url]);
  if (ls.code !== 0) throw new Error(`git ls-remote failed: ${ls.stderr.trim()}`);
  const heads = new Map(ls.stdout.split('\n').filter(Boolean).map((l) => {
    const [sha, ref] = l.split('\t');
    return [ref!.replace(/^refs\/heads\//, ''), sha!] as const;
  }));
  const checkpoint = request.resume?.branches.find((b) => b.repo === entry.path);
  let branch = done.branch;
  let force = ['--force'];
  if (checkpoint) {
    branch = checkpoint.branch;
    const now = heads.get(branch);
    // Ours to move on: the checkpoint's commit, gone (say deleted after the partial result), or already this push.
    if (now !== undefined && now !== checkpoint.sha && now !== head) {
      return { ok: false, detail: `the checkpoint branch \`${branch}\` moved since the checkpoint (it is at \`${now.slice(0, 12)}\`, not \`${checkpoint.sha.slice(0, 12)}\`), so air did not overwrite it.` };
    }
    // The check above and the push are one step on the remote: the push fails if the branch moved meanwhile.
    force = [`--force-with-lease=refs/heads/${branch}:${now ?? ''}`];
    if (!done.branch) recordRepo(ctx, dir, entry.path, { branch });
  } else if (!branch) {
    branch = `air/${state.issue}`;
    for (let k = 2; heads.has(branch); k++) branch = `air/${state.issue}-${k}`;
    // Recorded before the push, so a retry after a crash pushes the same branch rather than the next one.
    recordRepo(ctx, dir, entry.path, { branch });
  }
  const push = await g(['push', '--quiet', '--porcelain', ...force, '--', url, `${head}:refs/heads/${branch}`]);
  if (push.code !== 0) throw new Error(`git push of ${branch} to ${url} failed: ${push.stderr.trim() || push.stdout.trim()}`);
  rmSync(clean, { recursive: true, force: true });
  recordRepo(ctx, dir, entry.path, { sha: head });
  return { ok: true, branch, sha: head };
}

/** Room in a pull request's body for the `Part of` line and each sibling's line. */
const PR_LINE_ROOM = 512;

/**
 * The agent's report for the bodies of `prs` pull requests (§6), made safe. One that doesn't fit next to the
 * `Part of` line and the siblings in GitHub's body limit (COMMENT_LIMIT) is uploaded whole, and the body gets
 * a line pointing at it and the report's start.
 */
async function prSummary(ctx: ServeContext, dir: string, state: State, prs: number): Promise<string> {
  const report = readReport(dir);
  if (report === undefined) return '(The agent left no summary.)';
  // A fence the report leaves open would swallow the siblings list: close it.
  const safe = closeFence(defuseMarkers(report.trim()));
  const room = COMMENT_LIMIT - PR_LINE_ROOM * (prs + 1);
  if (safe.length <= room) return safe;
  const head = `**Truncated:** the full report is ${(await uploadReport(ctx, dir, state, report)).url}\n\n`;
  const cut = '\n\n[... cut ...]';
  return `${head}${cutToFit(safe, room - head.length - cut.length)}${cut}`;
}

/** A pull request's body (§6): the requests issue, the agent's summary and, once all are open, its siblings. */
function prBody(ctx: ServeContext, state: State, summary: string, siblings: string[]): string {
  const others = siblings.length ? `\n\nThe other pull requests for this request:\n\n${siblings.map((u) => `- ${u}`).join('\n')}\n` : '';
  return `Part of ${ctx.gh.repo}#${state.issue}\n\n${summary}\n${others}`;
}

/**
 * `deliver: pr` (§6): for each repo without `deliver: none` that has commits, push `air/<N>[-k]` and open a
 * pull request against the entry's `ref`; once all are open, add each one's siblings to its body. No repo
 * with commits fails the request.
 */
async function deliverPr(ctx: ServeContext, dir: string, state: State, request: Request, footer: string, usage: ResultUsage | undefined): Promise<Delivered> {
  const entries = request.repos.filter((e) => delivers(request, e));
  const summary = await prSummary(ctx, dir, state, entries.length);
  const without: string[] = [];
  for (const entry of entries) {
    if (repoRecord(dir, entry.path).prUrl) continue;
    const target = githubRepo(entry.url, ctx.ghHost);
    if ('error' in target) return { ok: false, step: 'delivery', detail: target.error };
    const pushed = await pushWork(ctx, dir, state, request, entry);
    if (!pushed.ok) {
      without.push(`- ${code(entry.path)}: ${pushed.detail}`);
      continue;
    }
    const pr = { title: `air: ${state.title} (#${state.issue})`, head: pushed.branch, base: entry.ref!, body: prBody(ctx, state, summary, []) };
    let prUrl: string;
    try {
      prUrl = await ctx.api.createPull(target.repo, pr);
    } catch (e) {
      // A PR from an earlier attempt whose response was lost: use it.
      const existing = await ctx.api.findPull(target.repo, pushed.branch).catch(() => undefined);
      if (!existing) throw e;
      prUrl = existing;
    }
    recordRepo(ctx, dir, entry.path, { prUrl });
  }
  const opened = entries.map((e) => ({ entry: e, rec: repoRecord(dir, e.path) })).filter((x) => x.rec.prUrl);
  if (opened.length === 0) return { ok: false, step: 'delivery', detail: `No changes were produced:\n\n${without.join('\n')}` };
  if (opened.length > 1) {
    for (const { entry, rec } of opened) {
      if (rec.linked) continue;
      const target = githubRepo(entry.url, ctx.ghHost) as { repo: string };
      const number = Number(/\/pull\/(\d+)$/.exec(rec.prUrl!)?.[1]);
      if (!Number.isSafeInteger(number) || number < 1) throw new Error(`can't tell the number of pull request ${rec.prUrl}`);
      await ctx.api.updatePull(target.repo, number, prBody(ctx, state, summary, opened.filter((o) => o.entry !== entry).map((o) => o.rec.prUrl!)));
      recordRepo(ctx, dir, entry.path, { linked: true });
    }
  }
  const prs = opened.map(({ entry, rec }) => ({ repo: entry.path, url: rec.prUrl! }));
  const list = opened.map(({ entry, rec }) => `- ${code(entry.path)}: ${rec.prUrl} from branch \`${rec.branch}\``).join('\n');
  const rest = without.length ? `\n\nNo pull request for:\n\n${without.join('\n')}` : '';
  return { ok: true, comment: `Opened ${opened.length === 1 ? 'a pull request' : `${opened.length} pull requests`}:\n\n${list}${rest}\n\n${footer}\n\n${doneResult(state, 'pr', usage, { prs })}` };
}

/** A checkpoint (§11): what it keeps, as `resume` (undefined when it keeps nothing), and a description. */
export interface Checkpoint {
  resume?: Resume;
  text: string;
}

/**
 * Makes the checkpoint of a job stopped early (spec §11): with `deliver: pr`, the agent's commits in each repo
 * without `deliver: none` pushed as `air/<N>[-k]` (no pull request); and `out/`, if it holds a regular file, zipped and uploaded as
 * `air-<N>-<nonce>-out.zip`. Uncommitted changes are left out.
 */
export async function checkpoint(ctx: ServeContext, dir: string, state: State, request: Request): Promise<Checkpoint> {
  const lines: string[] = [];
  const resume: Resume = { branches: [] };
  for (const entry of request.repos) {
    if (!delivers(request, entry) || !existsSync(join(dir, 'repo', entry.path))) continue;
    const pushed = await pushWork(ctx, dir, state, request, entry);
    if (pushed.ok) {
      resume.branches.push({ repo: entry.path, branch: pushed.branch, sha: pushed.sha });
      lines.push(`- ${code(entry.path)}: the agent's commits, pushed to branch \`${pushed.branch}\` of ${entry.url} (\`${pushed.sha.slice(0, 12)}\`). Uncommitted changes are not kept.`);
    } else {
      lines.push(`- ${code(entry.path)}: nothing pushed: ${pushed.detail}`);
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
  return deliverPr(ctx, dir, state, request, footer, usage);
}
