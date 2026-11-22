// `air skill install [--repo OWNER/NAME] [--dir DIR] [--print]`: install the bundled Claude Code skill that
// files AI requests, and on first run write the config that names the requests repo (asked for on a terminal;
// off one, --repo is needed).
import { resolve } from 'node:path';
import { defaultSkillDir, installSkill, InstallError, SKILL_NAME } from '../skill/install.ts';
import { ensureConfig, firstRunDeps } from './firstrun.ts';
import type { Invocation } from './main.ts';
import { CommandError, UsageError } from './requests.ts';

/** Injectable for tests. */
export const skillDeps = {
  defaultDir: (): string => defaultSkillDir(),
};

export async function skillCommand(inv: Invocation): Promise<number> {
  const [action, ...extra] = inv.positionals;
  if (action !== 'install') throw new UsageError(`unknown action ${JSON.stringify(action)}; the only one is install`);
  if (extra.length > 0) throw new UsageError(`unexpected argument ${JSON.stringify(extra[0])}`);
  const flag = inv.flags.dir;
  if (flag === '') throw new UsageError('--dir must not be empty');
  const repo = inv.flags.repo;
  if (repo !== undefined && (typeof repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repo))) throw new UsageError('--repo must be OWNER/NAME');
  const dir = typeof flag === 'string' ? resolve(flag) : skillDeps.defaultDir();
  if (inv.flags.print === true) {
    inv.io.out(`${dir}\n`);
    return 0;
  }
  // The config first: off a terminal without --repo, that fails before anything is installed.
  await ensureConfig(inv.io, repo, firstRunDeps.isTTY());
  try {
    installSkill(dir);
  } catch (e) {
    if (e instanceof InstallError) throw new CommandError(e.message);
    throw e;
  }
  inv.io.out(`installed the ${SKILL_NAME} skill in ${dir}\n`);
  return 0;
}
