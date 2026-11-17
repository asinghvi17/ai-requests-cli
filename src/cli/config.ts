// `air config init [--repo OWNER/NAME] [--print]`: write the default config (both agents, unattended).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { configPath, configTemplate } from '../config.ts';
import type { Invocation } from './main.ts';
import { CommandError, UsageError } from './requests.ts';

/** Injectable for tests. */
export const configDeps = {
  path: (): string => configPath(),
};

export function configCommand(inv: Invocation): number {
  const [action, ...extra] = inv.positionals;
  if (action !== 'init') throw new UsageError(`unknown action ${JSON.stringify(action)}; the only one is init`);
  if (extra.length > 0) throw new UsageError(`unexpected argument ${JSON.stringify(extra[0])}`);
  const repo = inv.flags.repo;
  if (repo !== undefined && (typeof repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repo))) throw new UsageError('--repo must be OWNER/NAME');
  const text = configTemplate(repo);
  if (inv.flags.print === true) {
    inv.io.out(text);
    return 0;
  }
  const path = configDeps.path();
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(path, text, { flag: 'wx' });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new CommandError(`${path} already exists; edit it, or move it away and run \`air config init\` again`);
    throw e;
  }
  inv.io.out(`wrote ${path}${repo ? '' : '; set `repo` in it'}\nnext: \`air doctor\` checks that each agent can run unattended\n`);
  return 0;
}
