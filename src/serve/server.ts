// `air serve`: a code-driven loop. Each tick it watches the jobs it holds (finish, timeout, quota, cancel,
// long pauses, restarts), then, unless paused, polls the requests repo, matches open requests against the
// local quota and claims the best fit, sets it up and starts its agent. Everything slow (claim wait, setup,
// delivery) is tracked per issue, so one bad issue or one failing gh call only costs a log line.
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { backOff, claim, claimable, deadlineTime, release } from '../claim/claim.ts';
import { markedComments } from '../claim/trust.ts';
import { currentClaim } from '../spec/markers.ts';
import { canTakeMore, choose, primaryWindow, recordActual, type Effort } from '../match/match.ts';
import { code, fenced } from '../claim/text.ts';
import { lint } from '../spec/lint.ts';
import type { Subscription } from '../usage/types.ts';
import { setup } from '../workspace/setup.ts';
import { allWorkspaces, ENDED, readState, updateState, type JobRecord, type State } from '../workspace/state.ts';
import { matchConfig, type ServeContext } from './context.ts';
import {
  agentMs, cancelJob, claimHolds, ClaimLost, exitDetail, expirePause, failJob, finishJob, isDone, jobFromChoice, loseJob, moveLabel, paneTail, partialJob,
  PAUSE_LIMIT_MS, QUOTA_WAIT_MS, requestOf, saveJob, startAgent, startOrDeliver, stopAgent, type Workspace,
} from './jobs.ts';
import { sweep } from '../sweep/sweep.ts';
import { readServerState, updateServerState } from './state.ts';
import { matchPrompt, MAX_WAITING_COMMENTS, SETTLE_MS, STUCK_MS, waitingFor } from './prompts.ts';
import { configPath } from '../config.ts';

export interface ServerOptions {
  /** Wait for `air run` instead of starting agents. */
  manual?: boolean;
}

const HELD_PHASES = ['claiming', 'claimed', 'setting-up', 'ready'];
/** A `claiming` workspace this old was left by a claim that died (`claim()` takes seconds). */
export const CLAIM_STALE_MS = 10 * 60_000;
/** After a claim attempt throws (GitHub refused a step, an outage), the issue is left alone this long. */
export const CLAIM_RETRY_MS = 60 * 60_000;
/** `--once`: how long to keep polling when the first poll finds nothing, and how often. */
export const ONCE_WAIT_MS = 60_000;
export const ONCE_POLL_MS = 10_000;
const STOPPING_LIMIT_MS = 5 * 60_000;
/** `air serve` runs `air sweep` at most this often (spec §7: once a day). */
export const SWEEP_INTERVAL_MS = 24 * 3600_000;

/** Whether `sub` has run out: an all-model window (or the window scoped to `model`) at 100%. */
export function exhausted(sub: Subscription | undefined, model: string): { resetsAt?: string } | undefined {
  if (!sub || sub.stale || sub.incomplete) return undefined; // unknown is not exhausted
  const full = sub.windows.filter((w) => typeof w.usedPct === 'number' && w.usedPct >= 100 && (!w.scope || model.toLowerCase().includes(w.scope.toLowerCase())));
  if (!full.length) return undefined;
  const resets = full.map((w) => w.resetsAt).filter((r): r is string => !!r && !Number.isNaN(Date.parse(r))).sort();
  return resets.length ? { resetsAt: resets.at(-1)! } : {};
}

/**
 * How far a job is past twice its effort's share (spec §11 rule 4): the points it used of its subscription's
 * weekly (else monthly) window since it first started, when that is more than twice `expectedCost`.
 * Undefined when it isn't, or when the readings can't tell (unknown, stale, or a window that reset since).
 */
export function overEffort(job: JobRecord, sub: Subscription | undefined, effort: Effort): { used: number; cap: number } | undefined {
  if (!sub || !job.usageBefore || job.expectedCost === undefined) return undefined;
  const { delta } = recordActual('', effort, job.usageBefore, sub);
  const cap = 2 * job.expectedCost;
  return delta !== null && delta > cap ? { used: delta, cap } : undefined;
}

/** Usage with the expected cost still to come of jobs we hold added on, so a tick never over-commits. */
export function committedUsage(usage: Subscription[], held: Workspace[]): Subscription[] {
  const extra = new Map<string, number>();
  for (const { state } of held) {
    const job = state.job;
    if (!job || ENDED.includes(job.status)) continue;
    const cost = job.expectedCost ?? 0;
    const now = usage.find((s) => s.name === job.subscription);
    const before = job.usageBefore ? primaryWindow(job.usageBefore)?.usedPct : undefined;
    const used = now ? primaryWindow(now)?.usedPct : undefined;
    const spent = typeof before === 'number' && typeof used === 'number' ? Math.max(0, used - before) : 0;
    extra.set(job.subscription, (extra.get(job.subscription) ?? 0) + Math.max(0, cost - spent));
  }
  return usage.map((s) => addUsage(s, extra.get(s.name) ?? 0));
}

function addUsage(s: Subscription, points: number): Subscription {
  if (!points) return s;
  const primary = primaryWindow(s);
  return { ...s, windows: s.windows.map((w) => (w === primary && typeof w.usedPct === 'number' ? { ...w, usedPct: w.usedPct + points } : w)) };
}

const bodyHash = (body: string) => createHash('sha256').update(body).digest('hex').slice(0, 16);

export function createServer(ctx: ServeContext, opts: ServerOptions = {}) {
  const repo = ctx.gh.repo;
  /** Claims, setups, starts and deliveries in progress, by issue. */
  const inflight = new Map<number, Promise<void>>();
  /** Issues we won't look at again until their body changes (invalid, untrusted, past deadline...). */
  const skip = new Map<number, string>();
  /** Last "no fit" reason logged per issue, so an unchanged one isn't logged every tick. */
  const noFit = new Map<number, string>();
  /** Issue -> when to try it again (unless its body changes), after a claim attempt that threw. */
  const claimFailed = new Map<number, { hash: string; until: number }>();
  /** Issue -> why its last claim was refused, for refusals checked again every tick (logged once per reason). */
  const refused = new Map<number, string>();
  let adopting = true;
  /**
   * Workspaces left `claiming` or `setting-up` by a claim or setup that died (a restart, or a release that
   * failed): to give back, retried every tick until that works.
   */
  const orphans = new Set<string>();
  /**
   * Running jobs whose window one tick could not find, and whether that tick was the restart. A single miss
   * never decides a job's fate: only a second consecutive miss pauses (or, after a restart, resumes) it.
   */
  const missing = new Map<number, { restart: boolean; nonce: string | undefined; starts: number }>();
  /** Running job -> its pane's last screen, since when it has not changed, and the prompt at its bottom since when. */
  const screens = new Map<number, { text: string; since: number; prompt: string | undefined; promptSince: number }>();
  /** Running job -> the line shown in the tmux status bar while it waits on the volunteer. */
  const notices = new Map<number, string>();
  let notice: string | undefined;

  const err = (e: unknown) => (e instanceof Error ? e.message : String(e));

  function track(n: number, what: string, p: Promise<void>): void {
    const t = p.catch((e) => ctx.log(e instanceof ClaimLost ? `#${n}: ${what} skipped: ${err(e)}` : `#${n}: ${what} failed: ${err(e)}`)).finally(() => {
      if (inflight.get(n) === t) inflight.delete(n);
    });
    inflight.set(n, t);
  }

  function held(): Workspace[] {
    return allWorkspaces(ctx.root, repo).filter((w) => HELD_PHASES.includes(w.state.phase));
  }

  /** Setup, then start (or, with --manual, wait for `air run`). */
  async function prepare(dir: string): Promise<void> {
    const { issue: n } = readState(dir);
    ctx.log(`#${n}: setting up in ${dir}`);
    let r;
    try {
      r = await setup({
        gh: ctx.gh, issue: n, root: ctx.root, host: ctx.host, ghHost: ctx.ghHost, env: ctx.env, trust: ctx.trust, now: ctx.now,
        ...(ctx.download ? { download: ctx.download } : {}), ...(ctx.setupTimeoutMs ? { timeoutMs: ctx.setupTimeoutMs } : {}),
      });
    } catch (e) {
      // Setup (or the release after a failed setup) threw part way: give the claim back on a later tick.
      if (readState(dir).phase === 'setting-up') orphans.add(dir);
      throw e;
    }
    if (r.status === 'failed') return ctx.log(`#${n}: setup failed at ${r.step}: ${r.message}`);
    if (r.status === 'refused') return ctx.log(`#${n}: setup refused: ${r.message}`);
    if (opts.manual) return ctx.log(`#${n}: set up; start it with \`air run ${n}\``);
    await startAgent(ctx, dir);
  }

  /** One held workspace: whatever its state calls for this tick. */
  async function watch(ws: Workspace, jobs: Awaited<ReturnType<ServeContext['tmux']['listJobs']>>, usage: Subscription[], first: boolean): Promise<void> {
    const { dir, state } = ws;
    const n = state.issue;
    if (state.phase === 'claiming') {
      // This server's own claims finish inside `poll`. One found at startup, or long after it began, was cut
      // off (a crash, a restart): give it back if it holds, so the issue isn't held with nobody acting on it.
      if (first || ctx.now().getTime() - Date.parse(state.updatedAt) >= CLAIM_STALE_MS) orphans.add(dir);
      if (!orphans.has(dir)) return;
      const r = await release({ gh: ctx.gh, issue: n, root: ctx.root, host: state.host, trust: ctx.trust, now: ctx.now, nonce: state.nonce,
        message: `Released by ${code(state.host)}: its claim was cut off before work started.` });
      if (r.status !== 'released') {
        // It does not hold (a rival's claim does, or ours never counted): back off as a claim that lost does.
        const comments = await ctx.gh.comments(n);
        await backOff(ctx.gh, n, await ctx.gh.viewer(), state.claimCommentId, comments, currentClaim(await markedComments(comments, ctx.trust)));
        updateState(dir, { phase: 'lost' }, ctx.now());
      }
      orphans.delete(dir);
      ctx.log(`#${n}: interrupted claim ${r.status === 'released' ? 'released' : `dropped (${r.message})`}`);
      return;
    }
    if (state.phase === 'claimed') return track(n, 'setup', prepare(dir));
    if (state.phase === 'setting-up') {
      // Setups in progress are in `inflight`; at startup, any left behind died with the last server. (A setup
      // `air setup` runs by hand in another process is left alone while this server runs.)
      if (first) orphans.add(dir);
      if (!orphans.has(dir)) return;
      const r = await release({ gh: ctx.gh, issue: n, root: ctx.root, host: state.host, trust: ctx.trust, now: ctx.now, nonce: state.nonce,
        failure: { step: 'setup', detail: 'Setup was interrupted (the server restarted, or failed while giving the claim back).' } });
      if (r.status !== 'released') updateState(dir, { phase: 'lost' }, ctx.now());
      orphans.delete(dir);
      return;
    }
    const job = state.job;
    if (!job) return; // set up by `air setup` by hand: `air run` gives it a job
    if (ENDED.includes(job.status)) return;
    if (job.status === 'failing') {
      // release() checks the claim itself; a lost one makes the workspace `lost`.
      const f = job.failure ?? { step: 'the agent', detail: 'The job failed.' };
      return track(n, 'failure', failJob(ctx, dir, f.step, f.detail));
    }
    // Everything below may write to the issue (labels, comments, a resume): only while our claim holds.
    if (!(await claimHolds(ctx, state))) return loseJob(ctx, dir);
    if (job.status === 'delivering') return track(n, 'delivery', finishJob(ctx, dir));
    if (job.status === 'checkpointing') return track(n, 'checkpoint', partialJob(ctx, dir));

    // The requester can call it off at any time before delivery.
    const issue = await ctx.gh.issue(n);
    if (issue.state !== 'open' || issue.labels.includes('air:cancel')) {
      return track(n, 'cancel', cancelJob(ctx, dir, issue.state !== 'open' ? 'the issue was closed' : 'the requester added `air:cancel`'));
    }

    // Labels follow the job: an earlier label call that failed is repaired here.
    const want = job.status === 'running' ? 'air:running' : job.status === 'paused' ? 'air:paused' : undefined;
    if (want && !issue.labels.includes(want)) await moveLabel(ctx, dir, want);

    const now = ctx.now();
    if (job.status === 'ready') {
      if (!opts.manual) track(n, 'start', startAgent(ctx, dir));
      return;
    }
    if (job.status === 'stopping') {
      // An `air stop` that died half-way: settle it as a pause.
      if (now.getTime() - Date.parse(state.updatedAt) > STOPPING_LIMIT_MS) {
        if (jobs.some((j) => j.issue === n)) await ctx.tmux.stopJob(n, { graceMs: 0 });
        saveJob(ctx, dir, { status: 'paused', runMs: agentMs({ ...job, status: 'running' }, now), startedAt: undefined, pausedAt: now.toISOString(), pauseReason: 'operator' });
        await moveLabel(ctx, dir, 'air:paused');
      }
      return;
    }
    if (job.status === 'paused') return watchPaused(dir, state, job, usage, now);

    // running
    let pane = jobs.find((j) => j.issue === n && j.nonce === job.paneNonce);
    if (!pane && job.paneNonce === undefined) {
      // A start that could not read its pane back recorded no nonce: adopt the issue's only tagged pane.
      const ours = jobs.filter((j) => j.issue === n);
      if (ours.length === 1) {
        pane = ours[0]!;
        saveJob(ctx, dir, { paneNonce: pane.nonce });
        ctx.log(`#${n}: adopted its window ${pane.windowId} (no pane recorded at start)`);
      }
    }
    if (pane) missing.delete(n);
    if (isDone(dir)) {
      if (pane && !pane.dead) await ctx.tmux.stopJob(n, { graceMs: ctx.stopGraceMs });
      else if (pane) await ctx.tmux.stopJob(n, { graceMs: 0 });
      return track(n, 'delivery', finishJob(ctx, dir));
    }
    if (!pane) {
      // The tick's job list may predate a start that just finished (here or in `air run/start`): look again.
      const fresh = readState(dir).job;
      if (fresh?.status !== 'running') return;
      if ((await ctx.tmux.listJobs()).some((j) => j.issue === n && j.nonce === fresh.paneNonce)) return void missing.delete(n);
      // An agent that exits right after creating AIR_DONE closes its window: that is a finish, not a pause.
      if (isDone(dir)) {
        missing.delete(n);
        ctx.log(`#${n}: its window is gone and AIR_DONE is there; delivering`);
        return track(n, 'delivery', finishJob(ctx, dir));
      }
      const miss = missing.get(n);
      if (miss?.nonce !== job.paneNonce || miss?.starts !== job.starts) {
        missing.set(n, { restart: first, nonce: job.paneNonce, starts: job.starts });
        ctx.log(`#${n}: its window (pane ${job.paneNonce ?? 'not recorded'}) was not found; checking again next tick`);
        return;
      }
      missing.delete(n);
      if (miss!.restart || first) {
        // The window is gone (a reboot, or tmux died) while we were down: resume the agent.
        ctx.log(`#${n}: its window is gone after a restart; resuming`);
        saveJob(ctx, dir, { status: 'paused', runMs: job.runMs, startedAt: undefined, pausedAt: now.toISOString(), pauseReason: 'restart' });
        return track(n, 'restart', startAgent(ctx, dir));
      }
      ctx.log(`#${n}: its window was closed; paused (\`air start ${n}\` resumes it)`);
      saveJob(ctx, dir, { status: 'paused', runMs: agentMs(job, now), startedAt: undefined, pausedAt: now.toISOString(), pauseReason: 'operator' });
      await moveLabel(ctx, dir, 'air:paused');
      return;
    }
    if (first) ctx.log(`#${n}: re-adopted its running agent (${pane.windowId})`);
    const request = requestOf(dir);
    if (pane.dead) {
      // AIR_DONE may have appeared since the check above, just before the agent exited.
      if (isDone(dir)) {
        await ctx.tmux.stopJob(n, { graceMs: 0 });
        return track(n, 'delivery', finishJob(ctx, dir));
      }
      // Exited without AIR_DONE, whatever its status (§11 rule 3): resume its session once, then stop early.
      const text = await paneTail(ctx, n);
      const how = exitDetail(pane.exitStatus, pane.exitSignal, text);
      await ctx.tmux.stopJob(n, { graceMs: 0 });
      if ((job.exitResumes ?? 0) < 1) {
        ctx.log(`#${n}: the agent exited without AIR_DONE (status ${pane.exitStatus ?? '?'}); resuming it once`);
        saveJob(ctx, dir, { status: 'paused', runMs: agentMs(job, now), startedAt: undefined, pausedAt: now.toISOString(), pauseReason: 'exit', exitResumes: (job.exitResumes ?? 0) + 1 });
        return track(n, 'resume', startAgent(ctx, dir));
      }
      return track(n, 'partial', partialJob(ctx, dir, { why: `the agent exited without finishing, again after being resumed once. ${how}` }));
    }
    if (agentMs(job, now) > request.timeoutMinutes * 60_000) {
      const text = await paneTail(ctx, n);
      return track(n, 'timeout', partialJob(ctx, dir, {
        timeout: true,
        why: `the agent ran past the request's \`timeout\` of ${request.timeoutMinutes} min and was stopped.${text.trim() ? `\n\nLast lines of its window:\n\n${fenced(text)}` : ''}`,
      }));
    }
    const sub = usage.find((s) => s.name === job.subscription);
    const over = overEffort(job, sub, request.effort as Effort);
    if (over) {
      const r = (x: number) => Math.round(x * 10) / 10;
      return track(n, 'effort cap', partialJob(ctx, dir, {
        why: `it used ${r(over.used)} points of subscription \`${job.subscription}\`'s usage window, more than twice the ${r(over.cap / 2)} that effort ${request.effort} stands for here.`,
      }));
    }
    const out = exhausted(sub, job.model);
    if (out) {
      const wait = out.resetsAt ? Date.parse(out.resetsAt) - now.getTime() : undefined;
      if (wait !== undefined && wait > QUOTA_WAIT_MS) {
        ctx.log(`#${n}: subscription ${job.subscription} is out of quota until ${out.resetsAt}, more than 24 h away; stopping early`);
        return track(n, 'quota stop', partialJob(ctx, dir, { why: `subscription \`${job.subscription}\` ran out of quota, and it only resets at ${out.resetsAt}, more than 24 hours away.` }));
      }
      ctx.log(`#${n}: subscription ${job.subscription} is out of quota; stopping until ${out.resetsAt ?? 'it recovers'}`);
      return track(n, 'quota stop', stopAgent(ctx, dir, 'quota', out.resetsAt).then(() => {}));
    }
    await watchPrompt(dir, n, job, pane.windowId);
  }

  /**
   * Whether the running agent waits on a person: a known prompt that has stayed at the bottom of its screen
   * for SETTLE_MS, or a screen that has not changed for STUCK_MS (idle). Logs each waiting episode once with
   * its fix, records it for `air status` and puts it in the tmux status bar. A prompt, not idleness, also
   * tells the issue: once per episode, at most MAX_WAITING_COMMENTS times per job. The episode ends when the
   * prompt leaves the screen (idle: when the screen changes). The job keeps running: its timeout decides.
   */
  async function watchPrompt(dir: string, n: number, job: JobRecord, windowId: string): Promise<void> {
    const text = await ctx.tmux.screen(n);
    if (text === null) return;
    const now = ctx.now().getTime();
    const prev = screens.get(n);
    const changed = prev !== undefined && prev.text !== text;
    const shown = matchPrompt(job.harness, text);
    const since = prev?.text === text ? prev.since : now;
    const promptSince = shown && prev?.prompt === shown.id ? prev.promptSince : now;
    screens.set(n, { text, since, prompt: shown?.id, promptSince });
    const found = shown ? (now - promptSince >= SETTLE_MS ? shown : undefined) : now - since >= STUCK_MS ? 'idle' : undefined;
    const notice = (what: string) => notices.set(n, `#${n} ${job.harness} waits on you: ${what}; see air status ${n}`);
    if (!found) {
      const waiting = job.waiting;
      // A restart keeps the episode: an idle one ends when the screen changes, a prompt when it leaves the screen.
      if (waiting && (waiting.prompt === 'idle' ? changed : shown?.id !== waiting.prompt)) {
        notices.delete(n);
        saveJob(ctx, dir, { waiting: undefined });
        ctx.log(`#${n}: ${job.harness} moved on from ${waiting.what}`);
      } else if (waiting) notice(waiting.what);
      else notices.delete(n);
      return;
    }
    const w = waitingFor(found, {
      configFile: ctx.configFile ?? configPath(), workspaceRoot: ctx.root,
      attach: `\`air attach ${n}\` (\`tmux -L ${ctx.tmux.socket} attach -t ${windowId}\`)`,
    });
    notice(w.what);
    let waiting = job.waiting;
    if (waiting?.prompt !== w.prompt) {
      waiting = { ...w, since: new Date(found === 'idle' ? since : promptSince).toISOString() };
      saveJob(ctx, dir, { waiting });
      ctx.log(`#${n}: ${job.harness} is waiting on you: ${w.what}. Fix: ${w.fix}`);
    }
    const posted = job.waitingComments ?? 0;
    if (found === 'idle' || waiting.notified || posted >= MAX_WAITING_COMMENTS) return;
    await ctx.gh.comment(n, `The ${job.harness} agent working on this request on ${code(ctx.host)} is waiting on the volunteer: ${w.what}. ` +
      'They have been told. The job keeps running, and the request\'s `timeout` still applies.');
    saveJob(ctx, dir, { waiting: { ...waiting, notified: true }, waitingComments: posted + 1 });
  }

  /** Puts the waiting jobs' notices in the tmux status bar, or clears it; only when that changes. */
  async function showNotices(running: Set<number>): Promise<void> {
    for (const n of [...screens.keys()]) if (!running.has(n)) screens.delete(n);
    for (const n of [...notices.keys()]) if (!running.has(n)) notices.delete(n);
    const text = notices.size ? [...notices.values()].join(' | ') : undefined;
    if (text === notice) return;
    await ctx.tmux.setNotice(text);
    notice = text;
  }

  /** When a quota pause gives up (§11): 24 h after it began, but not before an hour past the reset it waits on. */
  function quotaDeadline(job: JobRecord): number {
    const paused = Date.parse(job.pausedAt ?? '');
    const reset = Date.parse(job.resumeAfter ?? '');
    return Math.max(Number.isFinite(paused) ? paused + QUOTA_WAIT_MS : 0, Number.isFinite(reset) ? reset + 3600_000 : 0);
  }

  async function watchPaused(dir: string, state: State, job: JobRecord, usage: Subscription[], now: Date): Promise<void> {
    const n = state.issue;
    // A quota pause is bounded by QUOTA_WAIT_MS instead (§8: it is exempt from the 48 h release).
    if (job.pauseReason !== 'quota' && job.pausedAt && now.getTime() - Date.parse(job.pausedAt) > PAUSE_LIMIT_MS) return track(n, 'release', expirePause(ctx, dir));
    // watch() checked the claim this tick; startAgent checks it again before it touches the issue.
    if (job.pauseReason === 'restart' || job.pauseReason === 'exit') return track(n, 'restart', startOrDeliver(ctx, dir).then(() => {}));
    if (job.pauseReason !== 'quota') return;
    if (now.getTime() > quotaDeadline(job)) {
      ctx.log(`#${n}: quota did not come back within 24 hours; stopping early`);
      return track(n, 'quota stop', partialJob(ctx, dir, { why: `subscription \`${job.subscription}\` ran out of quota and did not recover within 24 hours.` }));
    }
    if (job.resumeAfter && now.getTime() < Date.parse(job.resumeAfter)) return;
    let sub = usage.find((s) => s.name === job.subscription);
    if (job.resumeAfter) sub = (await ctx.usage({ refresh: true })).find((s) => s.name === job.subscription);
    if (!sub || sub.stale || exhausted(sub, job.model)) return;
    ctx.log(`#${n}: quota is back; restarting`);
    track(n, 'restart', startOrDeliver(ctx, dir).then(() => {}));
  }

  /** Poll, match, claim. Returns how many open requests were candidates (unclaimed, not ours), if it polled. */
  async function poll(usage: Subscription[], mine: Workspace[]): Promise<number | undefined> {
    let active = mine.filter((w) => !ENDED.includes(w.state.job?.status ?? 'ready')).length;
    for (const n of inflight.keys()) if (!mine.some((w) => w.state.issue === n)) active++;
    if (!canTakeMore(active, ctx.config.max_jobs)) return undefined;
    const ours = new Set(mine.map((w) => w.state.issue));
    let free = committedUsage(usage, mine);
    const issues = await ctx.api.openRequests();
    let candidates = 0;
    for (const issue of issues) {
      const n = issue.number;
      if (ours.has(n) || inflight.has(n)) continue;
      if (!claimable(issue).ok || issue.assignees.length > 0) continue;
      candidates++;
      const hash = bodyHash(issue.body);
      if (skip.get(n) === hash) continue;
      const failed = claimFailed.get(n);
      if (failed?.hash === hash && failed.until > ctx.now().getTime()) continue;
      const linted = lint(issue.body);
      if (!linted.ok || !linted.request) {
        // claim() checks trust, then posts the lint or unsupported-version comment once, and claims nothing.
        const r = await claim({ gh: ctx.gh, issue: n, root: ctx.root, host: ctx.host, trust: ctx.trust, now: ctx.now, waitMs: 0 });
        ctx.log(`#${n}: skipped: ${r.status === 'refused' ? r.message.split('\n')[0] : r.status}`);
        skip.set(n, hash);
        continue;
      }
      const request = linted.request;
      if (request.deadline !== undefined && ctx.now().getTime() > deadlineTime(request.deadline)) {
        ctx.log(`#${n}: skipped: past its deadline (${request.deadline})`);
        skip.set(n, hash);
        continue;
      }
      const choice = choose({ effort: request.effort, harness: request.harness, model: request.model }, free, matchConfig(ctx.config, ctx.refused), ctx.now());
      if ('none' in choice) {
        const why = choice.reasons.join('; ') || 'no subscriptions';
        if (noFit.get(n) !== why) ctx.log(`#${n}: no fit: ${why}`);
        noFit.set(n, why);
        continue;
      }
      noFit.delete(n);
      ctx.log(`#${n}: fits ${choice.reason}; claiming`);
      let r;
      try {
        r = await claim({
          gh: ctx.gh, issue: n, root: ctx.root, host: ctx.host, trust: ctx.trust, now: ctx.now, ghHost: ctx.ghHost, env: ctx.env,
          ...(ctx.claimWaitMs !== undefined ? { waitMs: ctx.claimWaitMs } : {}),
        });
      } catch (e) {
        // claim() withdrew its claim. Trying again every tick would post (and withdraw) a claim every tick.
        claimFailed.set(n, { hash, until: ctx.now().getTime() + CLAIM_RETRY_MS });
        ctx.log(`#${n}: claim failed: ${err(e)}; trying it again in ${CLAIM_RETRY_MS / 60_000} min`);
        continue;
      }
      claimFailed.delete(n);
      if (r.status === 'lost') {
        ctx.log(`#${n}: lost the claim to ${r.holder}`);
        continue;
      }
      if (r.status === 'refused') {
        // A repo that can't be resolved or pushed to may be fixed without editing the body (access granted, a
        // branch pushed): those are checked again every tick, and logged when the reason changes.
        const again = r.reason === 'held' || r.reason === 'repos' || r.reason === 'cannot-push';
        if (!again || refused.get(n) !== r.message) ctx.log(`#${n}: not claimed: ${r.message.split('\n')[0]}`);
        if (again) refused.set(n, r.message);
        else skip.set(n, hash);
        continue;
      }
      refused.delete(n);
      updateState(r.dir, { job: jobFromChoice(ctx, choice) }, ctx.now());
      ctx.log(`#${n}: claimed (nonce ${r.state.nonce}) for ${choice.subscription.name}/${choice.model}`);
      track(n, 'setup', prepare(r.dir));
      free = free.map((s) => (s.name === choice.subscription.name ? addUsage(s, choice.cost) : s));
      if (!canTakeMore(++active, ctx.config.max_jobs)) return candidates;
    }
    return candidates;
  }

  /**
   * One tick. Never throws: every failure is logged and the next tick tries again. Returns the number of
   * candidate requests its poll saw, or undefined when it did not poll (or the poll failed).
   */
  async function tick(o: { poll?: boolean } = {}): Promise<number | undefined> {
    try {
      let usage: Subscription[] = [];
      try {
        usage = await ctx.usage();
      } catch (e) {
        ctx.log(`usage read failed: ${err(e)}`);
      }
      const jobs = await ctx.tmux.listJobs();
      // The first tick that sees tmux is the restart: windows missing then were lost while we were down.
      const first = adopting;
      adopting = false;
      const mine = held();
      for (const ws of mine) {
        if (inflight.has(ws.state.issue)) continue;
        try {
          await watch(ws, jobs, usage, first);
        } catch (e) {
          ctx.log(`#${ws.state.issue}: ${err(e)}`);
        }
      }
      try {
        await showNotices(new Set(held().filter((w) => w.state.job?.status === 'running').map((w) => w.state.issue)));
      } catch (e) {
        ctx.log(`tmux status: ${err(e)}`);
      }
      if (o.poll === false || readServerState(ctx.stateDir).paused) return undefined;
      return await poll(usage, held());
    } catch (e) {
      ctx.log(`tick failed: ${err(e)}`);
      return undefined;
    }
  }

  let sweeping: Promise<void> | undefined;
  /**
   * Starts the daily sweep in the background when the last one started a day or more ago (or never). The
   * start time is saved first, so a failing sweep waits a day too; failures are only logged. Returns the
   * running sweep, or undefined when none was due.
   */
  function sweepIfDue(): Promise<void> | undefined {
    if (sweeping) return undefined;
    const now = ctx.now();
    const last = Date.parse(readServerState(ctx.stateDir).lastSweepAt ?? '');
    if (Number.isFinite(last) && now.getTime() - last < SWEEP_INTERVAL_MS && last <= now.getTime()) return undefined;
    try {
      updateServerState(ctx.stateDir, { lastSweepAt: now.toISOString() });
    } catch (e) {
      ctx.log(`sweep: can't record the run, skipping it: ${err(e)}`);
      return undefined;
    }
    ctx.log('sweep: deleting expired context and artifact assets');
    const p = sweep({ repo, trust: ctx.trust, now, log: (line) => ctx.log(`sweep: ${line}`), ...(ctx.releases ? { releases: ctx.releases } : {}) })
      .then((r) => ctx.log(`sweep: deleted ${r.deleted.length}, kept ${r.kept.length}${r.failed.length ? `, failed ${r.failed.length}` : ''}`))
      .catch((e) => ctx.log(`sweep failed: ${err(e)}`))
      .finally(() => { sweeping = undefined; });
    sweeping = p;
    return p;
  }

  /** Resolves when nothing is in flight. */
  async function idle(): Promise<void> {
    while (inflight.size) await Promise.all([...inflight.values()]);
  }

  /** Whether any held job still needs the server (for `--once`): set-up, running or delivering. */
  function busy(): boolean {
    if (inflight.size) return true;
    return held().some((w) => w.state.phase !== 'ready' || (w.state.job !== undefined &&
      (['running', 'stopping', 'delivering', 'failing', 'checkpointing'].includes(w.state.job.status) || (w.state.job.status === 'ready' && !opts.manual))));
  }

  /**
   * Runs ticks until `signal` aborts. With `once`, runs one full tick, then only watches (every `watchMs`)
   * until no job needs it any more. A `once` poll that finds no candidates polls again every `oncePollMs`
   * for up to `onceWaitMs`: GitHub's issue list lags a request filed seconds ago.
   */
  async function run(o: { once?: boolean; signal?: AbortSignal; tickMs?: number; watchMs?: number; onceWaitMs?: number; oncePollMs?: number } = {}): Promise<void> {
    const tickMs = o.tickMs ?? ctx.config.tick_seconds * 1000;
    ctx.log(`air serve on ${ctx.host}: ${repo}, ${opts.manual ? 'manual' : 'auto'} start, max ${ctx.config.max_jobs} job(s), tick ${tickMs / 1000} s`);
    let found = await tick();
    if (o.once) {
      const waitMs = o.onceWaitMs ?? ONCE_WAIT_MS;
      const pollMs = Math.max(1, Math.min(o.oncePollMs ?? ONCE_POLL_MS, waitMs));
      const end = Date.now() + waitMs;
      while (found === 0 && !busy() && !o.signal?.aborted) {
        const left = end - Date.now();
        if (left <= 0) {
          ctx.log(`--once: no open requests to claim after waiting ${waitMs / 1000} s; exiting`);
          break;
        }
        ctx.log(`--once: no open requests to claim yet; polling again in ${Math.min(pollMs, left) / 1000} s (${Math.ceil(left / 1000)} s left)`);
        await sleep(Math.min(pollMs, left), undefined, { signal: o.signal }).catch(() => {});
        if (o.signal?.aborted) break;
        found = await tick();
      }
      while (!o.signal?.aborted && busy()) {
        await sleep(o.watchMs ?? 2000, undefined, { signal: o.signal }).catch(() => {});
        await idle();
        await tick({ poll: false });
      }
      await idle();
      return;
    }
    // Housekeeping only for a long-running server: a `--once` run never sweeps.
    sweepIfDue();
    while (!o.signal?.aborted) {
      await sleep(tickMs, undefined, { signal: o.signal }).catch(() => {});
      if (o.signal?.aborted) break;
      await tick();
      sweepIfDue();
    }
    await idle();
    await sweeping;
  }

  return { tick, idle, run, busy, inflight, sweepIfDue };
}

export type Server = ReturnType<typeof createServer>;
