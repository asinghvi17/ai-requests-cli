// The hand-off to the agent launcher. It has the shape of the tmux layer's `startJob` (PR #5) without
// depending on it: `air run` and `air serve` pass a set-up workspace to whatever implements this.
import { join } from 'node:path';
import { TASK_FILE, type State } from './state.ts';

export const TASK_INSTRUCTION = `Read ${TASK_FILE} in this directory and do the task it describes.`;

export interface LaunchInput {
  issue: number;
  /** The workspace root: the agent starts here, next to AIR_TASK.md. */
  cwd: string;
  /** Harness argv; the last word is TASK_INSTRUCTION. */
  argv: string[];
  /** Added to the launcher's allowlisted environment. */
  env?: Record<string, string>;
  /** Unused: setup already wrote AIR_TASK.md. */
  task?: string;
}

/** Starts the agent; resolves to the launcher's id for the job (a tmux window id). */
export type TmuxLaunch = (input: LaunchInput) => Promise<string>;

/** The spec's AIR_* variables for a workspace (spec/v0.md §5). */
export function airEnv(dir: string): Record<string, string> {
  return { AIR_WORKSPACE: dir, AIR_CONTEXT: join(dir, 'context'), AIR_OUT: join(dir, 'out') };
}

export function launchInput(dir: string, state: State, harnessArgv: string[]): LaunchInput {
  if (state.phase !== 'ready') throw new Error(`#${state.issue} is not set up (phase ${state.phase})`);
  return { issue: state.issue, cwd: dir, argv: [...harnessArgv, TASK_INSTRUCTION], env: airEnv(dir) };
}
