// Claiming and releasing requests (spec/v0.md §8, §9). A claim is a comment with an `air-claim` marker;
// after a wait, the earliest counted unreleased claim holds the issue and every other claimant backs off.
import { createHash, randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Issue, RequestsRepo } from '../gh/issues.ts';
import { lint } from '../spec/lint.ts';
import { singleRepoLimitation, SPEC_VERSION, type Request } from '../spec/frontmatter.ts';
import { countedMarkers, currentClaim, formatMarker } from '../spec/markers.ts';
import { createWorkspace, findWorkspaces, updateState, type State } from '../workspace/state.ts';
import { createTrust, markedComments, type Trust } from './trust.ts';
import { code, fenced } from './text.ts';

export const REQUEST_LABEL = 'ai-request';
export const CANCEL_LABEL = 'air:cancel';
export const STATE_LABELS = ['air:claimed', 'air:running', 'air:paused', 'air:done', 'air:failed'] as const;
/** State labels a holder removes when it gives an issue up. */
export const HELD_LABELS = ['air:claimed', 'air:running', 'air:paused'] as const;
/** The spec's minimum wait between posting a claim and re-reading comments. */
export const CLAIM_WAIT_MS = 10_000;

const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const NONCE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** This machine's name in markers: the hostname, with characters outside the marker grammar replaced. */
export function defaultHost(name = hostname()): string {
  const h = name.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 64);
  return HOST_RE.test(h) ? h : 'air-host';
}

/** 16 random `[A-Za-z0-9]` characters (rejection sampling, so every character is equally likely). */
export function newNonce(length = 16): string {
  let out = '';
  while (out.length < length) {
    for (const b of randomBytes(length * 2)) {
      if (b < 248 && out.length < length) out += NONCE_ALPHABET[b % 62];
    }
  }
  return out;
}

export interface ClaimOptions {
  gh: RequestsRepo;
  issue: number;
  /** Workspace root from the config; the winner creates its workspace here. */
  root: string;
  host?: string;
  /** Wait between posting the claim and re-reading. Defaults to the spec's 10 s; tests pass 0. */
  waitMs?: number;
  sleep?: (ms: number) => Promise<unknown>;
  now?: () => Date;
  nonce?: string;
  trust?: Trust;
}

export type Refusal =
  | 'not-found' | 'closed' | 'pull-request' | 'not-a-request' | 'cancelled' | 'state-label'
  | 'untrusted' | 'unsupported-version' | 'invalid' | 'not-yet-supported' | 'past-deadline' | 'held';

export type ClaimResult =
  | { status: 'won'; dir: string; state: State; request: Request; body: string }
  | { status: 'lost'; holder: string }
  | { status: 'refused'; reason: Refusal; message: string };

/** Tags the one lint-refusal comment per body version, so re-polling never posts it twice. */
function lintTag(body: string): string {
  return `<!-- air-lint-refusal sha256=${createHash('sha256').update(body).digest('hex').slice(0, 16)} -->`;
}

/** The `air` value of a body whose version lint rejected (the version diagnostic doesn't carry it). */
function bodyVersion(body: string): number | undefined {
  const m = /^air:[ \t]*(\d+)[ \t]*(?:#.*)?$/m.exec(body.replace(/\r\n?/g, '\n'));
  return m ? Number(m[1]) : undefined;
}

/** Deadline as written: a bare date means 23:59:59Z that day. */
export function deadlineTime(deadline: string): number {
  return /^\d{4}-\d{2}-\d{2}$/.test(deadline) ? Date.parse(`${deadline}T23:59:59Z`) : Date.parse(deadline);
}

/** Whether an issue's labels and state let any server claim it (§8). */
export function claimable(issue: Issue): { ok: true } | { ok: false; reason: Refusal; message: string } {
  if (issue.isPullRequest) return { ok: false, reason: 'pull-request', message: `#${issue.number} is a pull request` };
  if (issue.state !== 'open') return { ok: false, reason: 'closed', message: `#${issue.number} is closed` };
  if (!issue.labels.includes(REQUEST_LABEL)) return { ok: false, reason: 'not-a-request', message: `#${issue.number} has no \`${REQUEST_LABEL}\` label` };
  if (issue.labels.includes(CANCEL_LABEL)) return { ok: false, reason: 'cancelled', message: `#${issue.number} has \`${CANCEL_LABEL}\`` };
  const state = issue.labels.find((l) => (STATE_LABELS as readonly string[]).includes(l));
  if (state) return { ok: false, reason: 'state-label', message: `#${issue.number} already has \`${state}\`` };
  return { ok: true };
}

/**
 * Claims a request: checks it, posts a claim marker, self-assigns, waits, then re-reads the comments to
 * see whose claim holds. The winner adds `air:claimed` and gets a fresh workspace holding the body as
 * claimed; a loser deletes its comment and unassigns itself.
 */
export async function claim(opts: ClaimOptions): Promise<ClaimResult> {
  const { gh, issue: n } = opts;
  const host = opts.host ?? defaultHost();
  const now = opts.now ?? (() => new Date());
  const trust = opts.trust ?? createTrust(gh);
  const refuse = (reason: Refusal, message: string): ClaimResult => ({ status: 'refused', reason, message });

  const issue = await gh.issue(n);
  const ok = claimable(issue);
  if (!ok.ok) return refuse(ok.reason, ok.message);
  // Untrusted authors get no reply at all: answering would let anyone make the server comment.
  if (!(await trust(issue.author, issue.authorAssociation))) {
    return refuse('untrusted', `#${n} was opened by ${issue.author || 'an unknown account'}, who has no write access to ${gh.repo}`);
  }

  const body = issue.body;
  const result = lint(body);
  const viewer = await gh.viewer();
  if (!result.ok || !result.request) {
    const comments = await gh.comments(n);
    if (result.errors.some((e) => e.code === 'version')) {
      const air = bodyVersion(body);
      if (air !== undefined) {
        const marked = await markedComments(comments.filter((c) => c.author === viewer), trust);
        const posted = marked.some((c) => countedMarkers(c).some((m) => m.kind === 'unsupported' && m.host === host && m.air === air));
        if (!posted) {
          await gh.comment(n, `${code(host)} runs air, which understands request format version ${SPEC_VERSION} only, so it is skipping this request (\`air: ${air}\`).\n\n${formatMarker({ kind: 'unsupported', version: SPEC_VERSION, host, air })}\n`);
        }
      }
      return refuse('unsupported-version', `#${n} uses request format ${air ?? '?'}, newer than ${SPEC_VERSION}`);
    }
    const tag = lintTag(body);
    if (!comments.some((c) => c.author === viewer && c.body.includes(tag))) {
      const list = result.errors.map((e) => `line ${e.line}: ${e.message}`).join('\n');
      await gh.comment(n, `air can't act on this request until these problems are fixed (\`air lint\` reports the same):\n\n${fenced(list)}\n\nEdit the issue to fix them; servers will pick it up again.\n${tag}\n`);
    }
    return refuse('invalid', `#${n} is not a valid request:\n${result.errors.map((e) => `  line ${e.line}: ${e.message}`).join('\n')}`);
  }
  const request = result.request;
  // Transitional: setup, serve and delivery still handle one repo, checked out at a `ref`.
  const limit = singleRepoLimitation(request);
  if (limit) return refuse('not-yet-supported', `#${n} is valid, but this air can't serve it yet: ${limit}`);
  if (request.deadline !== undefined && now().getTime() > deadlineTime(request.deadline)) {
    return refuse('past-deadline', `#${n} is past its deadline (${request.deadline})`);
  }

  const before = currentClaim(await markedComments(await gh.comments(n), trust));
  if (before) return refuse('held', `#${n} is already claimed by ${before.host}`);

  const nonce = opts.nonce ?? newNonce();
  const mine = await gh.comment(n, `Claimed by ${code(host)} with air.\n\n${formatMarker({ kind: 'claim', version: SPEC_VERSION, host, nonce })}\n`);
  let comments, holder;
  try {
    await gh.assign(n, viewer);
    await (opts.sleep ?? sleep)(opts.waitMs ?? CLAIM_WAIT_MS);
    comments = await gh.comments(n);
    holder = currentClaim(await markedComments(comments, trust));
  } catch (e) {
    // We never learned whether we hold it: withdraw the claim rather than leave one nobody acts on. If the
    // comment can't be deleted, a release marker for it ends the claim just the same.
    await gh.deleteComment(mine.id).catch(() =>
      gh.comment(n, `Withdrawn by ${code(host)}: it could not complete the claim.\n\n${formatMarker({ kind: 'release', version: SPEC_VERSION, host, nonce })}\n`)).catch(() => {});
    await gh.unassign(n, viewer).catch(() => {});
    throw e;
  }
  if (!holder || holder.commentId !== mine.id || holder.nonce !== nonce || holder.host !== host) {
    await gh.deleteComment(mine.id);
    // Another server on the same account shares our assignment: leave it.
    const holderAuthor = holder && comments.find((c) => c.id === holder.commentId)?.author;
    if (holderAuthor !== viewer) await gh.unassign(n, viewer);
    return { status: 'lost', holder: holder ? holder.host : 'nobody (our claim did not count)' };
  }

  const t = now().toISOString();
  const state: State = {
    version: 1, repo: gh.repo, issue: n, title: issue.title, author: issue.author, url: issue.url, host, nonce,
    claimCommentId: mine.id, phase: 'claimed', createdAt: t, updatedAt: t,
  };
  let dir: string;
  try {
    await gh.addLabels(n, ['air:claimed']);
    dir = createWorkspace(opts.root, state, body);
  } catch (e) {
    await giveUp(gh, n, viewer, host, nonce, { message: `Released by ${code(host)}: it could not start work on this request.` }).catch(() => {});
    throw e;
  }
  return { status: 'won', dir, state, request, body };
}

/** Posts the release, then fixes labels and the assignment. Shared by release and failure. */
async function giveUp(
  gh: RequestsRepo, n: number, viewer: string, host: string, nonce: string,
  opts: { message: string; failed?: boolean; labels?: string[] },
): Promise<void> {
  const labels = opts.labels ?? (await gh.issue(n)).labels;
  // Add air:failed before removing the held label, so the issue never looks claimable in between.
  if (opts.failed) await gh.addLabels(n, ['air:failed']);
  for (const l of HELD_LABELS) if (labels.includes(l)) await gh.removeLabel(n, l);
  await gh.comment(n, `${opts.message}\n\n${formatMarker({ kind: 'release', version: SPEC_VERSION, host, nonce })}\n`);
  await gh.unassign(n, viewer);
}

export interface ReleaseOptions {
  gh: RequestsRepo;
  issue: number;
  root: string;
  host?: string;
  trust?: Trust;
  now?: () => Date;
  /** Release because of a failure: sets `air:failed` and explains why. */
  failure?: { step: string; detail: string };
  /** Text of the release comment when it isn't a failure (default: `Released by <host>.`). */
  message?: string;
  /** The claim to release. Default: the nonce of this machine's workspace for the holding claim. */
  nonce?: string;
}

export type ReleaseResult = { status: 'released'; nonce: string } | { status: 'refused'; message: string };

/**
 * Gives a claim back (§9 step 4): posts an `air-release` marker for this host's holding claim, removes the
 * held state label (adding `air:failed` for a failure), unassigns, and marks the local workspace.
 */
export async function release(opts: ReleaseOptions): Promise<ReleaseResult> {
  const { gh, issue: n } = opts;
  const host = opts.host ?? defaultHost();
  const now = opts.now ?? (() => new Date());
  const trust = opts.trust ?? createTrust(gh);
  const issue = await gh.issue(n);
  if (issue.labels.includes('air:done')) return { status: 'refused', message: `#${n} is done; delivered requests are not released` };

  const holder = currentClaim(await markedComments(await gh.comments(n), trust));
  if (!holder || holder.host !== host) {
    return { status: 'refused', message: holder ? `#${n} is held by ${holder.host}, not ${host}` : `#${n} has no claim to release` };
  }
  // Hosts can share a name: only release a claim we can prove is ours by its nonce.
  const ws = findWorkspaces(opts.root, gh.repo, n).find((w) => w.state.nonce === holder.nonce);
  const nonce = opts.nonce ?? ws?.state.nonce;
  if (nonce === undefined || nonce !== holder.nonce) {
    return { status: 'refused', message: `#${n} is held by a claim from ${host} that this machine has no workspace for (another machine with the same name?)` };
  }
  const viewer = await gh.viewer();
  const message = opts.failure
    ? `air on ${code(host)} failed at ${opts.failure.step} and released this request.\n\n${opts.failure.detail}\n\nRemove \`air:failed\` to offer it again.`
    : opts.message ?? `Released by ${code(host)}.`;
  await giveUp(gh, n, viewer, host, nonce, { message, failed: opts.failure !== undefined, labels: issue.labels });

  if (ws) {
    updateState(ws.dir, opts.failure ? { phase: 'failed', failure: opts.failure.step } : { phase: 'released' }, now());
  }
  return { status: 'released', nonce };
}
