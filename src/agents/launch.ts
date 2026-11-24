// The environment a job's agent starts with.
import { join } from 'node:path';

/** The spec's AIR_* variables for a workspace (spec/v0.md §5). */
export function airEnv(dir: string): Record<string, string> {
  return { AIR_WORKSPACE: dir, AIR_CONTEXT: join(dir, 'context'), AIR_OUT: join(dir, 'out') };
}
