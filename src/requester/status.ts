// What a requester sees of a request (spec/v0.md §12): the state label, the holding claim and the latest
// result, read with the requester's own gh credentials and trusting only counted markers and results.
import { setTimeout as sleep } from 'node:timers/promises';
import { CANCEL_LABEL, HELD_LABELS, STATE_LABELS } from '../claim/claim.ts';
import { createTrust, markedComments, type Trust } from '../claim/trust.ts';
import { GhError, type RequestsRepo } from '../gh/index.ts';
import { countedMarkers, countedResults, currentClaim, type AirResult, type ResultStatus } from '../spec/markers.ts';

export interface LatestResult {
  /** Id of the final comment that carries it. */
  commentId: number;
  /** No counted claim was posted after it: no retry has started since (§10). */
  current: boolean;
  result: AirResult;
  /** The whole comment, for `air fetch` to take a `report: comment` report from. */
  body: string;
}

export interface RequestStatus {
  repo: string;
  issue: number;
  title: string;
  url: string;
  /** The issue body as it is now. */
  body: string;
  open: boolean;
  /** The one state label of §8, if any. */
  state?: string;
  cancel: boolean;
  /** Host of the claim that holds the issue now. */
  holder?: string;
  latest?: LatestResult;
}

/** Reads issue `n` and its comments and works out its status. */
export async function readStatus(gh: RequestsRepo, n: number, trust: Trust = createTrust(gh)): Promise<RequestStatus> {
  // Labels first: a server posts its result comment before it changes the labels (claim.ts `postResult`), so
  // comments read after the held label is gone hold the result that replaced it. The other mix, a result next
  // to a held label, is the gap between the server's two writes (`waitForResult` reads again for it).
  const issue = await gh.issue(n);
  const comments = await markedComments(await gh.comments(n), trust);
  const status: RequestStatus = {
    repo: gh.repo, issue: n, title: issue.title, url: issue.url, body: issue.body, open: issue.state === 'open', cancel: issue.labels.includes(CANCEL_LABEL),
  };
  const state = issue.labels.find((l) => (STATE_LABELS as readonly string[]).includes(l));
  if (state) status.state = state;
  const holder = currentClaim(comments);
  if (holder) status.holder = holder.host;
  const last = countedResults(comments).at(-1);
  if (last) {
    const current = !comments.some((c) => c.id > last.commentId && countedMarkers(c).some((m) => m.kind === 'claim'));
    status.latest = { commentId: last.commentId, current, result: last.result, body: comments.find((c) => c.id === last.commentId)!.body };
  }
  return status;
}

/** `--json` output: the status with the latest result as the block holds it. */
export function statusJson(s: RequestStatus): object {
  return {
    repo: s.repo, issue: s.issue, title: s.title, url: s.url, open: s.open, state: s.state ?? null, cancel: s.cancel, holder: s.holder ?? null,
    result: s.latest ? resultJson(s.latest) : null,
  };
}

/** The block's fields as it names them: `prs` only when the block has it (spec §10: absent unless `done` with `pr`). */
function resultJson(l: LatestResult): object {
  const { prs, ...rest } = l.result;
  return { comment_id: l.commentId, current: l.current, ...rest, ...(prs.length ? { prs } : {}) };
}

/** The human-readable status. */
export function formatStatus(s: RequestStatus): string {
  const out = [`${s.repo}#${s.issue}: ${s.title}${s.open ? '' : ' (closed)'}`];
  out.push(`state:  ${s.state ?? 'none'}${s.holder ? `, held by ${s.holder}` : ''}${s.cancel ? `; ${CANCEL_LABEL} is set` : ''}`);
  const l = s.latest;
  if (!l) {
    out.push('result: none yet');
    return `${out.join('\n')}\n`;
  }
  const r = l.result;
  out.push(`result: ${r.status} (deliver: ${r.deliver}, from ${r.host}, comment ${l.commentId})${l.current ? '' : '; not current: a later claim has started since'}`);
  if (r.report !== undefined) out.push(`  report:     ${r.report === 'comment' ? 'in the comment' : r.report}`);
  for (const p of r.prs) out.push(`  pr:         ${p.repo} ${p.url}`);
  if (r.artifact) out.push(`  artifact:   ${r.artifact.url} (${r.artifact.bytes} bytes${r.artifact.expires ? `, expires ${r.artifact.expires}` : ''})`);
  for (const b of r.resume?.branches ?? []) out.push(`  checkpoint: ${b.repo} branch ${b.branch} at ${b.sha}`);
  if (r.resume?.out) out.push(`  checkpoint: out/ ${r.resume.out.url} (${r.resume.out.bytes} bytes)`);
  if (r.usage) {
    const u = r.usage;
    const pct = u.before_pct !== undefined || u.after_pct !== undefined ? `, weekly window ${u.before_pct ?? '?'}% -> ${u.after_pct ?? '?'}%` : '';
    out.push(`  usage:      ${u.harness} ${u.tier}${pct}, ${u.attempts} attempt${u.attempts === 1 ? '' : 's'}`);
  }
  return `${out.join('\n')}\n`;
}

/** `air wait` exit codes (spec/v0.md §12). Usage errors exit 2, like every command. */
export const WAIT_EXIT: Record<ResultStatus | 'timeout', number> = { done: 0, failed: 1, released: 1, partial: 3, timeout: 4 };

/** How often `air wait` reads the issue. */
export const WAIT_INTERVAL_MS = 30_000;

export interface WaitOptions {
  /** Give up after this long; undefined waits for ever. */
  timeoutMs?: number;
  intervalMs?: number;
  trust?: Trust;
  sleep?: (ms: number) => Promise<unknown>;
  now?: () => number;
  /** Told about a transient read error that the next poll retries. */
  onRetry?: (e: GhError) => void;
}

/** How long `air wait` gives a server to move the state label once its result is posted. */
export const SETTLE_MS = 5_000;

/** GitHub errors worth another poll; anything else means the issue can't be read. */
const TRANSIENT: readonly string[] = ['server', 'timeout', 'rate_limited'];

/**
 * Polls issue `n` until it has a current latest result, or until the timeout passes. Returns the last
 * status read; `timedOut` tells which. Errors other than transient ones propagate. A result that still
 * carries a held label (the server has not moved it yet) is read once more after SETTLE_MS.
 */
export async function waitForResult(gh: RequestsRepo, n: number, opts: WaitOptions = {}): Promise<{ status: RequestStatus; timedOut: boolean }> {
  const now = opts.now ?? Date.now;
  const pause = opts.sleep ?? sleep;
  const interval = opts.intervalMs ?? WAIT_INTERVAL_MS;
  const trust = opts.trust ?? createTrust(gh);
  const deadline = opts.timeoutMs === undefined ? Infinity : now() + opts.timeoutMs;
  let last: RequestStatus | undefined;
  let settling = false;
  for (;;) {
    try {
      last = await readStatus(gh, n, trust);
      if (last.latest?.current) {
        // A read between the server's result comment and its label change shows the result with the held
        // label: no write order closes that gap, so give the label one more read.
        if (settling || !(HELD_LABELS as readonly (string | undefined)[]).includes(last.state)) return { status: last, timedOut: false };
        settling = true;
        await pause(SETTLE_MS);
        continue;
      }
    } catch (e) {
      if (!(e instanceof GhError && TRANSIENT.includes(e.kind))) throw e;
      opts.onRetry?.(e);
    }
    const left = deadline - now();
    if (left <= 0) {
      if (!last) throw new GhError('timeout', `could not read #${n} before the timeout`);
      return { status: last, timedOut: true };
    }
    await pause(Math.min(interval, left));
  }
}
