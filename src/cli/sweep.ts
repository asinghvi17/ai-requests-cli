// `air sweep [--dry-run]`: delete expired context and artifact assets on the requests repo (spec/v0.md §7).
import type { Trust } from '../claim/trust.ts';
import type { Releases } from '../gh/releases.ts';
import { sweep } from '../sweep/sweep.ts';
import type { Invocation } from './main.ts';
import { repoName } from './submit.ts';

/** Injectable for tests; undefined means the real repo through gh. */
export const sweepDeps: { releases?: (repo: string) => Releases; trust?: (repo: string) => Trust } = {};

export async function sweepCommand(inv: Invocation): Promise<number> {
  const repo = repoName(inv);
  const dryRun = inv.flags['dry-run'] === true;
  const r = await sweep({
    repo, dryRun, log: (s) => inv.io.out(`${s}\n`),
    ...(sweepDeps.releases ? { releases: sweepDeps.releases(repo) } : {}),
    ...(sweepDeps.trust ? { trust: sweepDeps.trust(repo) } : {}),
  });
  inv.io.out(`${dryRun ? 'would delete' : 'deleted'} ${r.deleted.length}, kept ${r.kept.length}${r.failed.length ? `, failed ${r.failed.length}` : ''}\n`);
  return r.failed.length ? 1 : 0;
}
