// `air release ISSUE`: give this machine's claim back.
import { release } from '../claim/claim.ts';
import type { Invocation } from './args.ts';
import { target } from './requests.ts';

export async function releaseCommand(inv: Invocation): Promise<number> {
  const t = target(inv);
  const r = await release({ gh: t.gh, issue: t.issue, root: t.root });
  if (r.status === 'released') {
    inv.io.out(`released ${t.gh.repo}#${t.issue}\n`);
    return 0;
  }
  inv.io.err(`air release: ${r.message}\n`);
  return 1;
}
