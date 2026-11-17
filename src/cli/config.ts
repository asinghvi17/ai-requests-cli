// `air config init [--repo OWNER/NAME] [--print]`: write the default config (both agents, unattended), then
// offer, on a terminal, to run `air doctor --fix`.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { configPath, configTemplate } from '../config.ts';
import { doctorCommand, jobDeps } from './jobs.ts';
import type { Invocation } from './main.ts';
import { CommandError, UsageError } from './requests.ts';

/** Injectable for tests. */
export const configDeps = {
  path: (): string => configPath(),
};

export async function configCommand(inv: Invocation): Promise<number> {
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
  inv.io.out(`wrote ${path}${repo ? '' : '; set `repo` in it'}\n`);
  if (!jobDeps.isTTY()) {
    inv.io.out('next: `air doctor` checks that each agent can run unattended (`air doctor --fix` also offers to set up folder trust)\n');
    return 0;
  }
  const p = jobDeps.prompter();
  const answer = await p.ask('Check that each agent can run unattended, and fix folder trust (`air doctor --fix`)? [Y/n] ').finally(() => p.close());
  if (/^n(o)?$/i.test(answer.trim())) {
    inv.io.out('next: `air doctor --fix` checks that each agent can run unattended\n');
    return 0;
  }
  return doctorCommand({ ...inv, positionals: [], flags: { fix: true } });
}
