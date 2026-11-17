// `air retry` (spec/v0.md §12): the one way to offer a request again after a cancel, a failure or a partial
// result. It edits the body first (`resume` from a partial result, `effort` from --effort), then removes
// every `air:*` label, so no server can claim the old body.
import { WRITE_ROLES, createTrust, type Trust } from '../claim/trust.ts';
import { REQUEST_LABEL } from '../claim/claim.ts';
import type { RequestsRepo } from '../gh/issues.ts';
import { splitLines, type Effort, type Resume } from '../spec/frontmatter.ts';
import { lint } from '../spec/lint.ts';
import { formatResume } from '../spec/markers.ts';
import { readStatus } from './status.ts';

export class RetryError extends Error {}

export interface RetryOptions {
  gh: RequestsRepo;
  issue: number;
  effort?: Effort;
  trust?: Trust;
}

export interface Retried {
  /** `resume` was set from the latest result. */
  resumed: boolean;
  /** The body changed. */
  edited: boolean;
  /** Labels removed. */
  removed: string[];
}

/**
 * Sets top-level front-matter fields of a body that passes lint, keeping everything else as written:
 * `effort` in place, and `resume` replaced by a block at the end of the front matter. Line endings
 * become LF.
 */
export function editFrontMatter(body: string, edits: { effort?: Effort; resume?: Resume }): string {
  const lines = splitLines(body);
  let open = 0;
  while (lines[open]!.trim() === '') open++;
  let close = open + 1;
  while (lines[close]!.trimEnd() !== '---') close++;
  const isKey = (i: number) => /^[A-Za-z_][A-Za-z0-9_-]*:(?=\s|$)/.test(lines[i]!);
  const keyAt = (k: string) => {
    for (let i = open + 1; i < close; i++) if (lines[i]!.startsWith(`${k}:`) && isKey(i)) return i;
    return -1;
  };
  if (edits.effort !== undefined) lines[keyAt('effort')] = `effort: ${edits.effort}`;
  if (edits.resume) {
    const at = keyAt('resume');
    if (at >= 0) {
      let end = at + 1;
      while (end < close && !isKey(end)) end++;
      // Blank lines and unindented comments at the end of the block belong to what follows.
      while (end > at + 1 && /^(?:#.*)?$/.test(lines[end - 1]!.trimEnd())) end--;
      lines.splice(at, end - at);
      close -= end - at;
    }
    lines.splice(close, 0, ...formatResume(edits.resume));
  }
  return lines.join('\n');
}

export async function retry(opts: RetryOptions): Promise<Retried> {
  const { gh, issue: n } = opts;
  const trust = opts.trust ?? createTrust(gh);
  const issue = await gh.issue(n);
  if (issue.isPullRequest || !issue.labels.includes(REQUEST_LABEL)) throw new RetryError(`#${n} is not a request (no \`${REQUEST_LABEL}\` label)`);
  if (issue.state !== 'open') throw new RetryError(`#${n} is closed; reopen it first`);
  const viewer = await gh.viewer();
  if (viewer !== issue.author) {
    const role = await gh.permission(gh.repo, viewer);
    if (!(WRITE_ROLES as readonly string[]).includes(role)) {
      throw new RetryError(`only the issue's author (${issue.author}) or someone with write access to ${gh.repo} can retry #${n}; ${viewer} has ${role}`);
    }
  }

  const status = await readStatus(gh, n, trust);
  if (status.holder) throw new RetryError(`#${n} is held by ${status.holder}; run \`air cancel ${n}\` and wait for its release first`);
  const linted = lint(status.body);
  if (!linted.ok) throw new RetryError(`#${n}'s body doesn't pass lint; fix it first:\n${linted.errors.map((e) => `  line ${e.line}: ${e.message}`).join('\n')}`);

  const r = status.latest?.result;
  const resume = r?.status === 'partial' ? r.resume : undefined;
  const body = editFrontMatter(status.body, { ...(opts.effort ? { effort: opts.effort } : {}), ...(resume ? { resume } : {}) });
  const after = lint(body);
  if (!after.ok) throw new RetryError(`the retried body would not pass lint:\n${after.errors.map((e) => `  line ${e.line}: ${e.message}`).join('\n')}`);
  const edited = body !== splitLines(status.body).join('\n');
  if (edited) await gh.editBody(n, body);

  const removed = (await gh.issue(n)).labels.filter((l) => l.startsWith('air:'));
  for (const l of removed) await gh.removeLabel(n, l);
  return { resumed: resume !== undefined, edited, removed };
}
