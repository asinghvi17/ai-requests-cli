// `air fetch` (spec/v0.md §12): the latest result of a request, on disk. The report goes to REPORT.md, each
// pull request's head branch and each checkpoint branch to repo/<path>/ (the workspace's layout, §5), the
// artifact to artifact/ and a checkpoint's out/ to out/. Zips are verified and extracted exactly as a
// server extracts a context zip; the first failure stops the fetch.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tail } from '../claim/text.ts';
import type { Trust } from '../claim/trust.ts';
import { createGh } from '../gh/gh.ts';
import type { RequestsRepo } from '../gh/issues.ts';
import type { Asset } from '../spec/frontmatter.ts';
import { lint } from '../spec/lint.ts';
import { textAboveResult } from '../spec/markers.ts';
import { fetchContext, releaseDownload, type Download } from '../workspace/context.ts';
import { exec } from '../workspace/exec.ts';
import { cloneAt } from '../workspace/git.ts';
import { readStatus, type LatestResult } from './status.ts';

export class FetchError extends Error {}

/** Largest report asset `air fetch` downloads. Reports are Markdown; this is generous. */
export const MAX_REPORT_BYTES = 64 * 1024 ** 2;

export interface FetchOptions {
  gh: RequestsRepo;
  issue: number;
  /** Must not exist, or be empty. */
  dir: string;
  /** The requests repo's GitHub host: pull requests must be on it. */
  ghHost?: string;
  /** How assets are downloaded; default: release assets on `ghHost` through gh (`releaseDownload`). */
  download?: Download;
  /** git's environment (the requester's own credential setup). */
  env?: NodeJS.ProcessEnv;
  /** Accept non-https clone URLs (tests clone local bare repos). */
  allowAnyUrl?: boolean;
  trust?: Trust;
  /** Progress, one line at a time. */
  log?: (line: string) => void;
}

export interface Fetched {
  latest: LatestResult;
  /** Paths written, relative to `dir`. */
  written: string[];
}

/** `owner/name` and number of a pull request URL on `host`. */
export function parsePullUrl(url: string, host: string): { repo: string; number: number } {
  const m = /^https:\/\/([^/:]+)\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)$/.exec(url);
  if (!m) throw new FetchError(`${url} is not a pull request URL`);
  if (m[1]!.toLowerCase() !== host.toLowerCase()) throw new FetchError(`${url} is not on ${host}, where gh is logged in`);
  return { repo: m[2]!, number: Number(m[3]) };
}

export async function fetchResult(opts: FetchOptions): Promise<Fetched> {
  const { gh, issue: n, dir } = opts;
  const log = opts.log ?? (() => {});
  const env = opts.env ?? process.env;
  const host = opts.ghHost ?? (env.GH_HOST || 'github.com');
  const download = opts.download ?? releaseDownload(createGh(), host);

  const status = await readStatus(gh, n, opts.trust);
  const latest = status.latest;
  if (!latest) throw new FetchError(`#${n} has no result yet`);
  const r = latest.result;
  if (!latest.current) log(`note: this result is not current; a later claim of #${n} has started since`);

  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  if (entries.length) throw new FetchError(`${dir} is not empty`);
  mkdirSync(dir, { recursive: true });

  const written: string[] = [];
  const gitLog = mkdtempSync(join(tmpdir(), 'air-fetch-'));
  try {
    if (r.report === 'comment') {
      writeFileSync(join(dir, 'REPORT.md'), `${textAboveResult(latest.body) ?? ''}\n`);
      written.push('REPORT.md');
    } else if (r.report !== undefined) {
      log(`downloading the report ${r.report}`);
      try {
        await download(r.report, join(dir, 'REPORT.md'), MAX_REPORT_BYTES);
      } catch (e) {
        rmSync(join(dir, 'REPORT.md'), { force: true });
        throw new FetchError(`report download failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      written.push('REPORT.md');
    }

    const clone = async (url: string, ref: string, path: string, branch?: string) => {
      const dest = join(dir, 'repo', ...path.split('/'));
      const logFile = join(gitLog, 'git.log');
      mkdirSync(join(dest, '..'), { recursive: true });
      const fail = (what: string) => {
        let text = '';
        try {
          text = readFileSync(logFile, 'utf8');
        } catch {
          // nothing logged
        }
        return new FetchError(`${what}${text.trim() ? `\n${tail(text, 20, 2000)}` : ''}`);
      };
      try {
        await cloneAt({ url, ref, dest, cwd: dir, log: logFile, env, ...(opts.allowAnyUrl ? { allowAnyUrl: true } : {}) });
      } catch (e) {
        throw fail(`repo/${path}: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (branch) {
        const gitEnv: Record<string, string> = { GIT_TERMINAL_PROMPT: '0' };
        for (const [k, v] of Object.entries(env)) if (v !== undefined) gitEnv[k] ??= v;
        const co = await exec(['git', 'checkout', '--quiet', '-B', branch], { cwd: dest, env: gitEnv, log: logFile });
        if (co.code !== 0) throw fail(`repo/${path}: git checkout -B ${branch} failed`);
      }
      written.push(`repo/${path}`);
    };

    for (const pr of r.prs) {
      const { repo, number } = parsePullUrl(pr.url, host);
      const head = await gh.pullHead(repo, number);
      log(`cloning ${head.cloneUrl} at ${head.ref} into repo/${pr.repo}`);
      await clone(head.cloneUrl, head.ref, pr.repo);
    }

    const unzip = async (asset: Asset, into: string, what: string) => {
      log(`downloading ${asset.url} (${asset.bytes} bytes) into ${into}/`);
      const zip = join(gitLog, `${into}.zip`);
      try {
        await fetchContext(asset, zip, join(dir, into), download, { what, from: 'the result' });
      } catch (e) {
        throw new FetchError(e instanceof Error ? e.message : String(e));
      } finally {
        rmSync(zip, { force: true });
      }
      written.push(`${into}/`);
    };
    if (r.artifact) await unzip(r.artifact, 'artifact', 'artifact zip');

    if (r.status === 'partial' && r.resume) {
      if (r.resume.branches.length) {
        const linted = lint(status.body);
        if (!linted.request) throw new FetchError(`#${n}'s body no longer passes lint, so the checkpoint branches' repo URLs are unknown`);
        for (const b of r.resume.branches) {
          const entry = linted.request.repos.find((e) => e.path === b.repo);
          if (!entry) throw new FetchError(`#${n}'s body has no \`repos\` entry with path \`${b.repo}\` for the checkpoint branch ${b.branch}`);
          log(`cloning ${entry.url} at ${b.sha} (branch ${b.branch}) into repo/${b.repo}`);
          await clone(entry.url, b.sha, b.repo, b.branch);
        }
      }
      if (r.resume.out) await unzip(r.resume.out, 'out', 'checkpoint zip');
    }
  } finally {
    rmSync(gitLog, { recursive: true, force: true });
  }
  return { latest, written };
}
