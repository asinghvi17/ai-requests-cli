// A job's lifecycle after setup (spec/v0.md §8 labels): start the agent in tmux, stop and resume it, notice
// it finished, deliver, fail, cancel. State lives in the workspace's state.json (`job`), so the server, a
// restarted server and the `air run/stop/start` commands all act on the same record.
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { HELD_LABELS, release } from '../claim/claim.ts';
import { code, fenced, tail } from '../claim/text.ts';
import { markedComments } from '../claim/trust.ts';
import { choose, primaryWindow, recordActual, type ActualRecord, type Choice, type Effort } from '../match/match.ts';
import type { Request } from '../spec/frontmatter.ts';
import { lint } from '../spec/lint.ts';
import { currentClaim } from '../spec/markers.ts';
import type { Subscription } from '../usage/types.ts';
import { airEnv, TASK_INSTRUCTION } from '../workspace/launch.ts';
import { DONE_FILE } from '../workspace/task.ts';
import { readState, REQUEST_FILE, updateState, type JobRecord, type PauseReason, type State } from '../workspace/state.ts';
import { agentArgv, findCodexSession, type Harness, restartInstruction, RESUME_INSTRUCTION } from './agent.ts';
import { matchConfig, type ServeContext } from './context.ts';
import { deliver } from './deliver.ts';

/** A job paused this long is given back. */
export const PAUSE_LIMIT_MS = 48 * 3600_000;

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

/** Moves the issue to state label `to`: add it first, then drop the other held labels, so it never looks free. */
export async function moveLabel(ctx: ServeContext, n: number, to: string): Promise<void> {
  const labels = (await ctx.gh.issue(n)).labels;
  if (!labels.includes(to)) await ctx.gh.addLabels(n, [to]);
  for (const l of HELD_LABELS) if (l !== to && labels.includes(l)) await ctx.gh.removeLabel(n, l);
}

/** Whether this workspace's claim still holds the issue. */
export async function claimHolds(ctx: ServeContext, state: State): Promise<boolean> {
  const holder = currentClaim(await markedComments(await ctx.gh.comments(state.issue), ctx.trust));
  return !!holder && holder.host === state.host && holder.nonce === state.nonce;
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
  const request = requestOf(dir);
  const agent = ctx.config.agents[job.harness] ?? { command: [job.harness], args: [] };
  const resume = !opts.fresh && job.starts > 0 ? job.sessionId : undefined;
  let sessionId = resume;
  let argv: string[];
  if (resume !== undefined) {
    argv = agentArgv({ harness: job.harness, agent, model: job.model, resume, instruction: RESUME_INSTRUCTION });
  } else {
    sessionId = job.harness === 'claude' ? randomUUID() : undefined;
    argv = agentArgv({
      harness: job.harness, agent, model: job.model, sessionId,
      instruction: job.starts > 0 ? restartInstruction(request.repo !== undefined) : TASK_INSTRUCTION,
    });
  }
  const usageBefore = job.usageBefore ?? (await reading(ctx, job.subscription));
  const startedAt = ctx.now();
  await ctx.tmux.startJob({ issue: n, cwd: dir, argv, env: { ...airEnv(dir), ...ctx.agentEnv(job.subscription) } });
  const pane = (await ctx.tmux.listJobs()).find((j) => j.issue === n);
  job = saveJob(ctx, dir, {
    status: 'running', sessionId, paneNonce: pane?.nonce, startedAt: startedAt.toISOString(), starts: job.starts + 1,
    pausedAt: undefined, pauseReason: undefined, resumeAfter: undefined, ...(usageBefore ? { usageBefore } : {}),
  });
  ctx.log(`#${n}: started ${job.harness} (${job.model}) ${resume ? `resuming session ${resume}` : 'fresh'}: ${argv.map((a) => JSON.stringify(a)).join(' ')}`);
  await moveLabel(ctx, n, 'air:running');

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
  await moveLabel(ctx, state.issue, 'air:paused');
  return true;
}

/** Usage before and after, and agent time: the calibration footer of the final comment. */
export async function usageFooter(ctx: ServeContext, state: State, request: Request): Promise<string> {
  const job = jobOf(state);
  const minutes = Math.round(agentMs(job, ctx.now()) / 60_000);
  const lines = [`<sub>air on ${code(state.host)}: subscription ${code(job.subscription)}, ${job.harness} ${code(job.model)}, agent time ${minutes} min.`];
  const after = await reading(ctx, job.subscription, true);
  let rec: ActualRecord | undefined;
  if (job.usageBefore && after) {
    rec = recordActual(`${state.repo}#${state.issue}`, request.effort as Effort, job.usageBefore, after, matchConfig(ctx.config));
    const b = primaryWindow(job.usageBefore)?.usedPct, a = primaryWindow(after)?.usedPct;
    const fmt = (x: number | null | undefined) => (typeof x === 'number' ? `${Math.round(x * 10) / 10}%` : '?');
    lines.push(rec.delta === null
      ? `Usage: ${fmt(b)} before, ${fmt(a)} after (not comparable). Effort ${request.effort} expects ${rec.expected}%.`
      : `Usage: ${fmt(b)} before, ${fmt(a)} after: ${Math.round(rec.delta * 10) / 10} points; effort ${request.effort} expects ${rec.expected}, measured ${Math.round(rec.share! * 10) / 10}.`);
  }
  lines[lines.length - 1] += '</sub>';
  if (rec) lines.push(`<!-- air-usage ${JSON.stringify(rec)} -->`);
  return lines.join('\n');
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
  let footer = '';
  try {
    footer = state.job ? `\n\n${await usageFooter(ctx, state, requestOf(dir))}` : '';
  } catch {
    // no footer
  }
  const r = await release({ gh: ctx.gh, issue: state.issue, root: ctx.root, host: state.host, trust: ctx.trust, now: ctx.now, nonce: state.nonce, failure: { step, detail: `${detail}${footer}` } });
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
    const footer = await usageFooter(ctx, state, request);
    result = await deliver(ctx, dir, state, request, footer);
    if (result.ok) {
      if (!state.job!.delivery?.commented) {
        await ctx.gh.comment(n, result.comment);
        saveJob(ctx, dir, { delivery: { ...readState(dir).job!.delivery, commented: true } });
      }
      await moveLabel(ctx, n, 'air:done');
      await ctx.gh.unassign(n, await ctx.gh.viewer());
    }
  } catch (e) {
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

/** The requester cancelled (`air:cancel`) or closed the issue: stop, comment, release. */
export async function cancelJob(ctx: ServeContext, dir: string, why: string): Promise<void> {
  const state = readState(dir);
  if ((await ctx.tmux.listJobs()).some((j) => j.issue === state.issue)) await ctx.tmux.stopJob(state.issue, { graceMs: ctx.stopGraceMs });
  await release({
    gh: ctx.gh, issue: state.issue, root: ctx.root, host: state.host, trust: ctx.trust, now: ctx.now, nonce: state.nonce,
    message: `${code(state.host)} stopped work on this request because ${why}, and released it.`,
  });
  if (state.job) saveJob(ctx, dir, { status: 'cancelled', startedAt: undefined });
  ctx.log(`#${state.issue}: cancelled (${why})`);
}

/** Releases a job that stayed paused past PAUSE_LIMIT_MS. */
export async function expirePause(ctx: ServeContext, dir: string): Promise<void> {
  const state = readState(dir);
  await release({
    gh: ctx.gh, issue: state.issue, root: ctx.root, host: state.host, trust: ctx.trust, now: ctx.now, nonce: state.nonce,
    message: `${code(state.host)} paused this request ${Math.round(PAUSE_LIMIT_MS / 3600_000)} hours ago without resuming it, so it is releasing it for another server.`,
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

export function exitDetail(status: number | null, signal: number | null, pane: string): string {
  return `The agent exited ${status !== null ? `with status ${status}` : `on signal ${signal ?? '?'}`} without finishing.${pane.trim() ? `\n\nLast lines of its window:\n\n${fenced(pane)}` : ''}`;
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
