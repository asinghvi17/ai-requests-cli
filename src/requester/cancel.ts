// `air cancel` (spec/v0.md §12): the one way to cancel a request. It adds `air:cancel`, the label the server
// holding the request acts on at its next tick (stop the agent, comment, release), and that keeps every
// other server from claiming it until `air retry`.
import { CANCEL_LABEL, LABELS, REQUEST_LABEL } from '../claim/claim.ts';
import { WRITE_ROLES } from '../claim/trust.ts';
import type { RequestsRepo } from '../gh/issues.ts';

export class CancelError extends Error {}

export interface Cancelled {
  /** The issue carried `air:cancel` already. */
  already: boolean;
}

export async function cancel(opts: { gh: RequestsRepo; issue: number }): Promise<Cancelled> {
  const { gh, issue: n } = opts;
  const issue = await gh.issue(n);
  if (issue.isPullRequest || !issue.labels.includes(REQUEST_LABEL)) throw new CancelError(`#${n} is not a request (no \`${REQUEST_LABEL}\` label)`);
  if (issue.state !== 'open') throw new CancelError(`#${n} is closed, which cancels it already`);
  const viewer = await gh.viewer();
  if (viewer !== issue.author) {
    const role = await gh.permission(gh.repo, viewer);
    if (!(WRITE_ROLES as readonly string[]).includes(role)) {
      throw new CancelError(`only the issue's author (${issue.author}) or someone with write access to ${gh.repo} can cancel #${n}; ${viewer} has ${role}`);
    }
  }
  if (issue.labels.includes(CANCEL_LABEL)) return { already: true };
  await gh.ensureLabels(LABELS.filter((l) => l.name === CANCEL_LABEL));
  await gh.addLabels(n, [CANCEL_LABEL]);
  return { already: false };
}
