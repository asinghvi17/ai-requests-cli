// `air cancel` (spec/v0.md §12): the one way to cancel a request. It adds `air:cancel`, the label the server
// holding the request acts on at its next tick (stop the agent, comment, release), and that keeps every
// other server from claiming it until `air retry`.
import { CANCEL_LABEL, LABELS, REQUEST_LABEL } from './labels.ts';
import { WRITE_ROLES } from './trust.ts';
import { GhError, type RequestsRepo } from '../gh/index.ts';

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
  // An author may get here without triage access, which GitHub needs for labelling (and push for creating
  // the label): its 403 becomes the reason, not a raw API error.
  try {
    await gh.ensureLabels(LABELS.filter((l) => l.name === CANCEL_LABEL));
    await gh.addLabels(n, [CANCEL_LABEL]);
  } catch (e) {
    if (e instanceof GhError && e.kind === 'forbidden') throw new CancelError(labelDenied(gh.repo, viewer, `add \`${CANCEL_LABEL}\` to #${n}`));
    throw e;
  }
  return { already: false };
}

/** Why a label write was refused (403): what the account needs, and who can do it instead. */
export function labelDenied(repo: string, viewer: string, what: string): string {
  return `${viewer} lacks permission to label issues in ${repo}, so it can't ${what}; ask someone with write access to ${repo} to run it (or to give ${viewer} triage or write access)`;
}
