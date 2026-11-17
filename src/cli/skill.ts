// `air skill install [--dir DIR] [--print]`: install the bundled Claude Code skill that files AI requests.
import { resolve } from 'node:path';
import { defaultSkillDir, installSkill, InstallError, SKILL_NAME } from '../skill/install.ts';
import type { Invocation } from './main.ts';
import { CommandError, UsageError } from './requests.ts';

/** Injectable for tests. */
export const skillDeps = {
  defaultDir: (): string => defaultSkillDir(),
};

export function skillCommand(inv: Invocation): number {
  const [action, ...extra] = inv.positionals;
  if (action !== 'install') throw new UsageError(`unknown action ${JSON.stringify(action)}; the only one is install`);
  if (extra.length > 0) throw new UsageError(`unexpected argument ${JSON.stringify(extra[0])}`);
  const flag = inv.flags.dir;
  if (flag === '') throw new UsageError('--dir must not be empty');
  const dir = typeof flag === 'string' ? resolve(flag) : skillDeps.defaultDir();
  if (inv.flags.print === true) {
    inv.io.out(`${dir}\n`);
    return 0;
  }
  try {
    installSkill(dir);
  } catch (e) {
    if (e instanceof InstallError) throw new CommandError(e.message);
    throw e;
  }
  inv.io.out(`installed the ${SKILL_NAME} skill in ${dir}\n`);
  return 0;
}
