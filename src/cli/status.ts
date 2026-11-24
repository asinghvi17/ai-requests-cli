// `air status ISSUE [--json]`: a request's state label, holder and latest result (spec/v0.md §12). Read-only.
// On the machine running the request it also shows whether the agent is waiting on the volunteer.
// `air status` without ISSUE: this machine's jobs and what air left behind on it (serve/tidy.ts), or that it is clean.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, type Config } from '../setup/index.ts';
import { formatStatus, readStatus, statusJson } from '../request/index.ts';
import {
  activeWorkspace, defaultRunner, formatMachineStatus, leftovers, LOCK_FILE, machineStatus, serverPanes, staleLock, type ServerPane,
} from '../server/index.ts';
import { stateDir } from '../agents/index.ts';
import type { Invocation } from './args.ts';
import { target } from './requests.ts';

/** Injectable for tests. */
export const statusDeps = {
  loadConfig: (): Config => loadConfig(),
  stateDir: (): string => stateDir(),
  socket: 'air',
  panes: (socket: string): Promise<ServerPane[]> => serverPanes(defaultRunner(socket)),
  now: (): Date => new Date(),
};

export async function statusCommand(inv: Invocation): Promise<number> {
  if (inv.positionals.length === 0) return machineCommand(inv);
  const t = target(inv);
  const s = await readStatus(t.gh, t.issue);
  const job = activeWorkspace(t.root, t.gh.repo, t.issue)?.state.job;
  const waiting = job?.status === 'running' ? job.waiting : undefined;
  if (inv.flags.json === true) {
    inv.io.out(`${JSON.stringify({ ...statusJson(s), ...(waiting ? { waiting } : {}) }, null, 2)}\n`);
    return 0;
  }
  inv.io.out(formatStatus(s));
  if (waiting) inv.io.out(`waiting: the ${job!.harness} agent here waits on you since ${waiting.since}: ${waiting.what}\n  fix:   ${waiting.fix}\n`);
  return 0;
}

async function machineCommand(inv: Invocation): Promise<number> {
  const root = statusDeps.loadConfig().workspace_root;
  const dir = statusDeps.stateDir();
  const socket = statusDeps.socket;
  let panes: ServerPane[] | undefined;
  try {
    panes = await statusDeps.panes(socket);
  } catch {
    // tmux missing or broken: reported as not asked
  }
  const s = machineStatus(leftovers({ root, stateDir: dir, now: statusDeps.now(), panes }), { panes, serving: existsSync(join(dir, LOCK_FILE)) && !staleLock(join(dir, LOCK_FILE)), socket });
  inv.io.out(inv.flags.json === true ? `${JSON.stringify(s, null, 2)}\n` : formatMachineStatus(s, { root, stateDir: dir, socket }));
  return 0;
}
