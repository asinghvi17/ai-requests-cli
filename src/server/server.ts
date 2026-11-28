// `air serve`: a code-driven loop. Each tick it watches the jobs it holds (finish, timeout, quota, cancel,
// long pauses, restarts), then, unless paused, polls the requests repo, matches open requests against the
// local quota and claims the best fit, sets it up and starts its agent. Everything slow (claim wait, setup,
// delivery) is tracked per issue, so one bad issue or one failing gh call only costs a log line.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { backOff, claim, claimable, deadlineTime, release } from './claim.ts';
import { code, currentClaim, fenced, LABELS, lint, markedComments, sweep } from '../request/index.ts';
import { canTakeMore, choose, EFFORT_USD, primaryWindow, windowSize, type Effort, type MatchConfig, type Short } from './match.ts';
import { setup } from './workspace-setup.ts';
import { allWorkspaces, ENDED, isEnded, readState, updateState, type JobRecord, type State } from './workspace-state.ts';
import { matchConfig, type ServeContext } from './context.ts';
import {
  agentMs, cancelJob, jobSpent, claimHolds, ClaimLost, exitDetail, expirePause, failJob, finishJob, isDone, jobFromChoice, loseJob, moveLabel, paneTail, partialJob,
  PAUSE_LIMIT_MS, QUOTA_WAIT_MS, requestOf, saveJob, sendTask, startAgent, startOrDeliver, stopAgent, vanished, type Workspace,
} from './jobs.ts';
import { readServerState, updateServerState } from './state.ts';
import { tidy } from './tidy.ts';
import { configPath, parseConfig, type Config } from '../setup/index.ts';
import {
  configFile as subscriptionsFile, matchPrompt, MAX_WAITING_COMMENTS, SETTLE_MS, STUCK_MS, usd, waitingFor, type Subscription,
} from '../agents/index.ts';

export interface ServerOptions {
  /** Wait for `air run` instead of starting agents. */
  manual?: boolean;
}

/** `run`'s options: see `run`. */
export interface RunOptions {
  once?: boolean; signal?: AbortSignal; tickMs?: number; watchMs?: number; onceWaitMs?: number; oncePollMs?: number; oncePollTries?: number; onceRetryMs?: number;
}

const HELD_PHASES = ['claiming', 'claimed', 'setting-up', 'ready'];
/** A `claiming` workspace this old was left by a claim that died (`claim()` takes seconds). */
export const CLAIM_STALE_MS = 10 * 60_000;
/** After a claim attempt throws (GitHub refused a step, an outage), the issue is left alone this long. */
export const CLAIM_RETRY_MS = 60 * 60_000;
/**
 * `--once`, list lag: GitHub's issue list can miss a request filed seconds ago, so a poll that finds no
 * candidates polls again every ONCE_POLL_MS for up to ONCE_WAIT_MS before giving up.
 */
export const ONCE_WAIT_MS = 60_000;
export const ONCE_POLL_MS = 10_000;
/**
 * `--once`, errors: a poll that fails (a network error, a 5xx from gh) is tried ONCE_POLL_TRIES times in all,
 * ONCE_RETRY_MS apart and doubling, before `air serve --once` fails.
 */
export const ONCE_POLL_TRIES = 3;
export const ONCE_RETRY_MS = 2_000;
/** `tick()`'s result when its poll threw. */
export const POLL_FAILED = 'poll-failed';
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
 * Whether a job costs more than twice its effort (spec §11 rule 4): `spent` is what it has cost so far at API
 * prices, from its agent's records (`jobSpent`). Undefined when it doesn't, or when that can't be measured.
 */
export function overEffort(spent: number | undefined, effort: Effort): { usd: number; cap: number } | undefined {
  const cap = 2 * EFFORT_USD[effort];
  return spent !== undefined && spent > cap ? { usd: spent, cap } : undefined;
}

/**
 * Usage with what jobs we hold are still to spend added on, so a tick never over-commits. `spent` is what a job
 * has cost so far. A readable meter already shows that, so the rest of the expected cost is added; a manual
 * ledger is charged only when the job ends, so the whole of its expected or actual cost, whichever is more.
 */
export function committedUsage(usage: Subscription[], held: Workspace[], config: MatchConfig, spent: (w: Workspace) => number): Subscription[] {
  const extra = new Map<string, number>();
  for (const w of held) {
    const job = w.state.job;
    if (!job || ENDED.includes(job.status)) continue;
    const sub = usage.find((s) => s.name === job.subscription);
    const cost = job.expectedCost ?? 0;
    const so = spent(w);
    extra.set(job.subscription, (extra.get(job.subscription) ?? 0) + (sub?.harness === 'manual' ? Math.max(cost, so) : Math.max(0, cost - so)));
  }
  return usage.map((s) => addUsage(s, extra.get(s.name) ?? 0, config));
}

/** `s` with `usd` more used of its primary window. */
function addUsage(s: Subscription, usd: number, config: MatchConfig): Subscription {
  const size = windowSize(s, config);
  if (!usd || !size) return s;
  const primary = primaryWindow(s);
  return { ...s, windows: s.windows.map((w) => (w === primary && typeof w.usedPct === 'number' ? { ...w, usedPct: w.usedPct + (usd / size) * 100 } : w)) };
}

const bodyHash = (body: string) => createHash('sha256').update(body).digest('hex').slice(0, 16);

/** A request a poll left unclaimed only because its subscriptions' budgets are short (`NoChoice.short`). */
export interface BudgetWait { issue: number; effort: string; short: Short[] }

/** Each subscription short of budget for `waits`, with the first request it turns down. */
function shortSubscriptions(waits: BudgetWait[]): { issue: number; s: Short }[] {
  const seen = new Map<string, { issue: number; s: Short }>();
  for (const w of waits) for (const s of w.short) if (!seen.has(s.subscription)) seen.set(s.subscription, { issue: w.issue, s });
  return [...seen.values()];
}

/**
 * Which subscriptions `budgetNote` names for `waits`, and the key it says to change for each: a new episode
 * starts when this changes.
 */
export function budgetKeys(waits: BudgetWait[]): string {
  return shortSubscriptions(waits).map(({ s }) => `${s.subscription}: ${s.fitsAt === undefined ? 'reserve' : s.manual ? 'budget.usd' : 'window_usd'}`).join(', ');
}

/**
 * What `air serve` logs when the requests it could take all wait on budget: the first one, what each
 * subscription short of budget lacks for the first request it turns down, and the config keys and files that
 * change that. `config` and `subscriptions` are the paths of config.toml and subscriptions.json.
 */
export function budgetNote(waits: BudgetWait[], config: Config, files: { config: string; subscriptions: string }): string {
  const [first] = waits;
  if (!first) return '';
  const more = waits.length > 1 ? ` and ${waits.length - 1} more` : '';
  const head = `budget: #${first.issue} (effort ${first.effort}, ${usd(first.short[0]!.cost)})${more} can't be taken only because of budget or reserve, so this server takes no work.`;
  const subs = shortSubscriptions(waits).map(({ issue, s }) => {
    const key = `subscriptions.${s.subscription}`;
    const reserve = `${key}.reserve (now ${config.subscriptions[s.subscription]?.reserve})`;
    const state = `${s.subscription}: ${usd(s.left)} of its ${usd(s.size)} window left, ${usd(s.reserve)} of that kept as reserve, and #${issue} costs ${usd(s.cost)}.`;
    if (s.fitsAt === undefined) return `${state} The window is used past its reserve: lower ${reserve} in ${files.config}, or wait for the window to reset.`;
    const fits = `${usd(Math.ceil(s.fitsAt * 100) / 100)} or more takes #${issue}`;
    return s.manual
      ? `${state} Raise its budget.usd in ${files.subscriptions} (${fits}; read at start, so restart air serve), or lower ${reserve} in ${files.config}.`
      : `${state} Raise ${key}.window_usd (now ${s.size}: what the whole window is worth at API prices; ${fits}) or lower ${reserve} in ${files.config}.`;
  });
  return [head, ...subs, 'air serve rereads config.toml every tick.'].join(' ');
}

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
  /** The status-bar notice while every request this server could take waits on budget (`budgetNote`). */
  let budget: string | undefined;
  /** `budgetKeys` of the budget notice last logged, while that state lasts. */
  let budgetShort: string | undefined;

  const err = (e: unknown) => (e instanceof Error ? e.message : String(e));

  /** config.toml's text as last applied (at startup: as the config in use was read), and the problem last logged. */
  let configText: string | undefined;
  try {
    if (ctx.configFile !== undefined) configText = readFileSync(ctx.configFile, 'utf8');
  } catch {
    // the first tick reads it again, and says why it can't
  }
  let configProblem: string | undefined;

  /**
   * Rereads config.toml every tick, so an edit (window_usd, say) takes effect without a restart. A file that
   * can't be read or doesn't parse leaves the last good config in place, and is logged once until it changes.
   * workspace_root keeps its startup value: it changes with a restart.
   */
  function reloadConfig(): void {
    const file = ctx.configFile;
    if (file === undefined) return;
    let text: string, next: Config;
    try {
      text = readFileSync(file, 'utf8');
      if (text === configText) {
        configProblem = undefined;
        return;
      }
      next = parseConfig(text);
    } catch (e) {
      const problem = `${file}: ${err(e)}`;
      if (problem !== configProblem) ctx.log(`config: ${problem}; keeping the config in use`);
      configProblem = problem;
      return;
    }
    configText = text;
    configProblem = undefined;
    if (next.workspace_root !== ctx.config.workspace_root) ctx.log(`config: workspace_root changes to ${next.workspace_root} when air serve restarts`);
    ctx.config = { ...next, workspace_root: ctx.config.workspace_root };
    ctx.log(`config: reloaded ${file}`);
  }

  function track(n: number, what: string, p: Promise<unknown>): void {
    const t = p.then(() => {}, (e) => ctx.log(e instanceof ClaimLost ? `#${n}: ${what} skipped: ${err(e)}` : `#${n}: ${what} failed: ${err(e)}`)).finally(() => {
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
    const spent = jobSpent(ctx, dir, job);
    const over = overEffort(spent?.usd, request.effort as Effort);
    if (over) {
      return track(n, 'effort cap', partialJob(ctx, dir, {
        why: `it has cost ${usd(over.usd)} at API prices, more than twice the ${usd(over.cap / 2)} that effort ${request.effort} stands for.`,
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
    // A fresh start whose agent was not ready for its task in time (a prompt was in the way, say) gets it now;
    // not while the start (an `air start` in another shell, say) may still be waiting to send it itself.
    if (job.taskPending && now.getTime() - Date.parse(job.startedAt ?? '') > ctx.agentReadyMs) {
      track(n, 'task', sendTask(ctx, dir, 0).then(() => {}));
    }
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

  /**
   * No job keeps its window once air is through with it, whoever ended it (`air release` in another shell,
   * say). Driven by the tagged panes (the tick's `jobs`): a pane is closed when the workspace that recorded it
   * has ended, or when no workspace records it and none holds its issue (its workspace is gone). A pane no
   * workspace records yet while its issue is held is a start in progress, and stays. A job left `running` in
   * an ended workspace is cancelled.
   */
  async function closeEnded(jobs: Awaited<ReturnType<ServeContext['tmux']['listJobs']>>): Promise<void> {
    if (!jobs.length) return;
    const all = allWorkspaces(ctx.root, repo);
    for (const pane of jobs) {
      if (inflight.has(pane.issue)) continue;
      const w = all.find((x) => x.state.issue === pane.issue && x.state.job?.paneNonce === pane.nonce);
      if (w ? !isEnded(w.state) : all.some((x) => x.state.issue === pane.issue && !isEnded(x.state))) continue;
      if (!(await ctx.tmux.stopJob(pane.issue, { graceMs: ctx.stopGraceMs }))) continue;
      const job = w?.state.job;
      ctx.log(`#${pane.issue}: closed window ${pane.windowId}: ${w ? `its job is over (${w.state.phase}/${job!.status})` : 'no workspace on this machine holds its job'}`);
      if (w && !ENDED.includes(job!.status)) saveJob(ctx, w.dir, { status: 'cancelled', runMs: agentMs(job!, ctx.now()), startedAt: undefined });
    }
  }

  /** Puts the budget notice and the waiting jobs' notices in the tmux status bar, or clears it; only when that changes. */
  async function showNotices(running: Set<number>): Promise<void> {
    for (const n of [...screens.keys()]) if (!running.has(n)) screens.delete(n);
    for (const n of [...notices.keys()]) if (!running.has(n)) notices.delete(n);
    const all = [...(budget ? [budget] : []), ...notices.values()];
    const text = all.length ? all.join(' | ') : undefined;
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
    if (job.pauseReason === 'restart' || job.pauseReason === 'exit') return track(n, 'restart', startOrDeliver(ctx, dir));
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
    track(n, 'restart', startOrDeliver(ctx, dir));
  }

  /** Poll, match, claim. Returns how many open requests were candidates (unclaimed, not ours), if it polled. */
  async function poll(usage: Subscription[], mine: Workspace[]): Promise<number | undefined> {
    let active = mine.filter((w) => !ENDED.includes(w.state.job?.status ?? 'ready')).length;
    for (const n of inflight.keys()) if (!mine.some((w) => w.state.issue === n)) active++;
    if (!canTakeMore(active, ctx.config.max_jobs)) {
      noteBudget([]);
      return undefined;
    }
    const ours = new Set(mine.map((w) => w.state.issue));
    const config = matchConfig(ctx.config);
    let free = committedUsage(usage, mine, config, (w) => jobSpent(ctx, w.dir, w.state.job!)?.usd ?? 0);
    const issues = await ctx.api.openRequests();
    let candidates = 0, took = 0;
    const waits: BudgetWait[] = [];
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
        if (choice.short.length) waits.push({ issue: n, effort: request.effort, short: choice.short });
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
      free = free.map((s) => (s.name === choice.subscription.name ? addUsage(s, choice.cost, config) : s));
      took++;
      if (!canTakeMore(++active, ctx.config.max_jobs)) break;
    }
    noteBudget(took ? [] : waits);
    return candidates;
  }

  /**
   * Logs `budgetNote` when the requests this server could take start to wait only on budget (at startup, or
   * whenever that begins again, or when the subscriptions short of budget, or what to change for one, change),
   * and keeps a notice in the tmux status bar while they do. Not every tick.
   */
  function noteBudget(waits: BudgetWait[]): void {
    if (!waits.length) {
      budget = budgetShort = undefined;
      return;
    }
    const file = ctx.configFile ?? configPath();
    const keys = budgetKeys(waits);
    if (keys !== budgetShort) ctx.log(budgetNote(waits, ctx.config, { config: file, subscriptions: subscriptionsFile() }));
    budgetShort = keys;
    budget = `air takes no work: requests wait on budget; raise window_usd in ${file} (see the serve log)`;
  }

  /**
   * One tick. Never throws: every failure is logged and the next tick tries again. Returns the number of
   * candidate requests its poll saw, POLL_FAILED when the poll threw, or undefined when it did not poll (or
   * the tick failed before it).
   */
  async function tick(o: { poll?: boolean } = {}): Promise<number | typeof POLL_FAILED | undefined> {
    try {
      reloadConfig();
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
        // (A delivery in flight when the list was read may have removed its workspace since.)
        if (inflight.has(ws.state.issue) || !existsSync(ws.dir)) continue;
        try {
          await watch(ws, jobs, usage, first);
        } catch (e) {
          if (!vanished(e, ws.dir)) ctx.log(`#${ws.state.issue}: ${err(e)}`); // (gone: another process delivered it)
        }
      }
      try {
        await closeEnded(jobs);
      } catch (e) {
        ctx.log(`tmux: ${err(e)}`);
      }
      let polled: number | typeof POLL_FAILED | undefined;
      if (o.poll === false || readServerState(ctx.stateDir).paused) noteBudget([]);
      else {
        try {
          polled = await poll(usage, held());
        } catch (e) {
          ctx.log(`poll failed: ${err(e)}`);
          polled = POLL_FAILED;
        }
      }
      try {
        await showNotices(new Set(held().filter((w) => w.state.job?.status === 'running').map((w) => w.state.issue)));
      } catch (e) {
        ctx.log(`tmux status: ${err(e)}`);
      }
      return polled;
    } catch (e) {
      ctx.log(`tick failed: ${err(e)}`);
      return undefined;
    }
  }

  let sweeping: Promise<void> | undefined;
  /**
   * Starts the daily sweep in the background when the last one started a day or more ago (or never): first
   * the local cleanup pass (`tidy`: ended workspaces past their keep, stale locks, temp files, launcher
   * dirs), then `air sweep` of the release assets. The start time is saved first, so a failing sweep waits a
   * day too; failures are only logged. Returns the running sweep, or undefined when none was due.
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
    const cleanup = async () => {
      let panes;
      try {
        panes = await ctx.tmux.panes();
      } catch (e) {
        ctx.log(`cleanup: tmux: ${err(e)}; launcher dirs are left for the next pass`);
      }
      const l = tidy({ root: ctx.root, repo, stateDir: ctx.stateDir, now, panes, log: (line) => ctx.log(`cleanup: ${line}`) });
      ctx.log(`cleanup: removed ${l.removed}${l.failed ? `, failed ${l.failed}` : ''}, kept ${l.kept} ended workspace(s) for debugging`);
    };
    const p = cleanup()
      .catch((e) => ctx.log(`cleanup failed: ${err(e)}`))
      .then(() => {
        ctx.log('sweep: deleting expired context and artifact assets');
        return sweep({ repo, trust: ctx.trust, now, log: (line) => ctx.log(`sweep: ${line}`), ...(ctx.releases ? { releases: ctx.releases } : {}) });
      })
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
   * for up to `onceWaitMs` (list lag, ONCE_WAIT_MS). A `once` poll that fails is tried `oncePollTries` times in
   * all, `onceRetryMs` apart and doubling; then the run fails. Its tmux status-bar notice goes with it.
   */
  async function run(o: RunOptions = {}): Promise<void> {
    try {
      await serve(o);
    } finally {
      budget = budgetShort = undefined;
      notices.clear();
      try {
        if (notice !== undefined) await ctx.tmux.setNotice(undefined);
        notice = undefined;
      } catch (e) {
        ctx.log(`tmux status: ${err(e)}`);
      }
    }
  }

  async function serve(o: RunOptions): Promise<void> {
    // (A function: config.toml may change tick_seconds while the server runs.)
    const tickMs = () => o.tickMs ?? ctx.config.tick_seconds * 1000;
    ctx.log(`air serve on ${ctx.host}: ${repo}, ${opts.manual ? 'manual' : 'auto'} start, max ${ctx.config.max_jobs} job(s), tick ${tickMs() / 1000} s`);
    // Every air label exists from the start, `air:cancel` included, so a requester can always add one.
    try {
      const created = await ctx.gh.ensureLabels(LABELS);
      if (created.length) ctx.log(`created labels ${created.join(', ')} on ${repo}`);
    } catch (e) {
      ctx.log(`labels: can't create the missing air labels on ${repo}: ${err(e)}`);
    }
    // `--once`: one tick whose poll is retried with backoff (ONCE_POLL_TRIES) when it fails.
    const onceTick = async () => {
      const tries = o.oncePollTries ?? ONCE_POLL_TRIES;
      for (let attempt = 1; ; attempt++) {
        const r = await tick();
        if (r !== POLL_FAILED || o.signal?.aborted) return r;
        if (attempt >= tries) {
          await idle();
          throw new Error(`--once: polling ${repo} for requests failed ${tries} times; giving up (the log has each error)`);
        }
        const ms = (o.onceRetryMs ?? ONCE_RETRY_MS) * 2 ** (attempt - 1);
        ctx.log(`--once: the poll failed; trying again in ${ms / 1000} s (attempt ${attempt + 1} of ${tries})`);
        await sleep(ms, undefined, { signal: o.signal }).catch(() => {});
        if (o.signal?.aborted) return undefined;
      }
    };
    let found = o.once ? await onceTick() : await tick();
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
        found = await onceTick();
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
      await sleep(tickMs(), undefined, { signal: o.signal }).catch(() => {});
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
