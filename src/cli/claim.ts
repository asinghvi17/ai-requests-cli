// `air claim ISSUE`: claim a request and create its workspace.
import { claim } from '../claim/claim.ts';
import type { Invocation } from './args.ts';
import { target } from './requests.ts';

export async function claimCommand(inv: Invocation): Promise<number> {
  const t = target(inv);
  inv.io.err(`air claim: claiming ${t.gh.repo}#${t.issue} (waiting for rival claims)...\n`);
  const r = await claim({ gh: t.gh, issue: t.issue, root: t.root, ghHost: process.env.GH_HOST || undefined });
  if (r.status === 'won') {
    inv.io.out(`claimed ${t.gh.repo}#${t.issue}; workspace ${r.dir}\nnext: air setup ${t.issue}\n`);
    return 0;
  }
  inv.io.err(r.status === 'lost' ? `air claim: lost the race for #${t.issue} to ${r.holder}\n` : `air claim: ${r.message}\n`);
  return 1;
}
