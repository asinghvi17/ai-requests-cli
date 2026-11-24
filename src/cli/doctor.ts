// `air doctor`: runs the startup checks `air serve` runs (src/setup/preflight.ts) and reports each one, with the
// command that fixes it on this system, without serving. It writes nothing: the usage it reads skips air's cache,
// and folder trust stays with `air serve`'s first-run prompt, which asks before writing it. Exit 0 when every
// required check passes. The checks are src/setup/doctor.ts; this file wires them to the machine and prints them.
import { homedir } from 'node:os';
import {
  configPath, defaultPreflightDeps, doctor, ghState, gitVersion, hostOs, preflight,
  type AgentCheck, type Config, type GhState, type Line, type Login, type Mark, type Os,
} from '../setup/index.ts';
import { checkTmux, tmuxVersion } from '../server/index.ts';
import { configFile as subscriptionsFile, loadConfig as loadSubscriptions, readUncached, type Reading, type SubscriptionConfig } from '../agents/index.ts';
import type { Invocation } from './args.ts';

/** Injectable for tests. */
export const doctorDeps = {
  platform: (): { platform: string; arch: string } => ({ platform: process.platform, arch: process.arch }),
  os: (): Os => hostOs(),
  env: (): Record<string, string | undefined> => process.env,
  home: (): string => homedir(),
  /** This air's executable: the single binary, or the entry script. */
  self: (): string => (process.argv[1]?.startsWith('/$bunfs/') ? process.execPath : process.argv[1]!),
  tmux: (): Promise<string> => checkTmux(() => tmuxVersion()),
  git: (): string | undefined => gitVersion(),
  gh: (): GhState => ghState(),
  configPath: (): string => configPath(),
  subscriptions: (): SubscriptionConfig[] => loadSubscriptions(subscriptionsFile()),
  preflight: (config: Config, logins: Login[], os: Os): AgentCheck[] => preflight(config, logins, { ...defaultPreflightDeps(doctorDeps.configPath()), os }),
  usage: (sub: Exclude<SubscriptionConfig, { harness: 'manual' }>): Promise<Reading> => readUncached(sub),
};

const SYMBOL: Record<Mark, string> = { ok: '✓', warn: '!', fail: '✗' };

export function formatDoctor(lines: Line[]): string {
  const out: string[] = [];
  for (const l of lines) {
    out.push(`${SYMBOL[l.mark]} ${l.what}`);
    if (l.fix) {
      const [head, ...rest] = l.fix.split('\n');
      out.push(`    fix: ${head}`, ...rest.map((r) => `         ${r}`));
    }
  }
  const failed = lines.filter((l) => l.mark === 'fail').length;
  out.push('', failed
    ? `${failed} problem${failed === 1 ? '' : 's'} to fix (✗); fix ${failed === 1 ? 'it' : 'them'} and run \`air doctor\` again`
    : `ready: air can request and serve work${lines.some((l) => l.mark === 'warn') ? ' (the ! lines are optional)' : ''}`);
  return `${out.join('\n')}\n`;
}

export async function doctorCommand(inv: Invocation): Promise<number> {
  const lines = await doctor(doctorDeps);
  inv.io.out(formatDoctor(lines));
  return lines.some((l) => l.mark === 'fail') ? 1 : 0;
}
