// `air status ISSUE [--json]`: a request's state label, holder and latest result (spec/v0.md §12). Read-only.
// On the machine running the request it also shows whether the agent is waiting on the volunteer.
import { formatStatus, readStatus, statusJson } from '../requester/status.ts';
import { activeWorkspace } from '../workspace/state.ts';
import type { Invocation } from './main.ts';
import { target } from './requests.ts';

export async function statusCommand(inv: Invocation): Promise<number> {
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
