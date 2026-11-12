// `air status ISSUE [--json]`: a request's state label, holder and latest result (spec/v0.md §12). Read-only.
import { formatStatus, readStatus, statusJson } from '../requester/status.ts';
import type { Invocation } from './main.ts';
import { target } from './requests.ts';

export async function statusCommand(inv: Invocation): Promise<number> {
  const t = target(inv);
  const s = await readStatus(t.gh, t.issue);
  inv.io.out(inv.flags.json === true ? `${JSON.stringify(statusJson(s), null, 2)}\n` : formatStatus(s));
  return 0;
}
