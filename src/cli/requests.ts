// Shared plumbing for commands that act on one request issue: the issue number, the requests repo
// (`--repo` or the config's `repo`) and the workspace root.
import { loadConfig, type Config } from '../setup/index.ts';
import { requestsRepo, type RequestsRepo } from '../gh/index.ts';
import type { Invocation } from './args.ts';

export type Target = { gh: RequestsRepo; issue: number; root: string; config: Config };

/** Injectable for tests. */
export const deps = {
  loadConfig: (): Config => loadConfig(),
  repo: (name: string): RequestsRepo => requestsRepo(name),
};

/** Bad flags or arguments: the router prints the command's usage and exits 2. */
export class UsageError extends Error {}

export function target(inv: Invocation): Target {
  const raw = inv.positionals[0]!;
  const m = /^#?(\d+)$/.exec(raw);
  if (!m || Number(m[1]) < 1 || !Number.isSafeInteger(Number(m[1]))) throw new UsageError(`ISSUE must be an issue number, got ${JSON.stringify(raw)}`);
  const flag = typeof inv.flags.repo === 'string' ? inv.flags.repo : undefined;
  if (flag !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(flag)) throw new UsageError('--repo must be OWNER/NAME');
  const config = deps.loadConfig();
  const repo = flag ?? config.repo;
  if (!repo) throw new UsageError('no requests repo: pass --repo OWNER/NAME or set `repo` in the config');
  return { gh: deps.repo(repo), issue: Number(m[1]), root: config.workspace_root, config };
}
