// `air setup ISSUE`: prepare the workspace of a claimed request.
import { setup } from '../workspace/setup.ts';
import type { Invocation } from './main.ts';
import { target } from './requests.ts';

export async function setupCommand(inv: Invocation): Promise<number> {
  const t = target(inv);
  const r = await setup({ gh: t.gh, issue: t.issue, root: t.root });
  if (r.status === 'ready') {
    inv.io.out(`set up ${t.gh.repo}#${t.issue} in ${r.dir}\nnext: air run ${t.issue}\n`);
    return 0;
  }
  inv.io.err(r.status === 'failed' ? `air setup: failed at ${r.step}: ${r.message} (see ${r.dir}/setup.log; the claim was released)\n` : `air setup: ${r.message}\n`);
  return 1;
}
