// A job's lifecycle after setup (spec/v0.md §8 labels): start the agent in tmux, stop and resume it, notice
// it finished, deliver, stop it early with a checkpoint (§11), fail, cancel. State lives in the workspace's
// state.json (`job`), so the server, a restarted server and the `air run/stop/start` commands all act on the
// same record.
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { HELD_LABELS, postResult, release } from '../claim/claim.ts';
import { DEFAULT_AGENTS } from '../config.ts';
import { code, fenced, tail } from '../claim/text.ts';
import { markedComments } from '../claim/trust.ts';
import { choose, EFFORT_USD, primaryWindow, type ActualRecord, type Choice, type Effort } from '../match/match.ts';
import type { Request } from '../spec/frontmatter.ts';
import { lint } from '../spec/lint.ts';
import { currentClaim, type ResultUsage } from '../spec/markers.ts';
import { ledgerFile } from '../usage/index.ts';
import { usd } from '../usage/prices.ts';
import { spend as spendUsd } from '../usage/manual.ts';
import { claudeSpent, codexSpent, type Spent } from '../usage/spent.ts';
import type { Subscription } from '../usage/types.ts';
import { airEnv, TASK_INSTRUCTION } from '../workspace/launch.ts';
import { signalName, signalOf } from '../tmux/tmux.ts';
import { DONE_FILE } from '../workspace/task.ts';
import { readState, REQUEST_FILE, updateState, type JobRecord, type PauseReason, type State } from '../workspace/state.ts';
import { agentArgv, exitResumeInstruction, findCodexSession, type Harness, restartInstruction, RESUME_INSTRUCTION } from './agent.ts';
import { matchConfig, type ServeContext } from './context.ts';
import { checkpoint, deliver } from './deliver.ts';

/** A job paused this long is given back (not a quota pause: see QUOTA_WAIT_MS). */
export const PAUSE_LIMIT_MS = 48 * 3600_000;
/**
 * A job waits this long for its subscription to recover (spec §11 rules 1, 2): a window that resets
 * further away stops the job early, and so does a quota pause that hasn't ended this long after it began.
 */
export const QUOTA_WAIT_MS = 24 * 3600_000;

export { DONE_FILE };

export type Workspace = { dir: string; state: State };

export function requestOf(dir: string): Request {
  const r = lint(readFileSync(join(dir, REQUEST_FILE), 'utf8'));
  if (!r.ok || !r.request) throw new Error(`${join(dir, REQUEST_FILE)} no longer passes lint`);
  return r.request;
}

export function jobOf(state: State): JobRecord {
  if (!state.job) throw new Error(`#${state.issue} has no job record (not set up by air serve)`);
  return state.job;
}

export function saveJob(ctx: ServeContext, dir: string, patch: Partial<JobRecord>): JobRecord {
  const s = readState(dir);
  const job = { ...jobOf(s), ...patch };
  for (const k of Object.keys(patch) as (keyof JobRecord)[]) if (patch[k] === undefined) delete job[k];
  updateState(dir, { job }, ctx.now());
  return job;
}

export function isDone(dir: string): boolean {
  return existsSync(join(dir, DONE_FILE));
}

/** Agent time so far, including the current run. */
export function agentMs(job: JobRecord, now: Date): number {
  return job.runMs + (job.status === 'running' && job.startedAt ? Math.max(0, now.getTime() - Date.parse(job.startedAt)) : 0);
}

/** Our claim on the issue is gone (released, or another server holds it): we must not touch the issue. */
export class ClaimLost extends Error {}

/** Whether this workspace's claim still holds the issue. */
export async function claimHolds(ctx: ServeContext, state: State): Promise<boolean> {
  const holder = currentClaim(await markedComments(await ctx.gh.comments(state.issue), ctx.trust));
  return !!holder && holder.host === state.host && holder.nonce === state.nonce;
}

/**
 * The claim is gone: close our agent's window (local only) and mark the workspace `lost`, so the server never
 * writes to the issue for it again. The holder, if any, owns the issue's labels now. Unless our own release
 * ended the claim and was cut off after its comment (a label write or the unassign failed): then `release`
 * finishes it, and the job ends as its result says.
 */
export async function loseJob(ctx: ServeContext, dir: string): Promise<void> {
  const state = readState(dir);
  if (state.job?.paneNonce && (await ctx.tmux.listJobs()).some((j) => j.issue === state.issue && j.nonce === state.job!.paneNonce)) {
    await ctx.tmux.stopJob(state.issue, { graceMs: ctx.stopGraceMs });
  }
  const r = await release({ gh: ctx.gh, issue: state.issue, root: ctx.root, host: state.host, trust: ctx.trust, now: ctx.now, nonce: state.nonce });
  if (r.status === 'released') {
    const status = r.result.status === 'failed' ? 'failed' : r.result.status === 'partial' ? 'partial' : 'cancelled';
    if (state.job) saveJob(ctx, dir, { status, startedAt: undefined, lastError: undefined });
    ctx.log(`#${state.issue}: finished our release (${r.result.status}) that was cut off after its comment`);
    return;
  }
  updateState(dir, { phase: 'lost', ...(state.job ? { job: { ...state.job, status: 'cancelled' as const, startedAt: undefined } } : {}) }, ctx.now());
  ctx.log(`#${state.issue}: our claim no longer holds; leaving the issue alone`);
  try {
    if (state.job) settleSpend(ctx, dir, requestOf(dir));
  } catch (e) {
    ctx.log(`#${state.issue}: could not work out what the job spent: ${(e as Error).message}`);
  }
}

/** Throws ClaimLost (after `loseJob`) unless this workspace's claim still holds the issue. */
export async function ensureHeld(ctx: ServeContext, dir: string): Promise<void> {
  if (await claimHolds(ctx, readState(dir))) return;
  await loseJob(ctx, dir);
  throw new ClaimLost(`#${readState(dir).issue} is no longer held by this machine's claim`);
}

/**
 * Moves the issue to state label `to`: add it first, then drop the other held labels, so it never looks free.
 * Only while our claim holds: a label write on an issue someone else holds would take it over.
 */
export async function moveLabel(ctx: ServeContext, dir: string, to: string): Promise<void> {
  await ensureHeld(ctx, dir);
  const n = readState(dir).issue;
  const labels = (await ctx.gh.issue(n)).labels;
  if (!labels.includes(to)) await ctx.gh.addLabels(n, [to]);
  for (const l of HELD_LABELS) if (l !== to && labels.includes(l)) await ctx.gh.removeLabel(n, l);
}

async function reading(ctx: ServeContext, name: string, refresh = false): Promise<Subscription | undefined> {
  try {
    return (await ctx.usage({ refresh })).find((s) => s.name === name);
  } catch (e) {
    ctx.log(`usage read failed: ${(e as Error).message}`);
    return undefined;
  }
}

/** Starts (or resumes) the agent of a set-up job in its tmux window and labels the issue `air:running`. */
export async function startAgent(ctx: ServeContext, dir: string, opts: { fresh?: boolean } = {}): Promise<void> {
  const state = readState(dir);
  const n = state.issue;
  let job = jobOf(state);
  if (!['ready', 'paused', 'running'].includes(job.status)) throw new Error(`#${n} is ${job.status}; it can't be started`);
  await ensureHeld(ctx, dir);
  const request = requestOf(dir);
  const agent = ctx.config.agents[job.harness] ?? DEFAULT_AGENTS[job.harness];
  const resume = !opts.fresh && job.starts > 0 ? job.sessionId : undefined;
  let sessionId = resume;
  const real = realpathSync(dir);
  let argv: string[];
  if (resume !== undefined) {
    const instruction = job.pauseReason === 'exit' ? exitResumeInstruction(request.repos.length > 0) : RESUME_INSTRUCTION;
    argv = agentArgv({ harness: job.harness, agent, model: job.model, resume, instruction, dir: real });
  } else {
    sessionId = job.harness === 'claude' ? randomUUID() : undefined;
    argv = agentArgv({
      harness: job.harness, agent, model: job.model, sessionId, dir: real,
      instruction: job.starts > 0 ? restartInstruction(request.repos.length > 0) : TASK_INSTRUCTION,
    });
  }
  const usageBefore = job.usageBefore ?? (await reading(ctx, job.subscription));
  const sessions = sessionId !== undefined && job.harness === 'claude' && !job.sessions?.includes(sessionId) ? [...job.sessions ?? [], sessionId] : job.sessions;
  const startedAt = ctx.now();
  await ctx.tmux.startJob({ issue: n, cwd: dir, argv, env: { ...airEnv(dir), ...ctx.agentEnv(job.subscription) } });
  const pane = (await ctx.tmux.listJobs()).find((j) => j.issue === n);
  job = saveJob(ctx, dir, {
    status: 'running', sessionId, sessions, paneNonce: pane?.nonce, startedAt: startedAt.toISOString(), starts: job.starts + 1,
    pausedAt: undefined, pauseReason: undefined, resumeAfter: undefined, waiting: undefined, ...(usageBefore ? { usageBefore } : {}),
  });
  ctx.log(`#${n}: started ${job.harness} (${job.model}) ${resume ? `resuming session ${resume}` : 'fresh'}: ${argv.map((a) => JSON.stringify(a)).join(' ')}`);
  await moveLabel(ctx, dir, 'air:running');

  if (resume === undefined) return;
  // A resume that can't find its session exits at once: then start fresh, pointed at the work so far.
  const end = Date.now() + ctx.resumeCheckMs;
  for (;;) {
    // Someone else (`air stop`, a cancel) took over the job meanwhile: it is theirs now.
    const cur = readState(dir).job;
    if (cur?.status !== 'running' || cur.paneNonce !== pane?.nonce) return;
    const p = (await ctx.tmux.listJobs()).find((j) => j.issue === n && j.nonce === pane?.nonce);
    if (!p || p.dead) {
      if (isDone(dir)) return; // it finished at once: the watcher delivers
      ctx.log(`#${n}: resuming session ${resume} failed (exit ${p?.exitStatus ?? '?'}); starting fresh`);
      saveJob(ctx, dir, { status: 'stopping' });
      await ctx.tmux.stopJob(n, { graceMs: 0 });
      saveJob(ctx, dir, { status: 'paused', startedAt: undefined, runMs: job.runMs, starts: job.starts });
      return startAgent(ctx, dir, { fresh: true });
    }
    if (Date.now() >= end) return;
    await sleep(Math.min(200, Math.max(0, end - Date.now())));
  }
}

/**
 * Starts the agent, unless it already finished (AIR_DONE is there, say because its window closed as it
 * exited): then closes any window left and delivers instead. Checks the claim before either.
 */
export async function startOrDeliver(ctx: ServeContext, dir: string): Promise<'started' | 'delivered'> {
  if (!isDone(dir)) {
    await startAgent(ctx, dir);
    return 'started';
  }
  await ensureHeld(ctx, dir);
  const n = readState(dir).issue;
  if ((await ctx.tmux.listJobs()).some((j) => j.issue === n)) await ctx.tmux.stopJob(n, { graceMs: ctx.stopGraceMs });
  ctx.log(`#${n}: AIR_DONE is already there; delivering instead of starting the agent`);
  await finishJob(ctx, dir);
  return 'delivered';
}

/** Interrupts the agent, waits the grace period, closes its window; labels `air:paused`. Claim and workspace stay. */
export async function stopAgent(ctx: ServeContext, dir: string, reason: PauseReason, resumeAfter?: string): Promise<boolean> {
  const state = readState(dir);
  const job = jobOf(state);
  if (job.status !== 'running') return false;
  saveJob(ctx, dir, { status: 'stopping' });
  let sessionId = job.sessionId;
  if (job.harness === 'codex' && !sessionId && job.startedAt) sessionId = findCodexSession(dir, new Date(job.startedAt), ctx.codexHome);
  await ctx.tmux.stopJob(state.issue, { graceMs: ctx.stopGraceMs });
  saveJob(ctx, dir, {
    status: 'paused', runMs: agentMs(job, ctx.now()), startedAt: undefined, pausedAt: ctx.now().toISOString(), pauseReason: reason,
    resumeAfter, sessionId,
  });
  ctx.log(`#${state.issue}: stopped (${reason})${resumeAfter ? `; restarts after ${resumeAfter}` : ''}`);
  await moveLabel(ctx, dir, 'air:paused');
  return true;
}

/** What the job's agent has spent at API prices, from its own session records (`usage/spent.ts`); undefined if it left none. */
export function jobSpent(ctx: ServeContext, dir: string, job: JobRecord): Spent | undefined {
  // The login the agent ran with: the subscription's own, else the one its inherited environment names.
  const own = ctx.agentEnv(job.subscription);
  if (job.harness === 'claude') return claudeSpent(own.CLAUDE_CONFIG_DIR || ctx.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), job.sessions ?? []);
  return codexSpent(own.CODEX_HOME || ctx.codexHome || ctx.env.CODEX_HOME || join(homedir(), '.codex'), dir, new Date(readState(dir).createdAt));
}

/**
 * Settles what an ended job cost, once (`job.spend`): its agent's spend at API prices and, for a manual
 * subscription, the charge to its budget (the README's subscriptions.json section). Calls on a model the price
 * table doesn't cover cost nothing here, with a warning naming the model. Returns the footer lines saying so,
 * none for a job whose agent never started.
 */
export function settleSpend(ctx: ServeContext, dir: string, request: Request): string[] {
  const state = readState(dir);
  const job = jobOf(state);
  if (job.starts === 0) return [];
  const cfg = ctx.manual?.(job.subscription);
  let spend = job.spend;
  if (!spend) {
    const spent = jobSpent(ctx, dir, job);
    const n = `#${state.issue}`;
    if (spent?.unpriced.length) ctx.log(`${n}: warning: no API price for ${spent.unpriced.join(', ')}; calls on ${spent.unpriced.length === 1 ? 'it' : 'them'} are not charged`);
    const measured = spent ? { usd: spent.usd, ...(spent.unpriced.length ? { unpriced: spent.unpriced } : {}) } : {};
    if (!cfg) spend = { ...measured, charged: false };
    else if (!spent) spend = { charged: false, why: `${job.harness} left no usage record for this job` };
    else {
      try {
        spendUsd(ledgerFile(ctx.stateDir), cfg, spent.usd, ctx.now().getTime());
      } catch (e) {
        // An unusable ledger: the subscription reads as unknown until it is reset, so it takes no work meanwhile.
        ctx.log(`${n}: could not charge ${usd(spent.usd)} to ${job.subscription}: ${(e as Error).message}`);
        return [costLine(measured, request), `Not charged to manual budget ${code(job.subscription)}: ${(e as Error).message}.`];
      }
      spend = { ...measured, charged: true };
    }
    saveJob(ctx, dir, { spend });
    if (cfg) ctx.log(`${n}: ${spend.charged ? `charged ${usd(spend.usd!)} to` : 'did not charge'} ${job.subscription}${spend.why ? `: ${spend.why}` : ''}`);
  }
  const lines = [costLine(spend, request)];
  if (cfg) lines.push(spend.charged ? `Charged ${usd(spend.usd!)} to manual budget ${code(job.subscription)}.` : `Not charged to manual budget ${code(job.subscription)}: ${spend.why}.`);
  return lines;
}

export function costLine(spend: { usd?: number; unpriced?: string[] }, request: Request): string {
  const expects = `effort ${request.effort} expects ${usd(EFFORT_USD[request.effort as Effort])}`;
  const unpriced = spend.unpriced?.length ? ` Calls on ${spend.unpriced.map(code).join(', ')} are not counted: air's price table has no price for ${spend.unpriced.length === 1 ? 'it' : 'them'}.` : '';
  if (spend.usd === undefined) return `Cost at API prices: unknown, the agent left no usage record; ${expects}.`;
  // Nothing priced is not free: every call was on a model the table lacks.
  if (spend.usd === 0 && spend.unpriced?.length) return `Cost at API prices: unknown, air's price table has no price for ${spend.unpriced.map(code).join(', ')}; ${expects}.`;
  return `Cost at API prices: ${usd(spend.usd)}; ${expects}.${unpriced}`;
}

/**
 * Agent time, cost (`settleSpend`) and usage before and after: the calibration footer of the final comment,
 * and the `usage` of its `air-result` block (§10), which is there once the agent has started.
 */
export async function usageReport(ctx: ServeContext, dir: string, request: Request): Promise<{ footer: string; usage?: ResultUsage }> {
  const cost = settleSpend(ctx, dir, request);
  const state = readState(dir);
  const job = jobOf(state);
  const minutes = Math.round(agentMs(job, ctx.now()) / 60_000);
  const lines = [`<sub>air on ${code(state.host)}: subscription ${code(job.subscription)}, ${job.harness} ${code(job.model)}, agent time ${minutes} min.`, ...cost];
  const after = await reading(ctx, job.subscription, true);
  const b = job.usageBefore ? primaryWindow(job.usageBefore)?.usedPct : undefined;
  const a = after && !after.stale ? primaryWindow(after)?.usedPct : undefined;
  const fmt = (x: number | null | undefined) => (typeof x === 'number' ? `${Math.round(x * 10) / 10}%` : '?');
  if (job.usageBefore || after) lines.push(`Usage of \`${job.subscription}\`'s window: ${fmt(b)} before, ${fmt(a)} after.`);
  lines[lines.length - 1] += '</sub>';
  if (job.starts > 0) {
    const rec: ActualRecord = { issue: `${state.repo}#${state.issue}`, effort: request.effort as Effort, expected: EFFORT_USD[request.effort as Effort], usd: job.spend?.usd ?? null };
    lines.push(`<!-- air-usage ${JSON.stringify(rec)} -->`);
  }
  const footer = lines.join('\n');
  if (job.starts === 0) return { footer };
  const pct = (x: number | null | undefined) => (typeof x === 'number' && Number.isFinite(x) ? Math.min(100, Math.max(0, Math.round(x * 10) / 10)) : undefined);
  const [before_pct, after_pct] = [pct(b), pct(a)];
  return {
    footer,
    usage: {
      harness: job.harness, tier: request.model, ...(before_pct !== undefined ? { before_pct } : {}), ...(after_pct !== undefined ? { after_pct } : {}), attempts: job.starts,
    },
  };
}

/** `usageReport` for a workspace whose request or usage may be unreadable: never throws. */
async function safeUsage(ctx: ServeContext, dir: string): Promise<{ footer: string; usage?: ResultUsage }> {
  try {
    const state = readState(dir);
    return state.job ? await usageReport(ctx, dir, requestOf(dir)) : { footer: '' };
  } catch {
    return { footer: '' };
  }
}

/**
 * Gives the issue up with `air:failed` and a comment saying why. The job is `failing` until the release is
 * posted, so a gh error here is retried by the next tick instead of leaving the claim held.
 */
export async function failJob(ctx: ServeContext, dir: string, step: string, detail: string): Promise<void> {
  let state = readState(dir);
  if (state.job && state.job.status !== 'failing') {
    saveJob(ctx, dir, { status: 'failing', failure: { step, detail }, runMs: agentMs(state.job, ctx.now()), startedAt: undefined });
    state = readState(dir);
  }
  if ((await ctx.tmux.listJobs()).some((j) => j.issue === state.issue)) await ctx.tmux.stopJob(state.issue, { graceMs: 0 });
  const { footer, usage } = await safeUsage(ctx, dir);
  const r = await release({
    gh: ctx.gh, issue: state.issue, root: ctx.root, host: state.host, trust: ctx.trust, now: ctx.now, nonce: state.nonce,
    failure: { step, detail: footer ? `${detail}\n\n${footer}` : detail }, result: usage ? { usage } : {},
  });
  if (state.job) saveJob(ctx, dir, { status: 'failed' });
  if (r.status !== 'released') updateState(dir, { phase: 'lost', failure: step }, ctx.now());
  ctx.log(`#${state.issue}: failed at ${step}${r.status === 'released' ? '' : ` (release refused: ${r.message})`}`);
}

/** Delivery attempts (one per tick) before a delivery that keeps failing fails the request. */
export const MAX_DELIVERY_ATTEMPTS = 5;

/** Delivers a finished job: `air:done` on success, `air:failed` when the result is missing. */
export async function finishJob(ctx: ServeContext, dir: string): Promise<void> {
  const state0 = readState(dir);
  const n = state0.issue;
  if (jobOf(state0).status !== 'delivering') saveJob(ctx, dir, { status: 'delivering', runMs: agentMs(jobOf(state0), ctx.now()), startedAt: undefined });
  const state = readState(dir);
  const request = requestOf(dir);
  let result;
  try {
    await ensureHeld(ctx, dir); // never push, upload or comment for an issue we no longer hold
    const { footer, usage } = await usageReport(ctx, dir, request);
    result = await deliver(ctx, dir, state, request, footer, usage);
    if (result.ok) {
      await postResult(ctx.gh, n, await ctx.gh.viewer(), ctx.trust, {
        comment: result.comment, host: state.host, nonce: state.nonce, labels: (await ctx.gh.issue(n)).labels, final: 'air:done',
      });
    }
  } catch (e) {
    if (e instanceof ClaimLost) return;
    const attempts = (readState(dir).job!.deliveryAttempts ?? 0) + 1;
    saveJob(ctx, dir, { lastError: (e as Error).message, deliveryAttempts: attempts });
    if (attempts < MAX_DELIVERY_ATTEMPTS) {
      ctx.log(`#${n}: delivery failed (attempt ${attempts}), will retry: ${(e as Error).message}`);
      return;
    }
    return failJob(ctx, dir, 'delivery', `Delivery failed ${attempts} times. The last error was:\n\n${fenced((e as Error).message)}`);
  }
  if (!result.ok) return failJob(ctx, dir, result.step, result.detail);
  saveJob(ctx, dir, { status: 'done', lastError: undefined });
  updateState(dir, { phase: 'done' }, ctx.now());
  ctx.log(`#${n}: delivered (${request.deliver})`);
}

/**
 * Stops a job early (spec §11): closes the agent's window, makes a checkpoint, and posts the final comment
 * (why it stopped, what the checkpoint keeps, usage) with a release and a `partial` result, labelling the
 * issue `air:partial`. A timeout whose checkpoint keeps nothing fails instead (rule 5). The job is
 * `checkpointing` until the comment is posted, so a failing push, upload or comment is retried next tick;
 * after MAX_DELIVERY_ATTEMPTS the request fails.
 */
export async function partialJob(ctx: ServeContext, dir: string, reason?: { why: string; timeout?: boolean }): Promise<void> {
  const state0 = readState(dir);
  const n = state0.issue;
  const job0 = jobOf(state0);
  if (job0.status !== 'checkpointing') {
    saveJob(ctx, dir, { status: 'checkpointing', partial: reason ?? { why: 'it was stopped early.' }, runMs: agentMs(job0, ctx.now()), startedAt: undefined });
  }
  const why = readState(dir).job!.partial!;
  if ((await ctx.tmux.listJobs()).some((j) => j.issue === n)) await ctx.tmux.stopJob(n, { graceMs: ctx.stopGraceMs });
  let cp;
  const request = requestOf(dir);
  try {
    await ensureHeld(ctx, dir); // never push, upload or comment for an issue we no longer hold
    cp = await checkpoint(ctx, dir, readState(dir), request);
  } catch (e) {
    if (e instanceof ClaimLost) return;
    const attempts = (readState(dir).job!.deliveryAttempts ?? 0) + 1;
    saveJob(ctx, dir, { lastError: (e as Error).message, deliveryAttempts: attempts });
    if (attempts < MAX_DELIVERY_ATTEMPTS) {
      ctx.log(`#${n}: checkpoint failed (attempt ${attempts}), will retry: ${(e as Error).message}`);
      return;
    }
    return failJob(ctx, dir, 'the checkpoint', `The job stopped early because ${why.why} Its checkpoint failed ${attempts} times. The last error was:\n\n${fenced((e as Error).message)}`);
  }
  if (!cp.resume && why.timeout) return failJob(ctx, dir, 'the timeout', `The job stopped early because ${why.why}\n\n${cp.text}`);
  const { footer, usage } = await usageReport(ctx, dir, request);
  const state = readState(dir);
  const r = await release({
    gh: ctx.gh, issue: n, root: ctx.root, host: state.host, trust: ctx.trust, now: ctx.now, nonce: state.nonce,
    message: `air on ${code(state.host)} stopped this request early because ${why.why}\n\n${cp.text}\n\n${footer}`,
    result: { status: 'partial', report: 'comment', ...(usage ? { usage } : {}), ...(cp.resume ? { resume: cp.resume } : {}) },
  });
  if (r.status !== 'released') {
    updateState(dir, { phase: 'lost' }, ctx.now());
    ctx.log(`#${n}: stopped early, but the release was refused: ${r.message}`);
    return;
  }
  saveJob(ctx, dir, { status: 'partial', lastError: undefined });
  ctx.log(`#${n}: stopped early (partial): ${why.why}`);
}

/** The requester cancelled (`air:cancel`) or closed the issue: stop, comment, release. */
export async function cancelJob(ctx: ServeContext, dir: string, why: string): Promise<void> {
  const state = readState(dir);
  if ((await ctx.tmux.listJobs()).some((j) => j.issue === state.issue)) await ctx.tmux.stopJob(state.issue, { graceMs: ctx.stopGraceMs });
  const { usage } = await safeUsage(ctx, dir);
  await release({
    gh: ctx.gh, issue: state.issue, root: ctx.root, host: state.host, trust: ctx.trust, now: ctx.now, nonce: state.nonce,
    message: `${code(state.host)} stopped work on this request because ${why}, and released it.`, result: usage ? { usage } : {},
  });
  if (state.job) saveJob(ctx, dir, { status: 'cancelled', startedAt: undefined });
  ctx.log(`#${state.issue}: cancelled (${why})`);
}

/** Releases a job that stayed paused past PAUSE_LIMIT_MS. */
export async function expirePause(ctx: ServeContext, dir: string): Promise<void> {
  const state = readState(dir);
  const { usage } = await safeUsage(ctx, dir);
  await release({
    gh: ctx.gh, issue: state.issue, root: ctx.root, host: state.host, trust: ctx.trust, now: ctx.now, nonce: state.nonce,
    message: `${code(state.host)} paused this request ${Math.round(PAUSE_LIMIT_MS / 3600_000)} hours ago without resuming it, so it is releasing it for another server.`,
    result: usage ? { usage } : {},
  });
  saveJob(ctx, dir, { status: 'cancelled' });
  ctx.log(`#${state.issue}: released after a long pause`);
}

/** The pane's last lines, for a failure comment. */
export async function paneTail(ctx: ServeContext, n: number): Promise<string> {
  try {
    return tail((await ctx.tmux.capture(n, 40)) ?? '', 40, 3000);
  } catch {
    return '';
  }
}

/**
 * Why the agent's exit failed the job. The launcher shell reports an agent killed by signal N as status
 * 128 + N (see tmux.ts `signalOf`), so such a status reads as "killed by signal N (status 128 + N)".
 */
export function exitDetail(status: number | null, signal: number | null, pane: string): string {
  const by = (n: number) => `signal ${n}${signalName(n) ? ` (${signalName(n)})` : ''}`;
  const sig = signal ?? signalOf(status);
  const how = sig !== null
    ? `was killed by ${by(sig)}${status !== null ? ` (status ${status} = 128 + ${sig})` : ''}`
    : status !== null ? `exited with status ${status}` : 'exited';
  return `The agent ${how} without finishing.${pane.trim() ? `\n\nLast lines of its window:\n\n${fenced(pane)}` : ''}`;
}

/** The job record for a matched request: the subscription's harness (a manual one funds its configured one). */
export function jobFromChoice(ctx: ServeContext, choice: Choice): JobRecord {
  const sub = choice.subscription;
  const harness = (sub.harness === 'manual' ? ctx.config.subscriptions[sub.name]?.harness : sub.harness) as Harness;
  return { status: 'ready', harness, subscription: sub.name, model: choice.model, runMs: 0, starts: 0, expectedCost: choice.cost };
}

/**
 * A job record for a workspace set up by hand (`air claim` + `air setup`), so `air run` can start it: the
 * subscription and model come from matching, as in `air serve`.
 */
export async function ensureJob(ctx: ServeContext, dir: string): Promise<JobRecord> {
  const state = readState(dir);
  if (state.job) return state.job;
  const request = requestOf(dir);
  const choice = choose({ effort: request.effort, harness: request.harness, model: request.model }, await ctx.usage(), matchConfig(ctx.config), ctx.now());
  if ('none' in choice) throw new Error(`no local subscription fits #${state.issue}: ${choice.reasons.join('; ') || 'no subscriptions'}`);
  const job = jobFromChoice(ctx, choice);
  updateState(dir, { job }, ctx.now());
  return job;
}
