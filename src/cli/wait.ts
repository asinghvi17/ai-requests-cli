// `air wait ISSUE [--timeout DURATION] [--json]`: block until the request has a current result, print it as
// `air status` does, and exit 0 done, 3 partial, 1 failed or released (or unreadable), 4 timeout.
import { parseDuration } from '../spec/frontmatter.ts';
import { formatStatus, statusJson, WAIT_EXIT, waitForResult, type WaitOptions } from '../requester/status.ts';
import type { Invocation } from './args.ts';
import { target, UsageError } from './requests.ts';

/** Injectable for tests. */
export const waitDeps: Pick<WaitOptions, 'sleep' | 'now' | 'intervalMs'> = {};

export async function waitCommand(inv: Invocation): Promise<number> {
  const raw = inv.flags.timeout;
  let timeoutMs: number | undefined;
  if (typeof raw === 'string') {
    const minutes = parseDuration(raw);
    if (!minutes) throw new UsageError(`--timeout must be a duration like 90m, 2h or 1h30m, got ${JSON.stringify(raw)}`);
    timeoutMs = minutes * 60_000;
  }
  const t = target(inv);
  const { status, timedOut } = await waitForResult(t.gh, t.issue, {
    ...waitDeps, ...(timeoutMs === undefined ? {} : { timeoutMs }),
    onRetry: (e) => inv.io.err(`air wait: ${e.message}; trying again\n`),
  });
  inv.io.out(inv.flags.json === true ? `${JSON.stringify(statusJson(status), null, 2)}\n` : formatStatus(status));
  if (timedOut) {
    inv.io.err(`air wait: #${t.issue} has no current result after ${raw}\n`);
    return WAIT_EXIT.timeout;
  }
  return WAIT_EXIT[status.latest!.result.status];
}
