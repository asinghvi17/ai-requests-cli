// `air serve`: a code-driven loop. Each tick it watches the jobs it holds (finish, timeout, quota, cancel,
// long pauses, restarts), then, unless paused, polls the requests repo, matches open requests against the
// local quota and claims the best fit, sets it up and starts its agent. Everything slow (claim wait, setup,
// delivery) is tracked per issue, so one bad issue or one failing gh call only costs a log line.
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { claim, claimable, deadlineTime, release } from '../claim/claim.ts';
import { canTakeMore, choose, primaryWindow } from '../match/match.ts';
import { fenced } from '../claim/text.ts';
import { lint } from '../spec/lint.ts';
import type { Subscription } from '../usage/types.ts';
import { setup } from '../workspace/setup.ts';
import { allWorkspaces, readState, updateState, type JobRecord, type State } from '../workspace/state.ts';
import { matchConfig, type ServeContext } from './context.ts';
import {
  agentMs, cancelJob, claimHolds, exitDetail, expirePause, failJob, finishJob, isDone, jobFromChoice, moveLabel, paneTail, PAUSE_LIMIT_MS,
  requestOf, saveJob, startAgent, stopAgent, type Workspace,
} from './jobs.ts';
import { readServerState } from './state.ts';

export interface ServerOptions {
  /** Wait for `air run` instead of starting agents. */
  manual?: boolean;
}

const HELD_PHASES = ['claimed', 'setting-up', 'ready'];
const STOPPING_LIMIT_MS = 5 * 60_000;

/** Whether `sub` has run out: an all-model window (or the window scoped to `model`) at 100%. */
export function exhausted(sub: Subscription | undefined, model: string): { resetsAt?: string } | undefined {
  if (!sub || sub.stale || sub.incomplete) return undefined; // unknown is not exhausted
  const full = sub.windows.filter((w) => typeof w.usedPct === 'number' && w.usedPct >= 100 && (!w.scope || model.toLowerCase().includes(w.scope.toLowerCase())));
  if (!full.length) return undefined;
  const resets = full.map((w) => w.resetsAt).filter((r): r is string => !!r && !Number.isNaN(Date.parse(r))).sort();
  return resets.length ? { resetsAt: resets.at(-1)! } : {};
}

/** Usage with the expected cost still to come of jobs we hold added on, so a tick never over-commits. */
export function committedUsage(usage: Subscription[], held: Workspace[]): Subscription[] {
  const extra = new Map<string, number>();
  for (const { state } of held) {
    const job = state.job;
    if (!job || ['done', 'failed', 'cancelled'].includes(job.status)) continue;
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
  let adopting = true;

  const err = (e: unknown) => (e instanceof Error ? e.message : String(e));

  function track(n: number, what: string, p: Promise<void>): void {
    const t = p.catch((e) => ctx.log(`#${n}: ${what} failed: ${err(e)}`)).finally(() => {
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
    const r = await setup({
      gh: ctx.gh, issue: n, root: ctx.root, host: ctx.host, ghHost: ctx.ghHost, env: ctx.env, trust: ctx.trust, now: ctx.now,
      ...(ctx.download ? { download: ctx.download } : {}), ...(ctx.setupTimeoutMs ? { timeoutMs: ctx.setupTimeoutMs } : {}),
    });
    if (r.status === 'failed') return ctx.log(`#${n}: setup failed at ${r.step}: ${r.message}`);
    if (r.status === 'refused') return ctx.log(`#${n}: setup refused: ${r.message}`);
    if (opts.manual) return ctx.log(`#${n}: set up; start it with \`air run ${n}\``);
    await startAgent(ctx, dir);
  }

  /** One held workspace: whatever its state calls for this tick. */
  async function watch(ws: Workspace, jobs: Awaited<ReturnType<ServeContext['tmux']['listJobs']>>, usage: Subscription[], first: boolean): Promise<void> {
    const { dir, state } = ws;
    const n = state.issue;
    if (state.phase === 'claimed') return track(n, 'setup', prepare(dir));
    if (state.phase === 'setting-up') {
      // Only a server that died mid-setup leaves this behind (setups in progress are in `inflight`).
      if (!first) return;
      await release({ gh: ctx.gh, issue: n, root: ctx.root, host: state.host, trust: ctx.trust, now: ctx.now, nonce: state.nonce,
        failure: { step: 'setup', detail: 'The server restarted while setting up this request.' } });
      return;
    }
    const job = state.job;
    if (!job) return; // set up by `air setup` by hand: `air run` gives it a job
    if (['done', 'failed', 'cancelled'].includes(job.status)) return;
    if (job.status === 'delivering') return track(n, 'delivery', finishJob(ctx, dir));

    // The requester can call it off at any time before delivery.
    const issue = await ctx.gh.issue(n);
    if (issue.state !== 'open' || issue.labels.includes('air:cancel')) {
      return track(n, 'cancel', cancelJob(ctx, dir, issue.state !== 'open' ? 'the issue was closed' : 'the requester added `air:cancel`'));
    }

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
        await moveLabel(ctx, n, 'air:paused');
      }
      return;
    }
    if (job.status === 'paused') return watchPaused(dir, state, job, usage, now);

    // running
    const pane = jobs.find((j) => j.issue === n && j.nonce === job.paneNonce);
    if (isDone(dir)) {
      if (pane && !pane.dead) await ctx.tmux.stopJob(n, { graceMs: ctx.stopGraceMs });
      else if (pane) await ctx.tmux.stopJob(n, { graceMs: 0 });
      return track(n, 'delivery', finishJob(ctx, dir));
    }
    if (!pane) {
      if (first) {
        // The window is gone (a reboot, or tmux died) while we were down: resume the agent.
        ctx.log(`#${n}: its window is gone after a restart; resuming`);
        saveJob(ctx, dir, { status: 'paused', runMs: job.runMs, startedAt: undefined, pausedAt: now.toISOString(), pauseReason: 'restart' });
        return track(n, 'restart', startAgent(ctx, dir));
      }
      ctx.log(`#${n}: its window was closed; paused (\`air start ${n}\` resumes it)`);
      saveJob(ctx, dir, { status: 'paused', runMs: agentMs(job, now), startedAt: undefined, pausedAt: now.toISOString(), pauseReason: 'operator' });
      await moveLabel(ctx, n, 'air:paused');
      return;
    }
    if (first) ctx.log(`#${n}: re-adopted its running agent (${pane.windowId})`);
    if (pane.dead) {
      if (pane.exitStatus === 0) {
        await ctx.tmux.stopJob(n, { graceMs: 0 });
        return track(n, 'delivery', finishJob(ctx, dir));
      }
      const text = await paneTail(ctx, n);
      return track(n, 'failure', failJob(ctx, dir, 'the agent', exitDetail(pane.exitStatus, text)));
    }
    const request = requestOf(dir);
    if (agentMs(job, now) > request.timeoutMinutes * 60_000) {
      const text = await paneTail(ctx, n);
      return track(n, 'timeout', failJob(ctx, dir, 'the timeout',
        `The agent ran past the request's \`timeout\` of ${request.timeoutMinutes} min and was stopped.${text.trim() ? `\n\nLast lines of its window:\n\n${fenced(text)}` : ''}`));
    }
    const out = exhausted(usage.find((s) => s.name === job.subscription), job.model);
    if (out) {
      ctx.log(`#${n}: subscription ${job.subscription} is out of quota; stopping until ${out.resetsAt ?? 'it recovers'}`);
      return track(n, 'quota stop', stopAgent(ctx, dir, 'quota', out.resetsAt).then(() => {}));
    }
  }

  async function watchPaused(dir: string, state: State, job: JobRecord, usage: Subscription[], now: Date): Promise<void> {
    const n = state.issue;
    if (job.pausedAt && now.getTime() - Date.parse(job.pausedAt) > PAUSE_LIMIT_MS) return track(n, 'release', expirePause(ctx, dir));
    if (job.pauseReason === 'restart') {
      if (await claimHolds(ctx, state)) return track(n, 'restart', startAgent(ctx, dir));
      return;
    }
    if (job.pauseReason !== 'quota') return;
    if (job.resumeAfter && now.getTime() < Date.parse(job.resumeAfter)) return;
    let sub = usage.find((s) => s.name === job.subscription);
    if (job.resumeAfter) sub = (await ctx.usage({ refresh: true })).find((s) => s.name === job.subscription);
    if (!sub || sub.stale || exhausted(sub, job.model)) return;
    if (!(await claimHolds(ctx, state))) {
      updateState(dir, { phase: 'lost' }, now);
      return ctx.log(`#${n}: the claim no longer holds; not restarting`);
    }
    ctx.log(`#${n}: quota is back; restarting`);
    track(n, 'restart', startAgent(ctx, dir));
  }

  /** Poll, match, claim. */
  async function poll(usage: Subscription[], mine: Workspace[]): Promise<void> {
    let active = mine.filter((w) => !['done', 'failed', 'cancelled'].includes(w.state.job?.status ?? '')).length;
    for (const n of inflight.keys()) if (!mine.some((w) => w.state.issue === n)) active++;
    if (!canTakeMore(active, ctx.config.max_jobs)) return;
    const ours = new Set(mine.map((w) => w.state.issue));
    let free = committedUsage(usage, mine);
    const issues = await ctx.api.openRequests();
    for (const issue of issues) {
      const n = issue.number;
      if (ours.has(n) || inflight.has(n)) continue;
      if (!claimable(issue).ok || issue.assignees.length > 0) continue;
      const hash = bodyHash(issue.body);
      if (skip.get(n) === hash) continue;
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
      const choice = choose({ effort: request.effort, harness: request.harness, model: request.model }, free, matchConfig(ctx.config), ctx.now());
      if ('none' in choice) {
        const why = choice.reasons.join('; ') || 'no subscriptions';
        if (noFit.get(n) !== why) ctx.log(`#${n}: no fit: ${why}`);
        noFit.set(n, why);
        continue;
      }
      noFit.delete(n);
      ctx.log(`#${n}: fits ${choice.reason}; claiming`);
      const r = await claim({ gh: ctx.gh, issue: n, root: ctx.root, host: ctx.host, trust: ctx.trust, now: ctx.now, ...(ctx.claimWaitMs !== undefined ? { waitMs: ctx.claimWaitMs } : {}) });
      if (r.status === 'lost') {
        ctx.log(`#${n}: lost the claim to ${r.holder}`);
        continue;
      }
      if (r.status === 'refused') {
        ctx.log(`#${n}: not claimed: ${r.message.split('\n')[0]}`);
        if (r.reason !== 'held') skip.set(n, hash);
        continue;
      }
      updateState(r.dir, { job: jobFromChoice(ctx, choice) }, ctx.now());
      ctx.log(`#${n}: claimed (nonce ${r.state.nonce}) for ${choice.subscription.name}/${choice.model}`);
      track(n, 'setup', prepare(r.dir));
      free = free.map((s) => (s.name === choice.subscription.name ? addUsage(s, choice.cost) : s));
      if (!canTakeMore(++active, ctx.config.max_jobs)) return;
    }
  }

  /** One tick. Never throws: every failure is logged and the next tick tries again. */
  async function tick(o: { poll?: boolean } = {}): Promise<void> {
    const first = adopting;
    adopting = false;
    try {
      let usage: Subscription[] = [];
      try {
        usage = await ctx.usage();
      } catch (e) {
        ctx.log(`usage read failed: ${err(e)}`);
      }
      const jobs = await ctx.tmux.listJobs();
      const mine = held();
      for (const ws of mine) {
        if (inflight.has(ws.state.issue)) continue;
        try {
          await watch(ws, jobs, usage, first);
        } catch (e) {
          ctx.log(`#${ws.state.issue}: ${err(e)}`);
        }
      }
      if (o.poll === false || readServerState(ctx.stateDir).paused) return;
      await poll(usage, held());
    } catch (e) {
      ctx.log(`tick failed: ${err(e)}`);
    }
  }

  /** Resolves when nothing is in flight. */
  async function idle(): Promise<void> {
    while (inflight.size) await Promise.all([...inflight.values()]);
  }

  /** Whether any held job still needs the server (for `--once`): set-up, running or delivering. */
  function busy(): boolean {
    if (inflight.size) return true;
    return held().some((w) => w.state.phase !== 'ready' || (w.state.job !== undefined &&
      (['running', 'stopping', 'delivering'].includes(w.state.job.status) || (w.state.job.status === 'ready' && !opts.manual))));
  }

  /**
   * Runs ticks until `signal` aborts. With `once`, runs one full tick, then only watches (every `watchMs`)
   * until no job needs it any more.
   */
  async function run(o: { once?: boolean; signal?: AbortSignal; tickMs?: number; watchMs?: number } = {}): Promise<void> {
    const tickMs = o.tickMs ?? ctx.config.tick_seconds * 1000;
    ctx.log(`air serve on ${ctx.host}: ${repo}, ${opts.manual ? 'manual' : 'auto'} start, max ${ctx.config.max_jobs} job(s), tick ${tickMs / 1000} s`);
    await tick();
    if (o.once) {
      while (!o.signal?.aborted && busy()) {
        await sleep(o.watchMs ?? 2000, undefined, { signal: o.signal }).catch(() => {});
        await idle();
        await tick({ poll: false });
      }
      await idle();
      return;
    }
    while (!o.signal?.aborted) {
      await sleep(tickMs, undefined, { signal: o.signal }).catch(() => {});
      if (o.signal?.aborted) break;
      await tick();
    }
    await idle();
  }

  return { tick, idle, run, busy, inflight };
}

export type Server = ReturnType<typeof createServer>;
