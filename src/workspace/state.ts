// Workspace layout and `state.json`. Each claim gets a fresh directory
// `<workspace_root>/<owner>__<name>/<issue>-<nonce>/` holding the spec's layout (spec/v0.md §5) plus
// `state.json` and `setup.log`, so a restarted `air serve` can find and re-adopt its work.
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkRepo } from '../gh/issues.ts';
import type { Subscription } from '../usage/types.ts';

export const STATE_FILE = 'state.json';
export const LOG_FILE = 'setup.log';
export const REQUEST_FILE = 'request.md';
export const TASK_FILE = 'AIR_TASK.md';

/**
 * claimed: won the claim, body snapshotted. setting-up: setup started. ready: setup and check passed and
 * AIR_TASK.md is written. failed: setup failed and the claim was released. released: given back.
 * lost: another server holds the issue (found when setup re-checked the claim). done: delivered (`air:done`);
 * the claim is not released. While the agent runs, the phase stays `ready` and `job` tracks it.
 */
export type Phase = 'claimed' | 'setting-up' | 'ready' | 'failed' | 'released' | 'lost' | 'done';

/**
 * The agent's lifecycle once setup passed (`air serve`, `air run/stop/start`). ready: waiting for a start
 * (`--manual`). running: in its tmux window. stopping: being stopped by `air stop` or the server, so pane
 * death is not a finish. paused: stopped, claim and workspace kept. delivering: the agent finished and
 * the result is going back. done / failed / cancelled: over.
 */
export type JobStatus = 'ready' | 'running' | 'stopping' | 'paused' | 'delivering' | 'done' | 'failed' | 'cancelled';
export type PauseReason = 'operator' | 'quota' | 'restart';

export interface JobRecord {
  status: JobStatus;
  harness: 'claude' | 'codex';
  /** The local subscription it runs on, and the concrete model for the requested tier. */
  subscription: string;
  model: string;
  /** The matched cost in percent points of the subscription's primary window (match `costOf`). */
  expectedCost?: number;
  /** The agent's own session id, for `claude --resume` / `codex resume`. */
  sessionId?: string;
  /** `@air_nonce` of the job's tmux pane, so a different pane for the same issue is never adopted. */
  paneNonce?: string;
  /** Start of the current run; agent time before it is in `runMs`. */
  startedAt?: string;
  runMs: number;
  starts: number;
  pausedAt?: string;
  pauseReason?: PauseReason;
  /** A quota pause restarts at or after this time (the window's reset), if the claim still holds. */
  resumeAfter?: string;
  /** Usage reading of `subscription` when the job first started, for effort calibration. */
  usageBefore?: Subscription;
  /** Delivery steps already done, so a retried delivery doesn't repeat them. */
  delivery?: { branch?: string; prUrl?: string; assetUrl?: string; commented?: boolean };
  /** Last error from a delivery attempt that will be retried. */
  lastError?: string;
}

export interface State {
  version: 1;
  repo: string;
  issue: number;
  title: string;
  author: string;
  url: string;
  host: string;
  nonce: string;
  claimCommentId: number;
  phase: Phase;
  /** Failing step, when phase is `failed`. */
  failure?: string;
  job?: JobRecord;
  createdAt: string;
  updatedAt: string;
}

export function repoDir(root: string, repo: string): string {
  checkRepo(repo);
  return join(root, repo.replace('/', '__'));
}

export function workspaceDir(root: string, repo: string, issue: number, nonce: string): string {
  if (!Number.isSafeInteger(issue) || issue < 1) throw new Error(`bad issue number ${issue}`);
  if (!/^[A-Za-z0-9]{8,64}$/.test(nonce)) throw new Error(`bad nonce ${nonce}`);
  return join(repoDir(root, repo), `${issue}-${nonce}`);
}

/** Creates the workspace (it must not exist yet) with `out/` and the claimed body, and writes state.json. */
export function createWorkspace(root: string, state: State, body: string): string {
  const dir = workspaceDir(root, state.repo, state.issue, state.nonce);
  mkdirSync(repoDir(root, state.repo), { recursive: true, mode: 0o700 });
  mkdirSync(dir, { mode: 0o700 }); // throws EEXIST: a workspace is always fresh
  mkdirSync(join(dir, 'out'));
  writeFileSync(join(dir, REQUEST_FILE), body, { flag: 'wx' });
  writeState(dir, state);
  return dir;
}

export function writeState(dir: string, state: State): void {
  const tmp = join(dir, `.${STATE_FILE}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, join(dir, STATE_FILE));
}

export function readState(dir: string): State {
  const s = JSON.parse(readFileSync(join(dir, STATE_FILE), 'utf8')) as State;
  if (s.version !== 1) throw new Error(`${join(dir, STATE_FILE)}: unsupported state version ${String(s.version)}`);
  return s;
}

export function updateState(dir: string, patch: Partial<State>, now = new Date()): State {
  const s = { ...readState(dir), ...patch, updatedAt: now.toISOString() };
  writeState(dir, s);
  return s;
}

/** Every workspace for `issue` with a readable state.json, newest first. */
export function findWorkspaces(root: string, repo: string, issue: number): { dir: string; state: State }[] {
  let names: string[];
  try {
    names = readdirSync(repoDir(root, repo));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const out: { dir: string; state: State }[] = [];
  for (const name of names) {
    if (!name.startsWith(`${issue}-`)) continue;
    const dir = join(repoDir(root, repo), name);
    try {
      const state = readState(dir);
      if (state.issue === issue && state.repo === repo) out.push({ dir, state });
    } catch {
      // not a workspace, or a half-written one
    }
  }
  return out.sort((a, b) => b.state.createdAt.localeCompare(a.state.createdAt));
}

/** Every workspace of `repo` with a readable state.json. */
export function allWorkspaces(root: string, repo: string): { dir: string; state: State }[] {
  let names: string[];
  try {
    names = readdirSync(repoDir(root, repo));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const out: { dir: string; state: State }[] = [];
  for (const name of names) {
    if (!/^\d+-[A-Za-z0-9]+$/.test(name)) continue;
    const dir = join(repoDir(root, repo), name);
    try {
      const state = readState(dir);
      if (state.repo === repo) out.push({ dir, state });
    } catch {
      // not a workspace, or a half-written one
    }
  }
  return out.sort((a, b) => a.state.createdAt.localeCompare(b.state.createdAt));
}

/** The newest workspace whose claim is still ours (claimed, setting up or ready). */
export function activeWorkspace(root: string, repo: string, issue: number): { dir: string; state: State } | undefined {
  return findWorkspaces(root, repo, issue).find((w) => ['claimed', 'setting-up', 'ready'].includes(w.state.phase));
}
