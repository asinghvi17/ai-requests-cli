// What air leaves on this machine after its jobs end, and its removal. A delivered job's workspace goes at
// once (`finishJob`). One that failed, was cancelled, released or lost stays KEEP_MS for debugging; the
// cleanup pass of `air serve`'s daily sweep (`tidy`) removes it then, along with stale lock files whose pid
// is dead, temp files of air processes that died, and launcher dirs no tmux pane uses. The pass touches only
// its own requests repo's workspaces: another server may serve another repo from the same workspace_root.
// `air status` without an issue lists the same things for every repo (`leftovers`). Nothing is removed
// outside workspace_root, air's state dir and its own `air-launch-*` dirs under tmpdir, and nothing through
// a symlink. A workspace whose job still has a process (a live delivery lock, or a tmux pane) is never removed.
import { lstatSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { alive } from '../lib/index.ts';
import { removeLauncher, staleLaunchers } from '../tmux/launcher.ts';
import type { ServerPane } from '../tmux/tmux.ts';
import { allWorkspaces, everyWorkspace, isEnded, STATE_FILE, type State } from '../workspace/state.ts';
import { removeTrash, removeWorkspace } from '../workspace/teardown.ts';
import { DELIVERY_LOCK } from './jobs.ts';
import { clearStaleLock, LOCK_FILE, LOCK_GRACE_MS, liveLock, staleLock } from './state.ts';

type Workspace = { dir: string; state: State };

/** How long the workspace of a job that ended without delivering is kept for debugging. */
export const KEEP_MS = 7 * 86_400_000;

export interface Leftovers {
  /** Workspaces whose claim this machine still holds. */
  held: Workspace[];
  /** Ended workspaces kept for debugging, and from when each is due. */
  kept: { ws: Workspace; until: Date }[];
  /** Ended workspaces the next pass removes: delivered ones at once, the others KEEP_MS after they ended. */
  due: Workspace[];
  /**
   * Ended workspaces left alone while their job still has a process: a live delivery lock (another process
   * finishing it), or a tmux pane of the job (closed by the server's next tick). Unknown panes count as one.
   */
  busy: Workspace[];
  /** Stale lock files (`staleLock`): the serve lock and workspaces' delivery locks. */
  locks: string[];
  /** Temp files in the state dir of air processes that died. */
  temp: string[];
  /** Launcher dirs left in tmpdir (`staleLaunchers`); not looked for when tmux couldn't be asked. */
  launchers: string[];
}

/**
 * The state dir's temp files, by what writes them: `.serve.json.<pid>.tmp` (updateServerState), a pidLock's
 * `.serve.lock.<pid>.<hex>` and its `.stale` (pidLock) and `<file>.<pid>.<hex>.tmp` (lib/lock.ts writeAtomic).
 * Each lives for milliseconds: one older than LOCK_GRACE_MS whose pid is not alive here is left over. (The age
 * also covers a state dir shared with another host, whose pids can't be judged here.)
 */
const TEMP = /^(?:\.serve\.json\.(\d+)\.tmp|\.serve\.lock\.(\d+)\.[0-9a-f]{12}(?:\.stale)?|[\w.-]+\.(\d+)\.[0-9a-f]{12}\.tmp)$/;

function staleTemp(stateDir: string, now: number): string[] {
  let names: string[];
  try {
    names = readdirSync(stateDir);
  } catch {
    return [];
  }
  return names.filter((n) => {
    const m = TEMP.exec(n);
    if (!m) return false;
    const pid = Number(m[1] ?? m[2] ?? m[3]);
    try {
      return pid !== process.pid && !alive(pid) && now - lstatSync(join(stateDir, n)).mtimeMs > LOCK_GRACE_MS;
    } catch {
      return false;
    }
  }).map((n) => join(stateDir, n));
}

/** When a workspace ended: its state's last write, or (an unreadable `updatedAt`) its state file's mtime, or now. */
function endedAt(ws: Workspace, now: Date): number {
  const t = Date.parse(ws.state.updatedAt);
  if (Number.isFinite(t)) return t;
  try {
    return statSync(join(ws.dir, STATE_FILE)).mtimeMs;
  } catch {
    return now.getTime();
  }
}

/**
 * What air has left on this machine (see the top of this file): `repo`'s workspaces, or with no `repo`
 * every repo's. `panes`: every pane on air's tmux server, if known. Never throws for a bad workspace.
 */
export function leftovers(o: { root: string; repo?: string; stateDir: string; now: Date; panes?: ServerPane[] }): Leftovers {
  const l: Leftovers = { held: [], kept: [], due: [], busy: [], locks: [], temp: staleTemp(o.stateDir, o.now.getTime()), launchers: [] };
  const serveLock = join(o.stateDir, LOCK_FILE);
  if (staleLock(serveLock)) l.locks.push(serveLock);
  for (const ws of o.repo ? allWorkspaces(o.root, o.repo) : everyWorkspace(o.root)) {
    const lock = join(ws.dir, DELIVERY_LOCK);
    if (staleLock(lock)) l.locks.push(lock);
    if (!isEnded(ws.state)) {
      l.held.push(ws);
      continue;
    }
    const nonce = ws.state.job?.paneNonce;
    const pane = nonce !== undefined && (!o.panes || o.panes.some((p) => p.issue === ws.state.issue && p.nonce === nonce));
    if (pane || liveLock(lock)) {
      l.busy.push(ws);
      continue;
    }
    const until = new Date(ws.state.phase === 'done' ? 0 : endedAt(ws, o.now) + KEEP_MS);
    if (until.getTime() <= o.now.getTime()) l.due.push(ws);
    else l.kept.push({ ws, until });
  }
  if (o.panes) l.launchers = staleLaunchers(new Set(o.panes.flatMap((p) => (p.launcher ? [p.launcher] : []))), o.now.getTime());
  return l;
}

/**
 * The cleanup pass for `repo`: removes what `leftovers` finds due, stale or left over, and workspaces a crash
 * left half removed, logging each. Never throws: a failure is logged and counted. Returns the counts, and how
 * many ended workspaces are kept.
 */
export function tidy(o: { root: string; repo: string; stateDir: string; now: Date; panes?: ServerPane[]; log: (line: string) => void }): { removed: number; failed: number; kept: number } {
  let removed = 0, failed = 0;
  const err = (e: unknown) => (e instanceof Error ? e.message : String(e));
  let l: Leftovers;
  try {
    l = leftovers(o);
  } catch (e) {
    o.log(`could not look for leftovers: ${err(e)}`);
    return { removed, failed: 1, kept: 0 };
  }
  const each = (items: string[], what: (x: string) => string, remove: (x: string) => boolean | void) => {
    for (const x of items) {
      try {
        if (remove(x) !== false) {
          removed++;
          o.log(`removed ${what(x)}`);
        }
      } catch (e) {
        failed++;
        o.log(`could not remove ${what(x)}: ${err(e)}`);
      }
    }
  };
  for (const ws of l.due) {
    each([ws.dir], (d) => `the workspace of ${ws.state.repo}#${ws.state.issue} (${ws.state.job?.status ?? ws.state.phase}), ${d}`, (d) => removeWorkspace(o.root, d));
  }
  try {
    for (const t of removeTrash(o.root, o.repo)) {
      removed++;
      o.log(`removed ${t}, a workspace whose removal was cut off`);
    }
  } catch (e) {
    failed++;
    o.log(`could not remove a half-removed workspace: ${err(e)}`);
  }
  each(l.locks, (f) => `stale lock ${f}`, (f) => clearStaleLock(f));
  each(l.temp, (f) => `temp file ${f}`, (f) => { if (lstatSync(f).isFile()) rmSync(f); else return false; });
  each(l.launchers, (d) => `launcher dir ${d}`, (d) => removeLauncher(d));
  return { removed, failed, kept: l.kept.length };
}

const ref = (w: Workspace) => ({ repo: w.state.repo, issue: w.state.issue, phase: w.state.phase, ...(w.state.job ? { status: w.state.job.status } : {}), dir: w.dir });

/**
 * `air status` without an issue, as data: this machine's jobs and everything air left behind. `panes`: every
 * pane on air's tmux server (undefined when tmux couldn't be asked); `serving`: an `air serve` holds the serve
 * lock, so its tmux session is expected. Stray tmux: windows of jobs not held, and the session when neither a
 * job nor a server needs it. `clean`: nothing left behind but workspaces still kept for debugging.
 */
export function machineStatus(l: Leftovers, o: { panes?: ServerPane[]; serving: boolean; socket: string }) {
  const isHeld = (p: ServerPane) => l.held.some((w) => w.state.issue === p.issue && w.state.repo === p.repo);
  let tmux: { windows: string[]; stray: string[] } | undefined;
  if (o.panes) {
    const jobs = o.panes.filter((p) => p.issue !== undefined);
    const stray = jobs.filter((p) => !isHeld(p)).map((p) => `window ${p.windowName} (${p.windowId}) of ${p.repo}#${p.issue}, a job not held`);
    if (!o.serving && !jobs.length && o.panes.length) stray.push(`the tmux session on -L ${o.socket}, with no job and no \`air serve\``);
    tmux = { windows: [...new Set(o.panes.map((p) => p.windowName))], stray };
  }
  const left = l.due.length + l.locks.length + l.temp.length + l.launchers.length + (tmux?.stray.length ?? 0);
  return {
    serving: o.serving, held: l.held.map(ref), kept: l.kept.map(({ ws, until }) => ({ ...ref(ws), until: until.toISOString() })), due: l.due.map(ref), busy: l.busy.map(ref),
    locks: l.locks, temp: l.temp, launchers: l.launchers, tmux: tmux ?? null, left, clean: left === 0,
  };
}

/** `machineStatus` for people, ending in whether the machine is clean. */
export function formatMachineStatus(s: ReturnType<typeof machineStatus>, o: { root: string; stateDir: string; socket: string }): string {
  const out = [`air on this machine: workspace_root ${o.root}, state dir ${o.stateDir}`, `serve: ${s.serving ? 'running' : 'not running'}`];
  const ws = (w: ReturnType<typeof ref>) => `${w.repo}#${w.issue} ${w.phase}${w.status ? `/${w.status}` : ''}: ${w.dir}`;
  out.push(`jobs held: ${s.held.length}`, ...s.held.map((w) => `  ${ws(w)}`));
  out.push(s.tmux ? `tmux (-L ${o.socket}): ${s.tmux.windows.length ? `windows ${s.tmux.windows.join(', ')}` : 'no server'}` : 'tmux: could not be asked');
  const section = (what: string, lines: string[]) => {
    if (lines.length) out.push(`${what}: ${lines.length}`, ...lines.map((x) => `  ${x}`));
  };
  section('workspaces kept for debugging', s.kept.map((w) => `${ws(w)} (removed from ${w.until.slice(0, 10)})`));
  section('workspaces due for removal', s.due.map(ws));
  section('ended jobs still finishing (a delivery lock or tmux pane is live; removed after)', s.busy.map(ws));
  section('stale locks', s.locks);
  section('temp files of air processes that died', s.temp);
  section('launcher dirs left in tmpdir', s.launchers);
  section('tmux leftovers', s.tmux?.stray ?? []);
  if (s.left) out.push(`left behind: ${s.left}; \`air serve\` removes it (files at its daily cleanup, windows of ended jobs within a tick, its tmux session when it stops)`);
  else out.push(s.kept.length ? `clean, but for ${s.kept.length} workspace(s) kept for debugging` : 'clean: nothing left behind');
  return `${out.join('\n')}\n`;
}
