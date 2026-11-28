// The labels air reads and writes on requests (spec/v0.md).
import type { LabelSpec } from '../gh/index.ts';

export const REQUEST_LABEL = 'ai-request';
export const CANCEL_LABEL = 'air:cancel';
export const STATE_LABELS = ['air:claimed', 'air:running', 'air:paused', 'air:done', 'air:partial', 'air:failed'] as const;
/** Every label air reads or writes, as `ensureLabels` creates them, so each exists on a fresh requests repo. */
export const LABELS: readonly LabelSpec[] = [
  { name: REQUEST_LABEL, color: '1d76db', description: 'An AI request for air (spec/v0.md)' },
  { name: 'air:claimed', color: 'fbca04', description: 'air: a server claimed it and is setting it up' },
  { name: 'air:running', color: '0e8a16', description: "air: a server's agent is working on it" },
  { name: 'air:paused', color: 'c5def5', description: "air: the server stopped its agent for now" },
  { name: 'air:done', color: '5319e7', description: 'air: delivered' },
  { name: 'air:partial', color: 'd4c5f9', description: 'air: stopped early; the result is a checkpoint (air retry continues it)' },
  { name: 'air:failed', color: 'b60205', description: 'air: failed; see the last comment (air retry offers it again)' },
  { name: CANCEL_LABEL, color: 'e99695', description: 'air: the requester cancelled it (air cancel)' },
];
/** State labels a holder removes when it gives an issue up. */
export const HELD_LABELS = ['air:claimed', 'air:running', 'air:paused'] as const;
