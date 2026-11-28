// `air submit [DIR]`: file a request. The body comes from `--body FILE` (`-` for stdin) or, on a terminal,
// from prompts that fill in the issue template. DIR, if given, is zipped and uploaded as the context.
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { releases, type Releases } from '../gh/index.ts';
import { DEFAULT_EXCLUDES, promptRequest, submit, SubmitError, type Ask } from '../request/index.ts';
import { formatLint, readInput } from './lint.ts';
import type { Invocation } from './args.ts';
import { deps as requestDeps, UsageError } from './requests.ts';

/** Injectable for tests. */
export const submitDeps = {
  releases: (repo: string): Releases => releases(repo),
  isTTY: (): boolean => Boolean(process.stdin.isTTY),
  /** Opens a prompt session on the terminal; prompts go to stderr so stdout stays clean. */
  prompter: (): { ask: Ask; close: () => void } => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    return { ask: (q) => rl.question(q), close: () => rl.close() };
  },
};

/** `--repo`, else the config's `repo`. */
export function repoName(inv: Invocation): string {
  const flag = typeof inv.flags.repo === 'string' ? inv.flags.repo : undefined;
  if (flag !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(flag)) throw new UsageError('--repo must be OWNER/NAME');
  const repo = flag ?? requestDeps.loadConfig().repo;
  if (!repo) throw new UsageError('no requests repo: pass --repo OWNER/NAME or set `repo` in the config');
  return repo;
}

export async function submitCommand(inv: Invocation): Promise<number> {
  const { io, flags } = inv;
  const repo = repoName(inv);
  const dir = inv.positionals[0];
  if (inv.positionals.length > 1) throw new UsageError('at most one DIR');
  const dryRun = flags['dry-run'] === true;
  let title = typeof flags.title === 'string' ? flags.title : undefined;
  let body: string;
  let name: string;
  let interactive = false;
  if (typeof flags.body === 'string') {
    ({ name, text: body } = readInput(flags.body));
  } else if (submitDeps.isTTY()) {
    const p = submitDeps.prompter();
    try {
      const r = await promptRequest(p.ask, { context: dir !== undefined });
      title ||= r.title;
      body = r.body;
    } finally {
      p.close();
    }
    name = '<request>';
    interactive = true;
  } else {
    throw new UsageError('pass --body FILE (or --body - for stdin), or run on a terminal to fill in the template');
  }

  const excludes = [...(flags['no-default-excludes'] === true ? [] : DEFAULT_EXCLUDES), ...((flags.exclude as string[] | undefined) ?? [])];
  const common = {
    repo, body, excludes, allowFiles: (flags['allow-file'] as string[] | undefined) ?? [],
    log: (s: string) => io.err(`${s}\n`),
    ...(title !== undefined ? { title } : {}),
    ...(dir !== undefined ? { dir } : {}),
    ...(typeof flags.expires === 'string' ? { expires: flags.expires } : {}),
  };
  try {
    // Interactive runs show the request and ask before uploading anything.
    const preview = dryRun || interactive ? await submit({ ...common, dryRun: true }) : undefined;
    if (preview) {
      io.out(`title: ${preview.title}\n\n${preview.body}${preview.body.endsWith('\n') ? '' : '\n'}`);
      if (dir !== undefined) {
        io.out(`\ncontext zip (${preview.context?.bytes} bytes, ${preview.files.length} files):\n${preview.files.map((f) => `  ${f}\n`).join('')}`);
      }
      if (dryRun) {
        io.out('\ndry run: nothing uploaded, no issue filed\n');
        return 0;
      }
      const p = submitDeps.prompter();
      const yes = await p.ask(`\nFile this request on ${repo}? [y/N] `).finally(() => p.close());
      if (!/^y(es)?$/i.test(yes.trim())) {
        io.err('not filed\n');
        return 1;
      }
    }
    const r = await submit({ ...common, releases: submitDeps.releases(repo) });
    if (r.context) io.out(`uploaded ${r.context.url}\n`);
    io.out(`filed ${r.issue!.url}\n`);
    return 0;
  } catch (e) {
    if (!(e instanceof SubmitError)) throw e;
    if (e.lint) io.err(formatLint(name, e.lint));
    io.err(`air submit: ${e.message}\n`);
    if (e.lint && interactive) {
      const draft = join(tmpdir(), `air-request-${Date.now()}.md`);
      writeFileSync(draft, body);
      io.err(`draft saved to ${draft}; fix it and run: air submit --body ${draft}${dir !== undefined ? ` ${dir}` : ''}\n`);
    }
    return 1;
  }
}
