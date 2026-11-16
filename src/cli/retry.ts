// `air retry ISSUE [--effort L]`: offer a cancelled, failed or partial request again (spec/v0.md §12).
import { EFFORTS, type Effort } from '../spec/frontmatter.ts';
import { retry, RetryError } from '../requester/retry.ts';
import type { Invocation } from './main.ts';
import { target, UsageError } from './requests.ts';

export async function retryCommand(inv: Invocation): Promise<number> {
  const effort = inv.flags.effort;
  if (typeof effort === 'string' && !(EFFORTS as readonly string[]).includes(effort)) throw new UsageError(`--effort must be one of ${EFFORTS.join(', ')}`);
  const t = target(inv);
  try {
    const r = await retry({ gh: t.gh, issue: t.issue, ...(typeof effort === 'string' ? { effort: effort as Effort } : {}) });
    const what = [r.resumed ? 'resumes from the partial result' : '', effort ? `effort ${effort}` : ''].filter(Boolean).join(', ');
    inv.io.out(`offered ${t.gh.repo}#${t.issue} again${what ? ` (${what})` : ''}${r.removed.length ? `; removed ${r.removed.join(', ')}` : ''}\n`);
    return 0;
  } catch (e) {
    if (!(e instanceof RetryError)) throw e;
    inv.io.err(`air retry: ${e.message}\n`);
    return 1;
  }
}
