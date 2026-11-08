// Delivery (spec/v0.md §6) once the agent has finished: a comment with its report, a pull request from its
// commits, or a zip of out/ as a release asset. Each returns the issue comment to post, or why it failed.
// Steps already done (pushed branch, opened PR, uploaded asset) are recorded, so a retry skips them.
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { code } from '../claim/text.ts';
import type { Request } from '../spec/frontmatter.ts';
import { sha256File } from '../workspace/context.ts';
import { githubRepo } from '../workspace/setup.ts';
import { updateState, type JobRecord, type State } from '../workspace/state.ts';
import type { ServeContext } from './context.ts';
import { ARTIFACTS_TAG } from './github.ts';
import { zipDir } from './zipout.ts';

/** GitHub's limit on a comment body. */
export const COMMENT_LIMIT = 65_536;
export const REPORT_FILE = 'REPORT.md';
export const TRUNCATED_LINE = '**Truncated:** the full report is in the attached artifact.';
/** Artifacts are kept this long after the issue closes at the latest (spec §7 `expires`). */
export const ARTIFACT_KEEP_DAYS = 30;
const GIT_TIMEOUT_MS = 10 * 60_000;

export type Delivered = { ok: true; comment: string } | { ok: false; step: string; detail: string };

/**
 * Text the server didn't write goes into a comment it signs: any line that could read as an air marker is
 * defused, so an agent's report can never claim or release anything.
 */
export function defuseMarkers(text: string): string {
  return text.replace(/^([ \t]*)<!--(?=[ \t]*air-)/gm, '$1&lt;!--');
}

export function artifactBlock(a: { url: string; sha256: string; bytes: number; expires?: string }): string {
  return ['```air-artifact', `url: ${a.url}`, `sha256: ${a.sha256}`, `bytes: ${a.bytes}`, ...(a.expires ? [`expires: ${a.expires}`] : []), '```'].join('\n');
}

function expiry(now: Date): string {
  return new Date(now.getTime() + ARTIFACT_KEEP_DAYS * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The `comment` delivery's body: the report, then `footer`. A report that doesn't fit goes to an asset
 * (via `upload`), and the comment becomes the truncation line, the start of the report and the asset block,
 * cut to fit in COMMENT_LIMIT.
 */
export async function reportComment(report: string, footer: string, upload: () => Promise<{ url: string; sha256: string; bytes: number; expires: string }>): Promise<string> {
  const safe = defuseMarkers(report.replace(/\s+$/, ''));
  const whole = `${safe}\n\n${footer}`;
  if (whole.length <= COMMENT_LIMIT) return whole;
  const block = artifactBlock(await upload());
  const head = `${TRUNCATED_LINE}\n\n`;
  const cut = '\n\n[... cut ...]\n\n';
  const tailText = `${cut}${block}\n\n${footer}`;
  let start = safe.slice(0, Math.max(0, COMMENT_LIMIT - head.length - tailText.length));
  // Don't leave a dangling surrogate half.
  if (/[\uD800-\uDBFF]$/.test(start)) start = start.slice(0, -1);
  return `${head}${start}${tailText}`;
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
    if (!statSync(f).isFile()) return undefined;
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

async function deliverComment(ctx: ServeContext, dir: string, state: State, footer: string): Promise<Delivered> {
  const report = readReport(dir);
  if (report === undefined) return { ok: false, step: 'delivery', detail: `The agent finished without writing its report to \`out/${REPORT_FILE}\`.` };
  const comment = await reportComment(report, footer, async () => {
    const name = `air-${state.issue}-${state.nonce}-report.md`;
    const file = join(dir, `.${name}`);
    writeFileSync(file, report);
    try {
      const release = await ctx.api.release(ARTIFACTS_TAG);
      const url = await ctx.api.uploadAsset(release, name, file, 'text/markdown');
      return { url, sha256: await sha256File(file), bytes: statSync(file).size, expires: expiry(ctx.now()) };
    } finally {
      rmSync(file, { force: true });
    }
  });
  return { ok: true, comment };
}

async function deliverArtifact(ctx: ServeContext, dir: string, state: State, footer: string): Promise<Delivered> {
  const name = `air-${state.issue}-${state.nonce}.zip`;
  const zip = join(dir, `.${name}`);
  rmSync(zip, { force: true });
  try {
    const summary = zipDir(join(dir, 'out'), zip);
    if (summary.files === 0) return { ok: false, step: 'delivery', detail: 'The agent left no regular file in `out/`, so there is no artifact to deliver.' };
    const sha256 = await sha256File(zip);
    const release = await ctx.api.release(ARTIFACTS_TAG);
    const url = await ctx.api.uploadAsset(release, name, zip, 'application/zip');
    const block = artifactBlock({ url, sha256, bytes: summary.bytes, expires: expiry(ctx.now()) });
    return { ok: true, comment: `The result is a zip of ${summary.files} file${summary.files === 1 ? '' : 's'} from \`out/\`:\n\n${block}\n\n${footer}` };
  } finally {
    rmSync(zip, { force: true });
  }
}

async function deliverPr(ctx: ServeContext, dir: string, state: State, request: Request, footer: string): Promise<Delivered> {
  const repoDir = join(dir, 'repo');
  const base = request.repo!.ref;
  const fail = (detail: string): Delivered => ({ ok: false, step: 'delivery', detail });
  let job = state.job!;
  const target = githubRepo(request.repo!.url, ctx.ghHost);
  if ('error' in target) return fail(target.error);

  if (!job.delivery?.prUrl) {
    const g = (args: string[]) => git(args, repoDir, ctx.env);
    const baseRef = `refs/remotes/origin/${base}`;
    if ((await g(['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`])).code !== 0) {
      return fail(`\`repo.ref\` (${code(base)}) is not a branch of ${request.repo!.url}, so there is nothing to open a pull request against.`);
    }
    const ahead = async (rev: string) => Number((await g(['rev-list', '--count', `${baseRef}..${rev}`])).stdout.trim()) || 0;
    // The agent's branch: HEAD if it has new commits, else the most recently committed local branch that has.
    let head: string | undefined;
    if (await ahead('HEAD') > 0) head = (await g(['rev-parse', 'HEAD'])).stdout.trim();
    else {
      const refs = (await g(['for-each-ref', '--sort=-committerdate', '--format=%(objectname)', 'refs/heads'])).stdout.split('\n').filter(Boolean);
      for (const sha of refs) if (await ahead(sha) > 0) { head = sha; break; }
    }
    if (!head || !/^[0-9a-f]{40,64}$/.test(head)) {
      return fail(`No changes were produced: the agent made no commits beyond ${code(base)}. Uncommitted changes are not delivered.`);
    }
    let branch = job.delivery?.branch;
    if (!branch) {
      const ls = await g(['ls-remote', '--heads', 'origin']);
      if (ls.code !== 0) throw new Error(`git ls-remote failed: ${ls.stderr.trim()}`);
      const taken = new Set(ls.stdout.split('\n').map((l) => l.split('\t')[1]?.replace(/^refs\/heads\//, '')).filter(Boolean));
      branch = `air/${state.issue}`;
      for (let k = 2; taken.has(branch); k++) branch = `air/${state.issue}-${k}`;
    }
    const push = await g(['push', '--quiet', '--porcelain', 'origin', `${head}:refs/heads/${branch}`]);
    if (push.code !== 0) throw new Error(`git push of ${branch} failed: ${push.stderr.trim() || push.stdout.trim()}`);
    job = record(dir, job, { branch }, ctx.now());
    const summary = readReport(dir) ?? '(The agent left no summary.)';
    const prUrl = await ctx.api.createPull(target.repo, {
      title: `air: ${state.title} (#${state.issue})`, head: branch, base,
      body: `Closes ${ctx.gh.repo}#${state.issue}\n\n${defuseMarkers(summary.trim())}\n`,
    });
    job = record(dir, job, { prUrl }, ctx.now());
  }
  return { ok: true, comment: `Opened ${job.delivery!.prUrl} from branch \`${job.delivery!.branch}\`.\n\n${footer}` };
}

export async function deliver(ctx: ServeContext, dir: string, state: State, request: Request, footer: string): Promise<Delivered> {
  if (request.deliver === 'comment') return deliverComment(ctx, dir, state, footer);
  if (request.deliver === 'artifact') return deliverArtifact(ctx, dir, state, footer);
  if (!existsSync(join(dir, 'repo'))) return { ok: false, step: 'delivery', detail: 'The workspace has no `repo/` checkout.' };
  return deliverPr(ctx, dir, state, request, footer);
}
