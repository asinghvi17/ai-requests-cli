// `air fetch ISSUE [DIR]`: the latest result's report, branches, artifact and checkpoint, in DIR (default
// ./air-ISSUE).
import { FetchError, fetchResult, type FetchOptions } from '../requester/fetch.ts';
import type { Invocation } from './main.ts';
import { target, UsageError } from './requests.ts';

/** Injectable for tests. */
export const fetchDeps: Pick<FetchOptions, 'download' | 'env' | 'allowAnyUrl' | 'ghHost'> = {};

export async function fetchCommand(inv: Invocation): Promise<number> {
  if (inv.positionals.length > 2) throw new UsageError('at most one DIR');
  const t = target(inv);
  const dir = inv.positionals[1] ?? `air-${t.issue}`;
  try {
    const r = await fetchResult({ gh: t.gh, issue: t.issue, dir, ...fetchDeps, log: (s) => inv.io.err(`air fetch: ${s}\n`) });
    inv.io.out(`fetched the ${r.latest.result.status} result of ${t.gh.repo}#${t.issue} into ${dir}${r.written.length ? `: ${r.written.join(', ')}` : ' (it has no report, branches or files)'}\n`);
    return 0;
  } catch (e) {
    if (!(e instanceof FetchError)) throw e;
    inv.io.err(`air fetch: ${e.message}\n`);
    return 1;
  }
}
