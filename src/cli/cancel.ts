// `air cancel ISSUE`: cancel a request by adding `air:cancel` (spec/v0.md §12).
import { cancel, CancelError } from '../request/index.ts';
import type { Invocation } from './args.ts';
import { target } from './requests.ts';

export async function cancelCommand(inv: Invocation): Promise<number> {
  const t = target(inv);
  try {
    const r = await cancel({ gh: t.gh, issue: t.issue });
    inv.io.out(r.already
      ? `${t.gh.repo}#${t.issue} already has \`air:cancel\`\n`
      : `cancelled ${t.gh.repo}#${t.issue}: the server holding it stops its agent and releases it on its next tick; \`air retry ${t.issue}\` offers it again\n`);
    return 0;
  } catch (e) {
    if (!(e instanceof CancelError)) throw e;
    inv.io.err(`air cancel: ${e.message}\n`);
    return 1;
  }
}
