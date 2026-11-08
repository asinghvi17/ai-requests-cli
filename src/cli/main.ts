#!/usr/bin/env node
// air: the CLI entry. Routes argv to a command; unimplemented commands exit 2.
import { ArgError, parseArgs, type FlagSpecs } from './args.ts';
import { VERSION } from '../version.ts';
import { usageCommand } from '../usage/index.ts';
import { claimCommand } from './claim.ts';
import { releaseCommand } from './release.ts';
import { UsageError } from './requests.ts';
import { setupCommand } from './setup.ts';
import { lintCommand } from './lint.ts';
import { submitCommand } from './submit.ts';
import { sweepCommand } from './sweep.ts';
import { attachCommand, debugCommand, pauseCommand, resumeCommand, runCommand, serveCommand, startCommand, stopCommand } from './jobs.ts';

export type Io = { out: (s: string) => void; err: (s: string) => void };
export type Invocation = { argv: string[]; flags: Record<string, string | boolean | string[]>; positionals: string[]; io: Io };
type Command = {
  usage: string;
  summary: string;
  args: string[]; // required positionals, by name
  flags: FlagSpecs;
  raw?: boolean; // the command parses its own argv (and handles --help); the router passes it through
  run?: (inv: Invocation) => Promise<number> | number;
};

const HELP: FlagSpecs = { help: { type: 'boolean', short: 'h' } };
const REPO: FlagSpecs = { repo: { type: 'string' } };

export const COMMANDS: Record<string, Command> = {
  submit: {
    usage: 'submit [--body FILE|-] [--dry-run] [--allow-file PATH]... [DIR]',
    summary: 'file a request; DIR becomes its context zip (also: --repo, --title, --expires YYYY-MM-DD, --exclude NAME, --no-default-excludes)',
    args: [],
    flags: {
      ...REPO, body: { type: 'string' }, title: { type: 'string' }, 'dry-run': { type: 'boolean' },
      'allow-file': { type: 'string', multiple: true }, exclude: { type: 'string', multiple: true },
      'no-default-excludes': { type: 'boolean' }, expires: { type: 'string' },
    },
    run: submitCommand,
  },
  serve: {
    usage: 'serve [--repo OWNER/NAME] [--manual] [--once [--once-wait SECONDS]]',
    summary: 'poll the requests repo, claim fitting requests and start agents (--manual: wait for `air run`; --once: one tick, then wait for its jobs; a --once that finds no request polls again every 10 s for --once-wait seconds, default 60)',
    args: [],
    flags: { ...REPO, manual: { type: 'boolean' }, once: { type: 'boolean' }, 'once-wait': { type: 'string' } },
    run: serveCommand,
  },
  claim: { usage: 'claim [--repo OWNER/NAME] ISSUE', summary: 'claim a request', args: ['ISSUE'], flags: REPO, run: claimCommand },
  setup: { usage: 'setup [--repo OWNER/NAME] ISSUE', summary: 'prepare the workspace for a claimed request', args: ['ISSUE'], flags: REPO, run: setupCommand },
  run: { usage: 'run [--repo OWNER/NAME] ISSUE', summary: 'start the agent for a set-up request', args: ['ISSUE'], flags: REPO, run: runCommand },
  attach: { usage: 'attach [--repo OWNER/NAME] [ISSUE]', summary: "attach to the air tmux session, or a request's window", args: [], flags: REPO, run: attachCommand },
  stop: { usage: 'stop [--repo OWNER/NAME] ISSUE', summary: "stop a request's agent (keeps the claim and workspace)", args: ['ISSUE'], flags: REPO, run: stopCommand },
  start: { usage: 'start [--repo OWNER/NAME] ISSUE', summary: 'resume a stopped agent', args: ['ISSUE'], flags: REPO, run: startCommand },
  pause: { usage: 'pause', summary: 'stop claiming new requests (running jobs continue)', args: [], flags: {}, run: pauseCommand },
  resume: { usage: 'resume', summary: 'resume claiming requests', args: [], flags: {}, run: resumeCommand },
  usage: {
    usage: 'usage [--refresh] [--json] [spend NAME AMOUNT | reset-ledger]',
    summary: 'show subscription quota',
    args: [],
    flags: {},
    raw: true,
    run: ({ argv, io }) => usageCommand(argv, { out: (s) => io.out(`${s}\n`), err: (s) => io.err(`${s}\n`) }),
  },
  release: { usage: 'release [--repo OWNER/NAME] ISSUE', summary: 'give a claimed request back', args: ['ISSUE'], flags: REPO, run: releaseCommand },
  lint: { usage: 'lint [FILE|-]', summary: 'check a request body against the spec', args: [], flags: {}, run: lintCommand },
  sweep: { usage: 'sweep [--repo OWNER/NAME] [--dry-run]', summary: 'delete expired context and artifact assets', args: [], flags: { ...REPO, 'dry-run': { type: 'boolean' } }, run: sweepCommand },
};

/** Commands left out of the help: diagnostics for a human debugging their own machine. */
export const HIDDEN: Record<string, Command> = {
  debug: { usage: 'debug [--repo OWNER/NAME] panes', summary: "print tmux's raw pane list and the jobs air thinks it has", args: ['TOPIC'], flags: REPO, run: debugCommand },
};

export function helpText(): string {
  const width = Math.max(...Object.values(COMMANDS).map((c) => c.usage.length));
  const lines = Object.values(COMMANDS).map((c) => `  ${c.usage.padEnd(width)}  ${c.summary}`);
  return `air ${VERSION}: hand AI work to colleagues with spare quota\n\nusage: air <command> [flags]\n${lines.join('\n')}\n\n  air --help | --version\n`;
}

export async function main(argv: readonly string[], io: Io): Promise<number> {
  const [name, ...rest] = argv;
  if (name === undefined || name === '--help' || name === '-h' || name === 'help') {
    (name === undefined ? io.err : io.out)(helpText());
    return name === undefined ? 1 : 0;
  }
  if (name === '--version' || name === '-v') {
    io.out(`${VERSION}\n`);
    return 0;
  }
  const cmd = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : Object.hasOwn(HIDDEN, name) ? HIDDEN[name] : undefined;
  if (!cmd) {
    io.err(`air: unknown command ${JSON.stringify(name)}\n${helpText()}`);
    return 1;
  }
  if (cmd.raw && cmd.run) return cmd.run({ argv: rest, flags: {}, positionals: [], io });
  let parsed;
  try {
    parsed = parseArgs(rest, { ...HELP, ...cmd.flags });
  } catch (e) {
    if (!(e instanceof ArgError)) throw e;
    io.err(`air ${name}: ${e.message}\nusage: air ${cmd.usage}\n`);
    return 1;
  }
  if (parsed.flags.help) {
    io.out(`usage: air ${cmd.usage}\n  ${cmd.summary}\n`);
    return 0;
  }
  if (parsed.positionals.length < cmd.args.length) {
    io.err(`air ${name}: missing ${cmd.args.slice(parsed.positionals.length).join(' ')}\nusage: air ${cmd.usage}\n`);
    return 1;
  }
  if (!cmd.run) {
    io.err(`air ${name}: not implemented yet\n`);
    return 2;
  }
  try {
    return await cmd.run({ ...parsed, argv: rest, io });
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    io.err(`air ${name}: ${e.message}\nusage: air ${cmd.usage}\n`);
    return 1;
  }
}

// Run when executed directly (node src/cli/main.ts); bundles for single binaries call run() themselves.
export function run(): void {
  const io: Io = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) };
  main(process.argv.slice(2), io).then(
    (code) => { process.exitCode = code; },
    (e: unknown) => {
      io.err(`air: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = 1;
    },
  );
}

if (import.meta.main) run();
