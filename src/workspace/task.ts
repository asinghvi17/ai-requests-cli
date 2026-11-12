// AIR_TASK.md: the full prompt the agent reads (spec/v0.md §5). A header air writes, describing the
// workspace and how the result comes back, then the request's sections exactly as the requester wrote them.
import { parseFrontMatter, type Request } from '../spec/frontmatter.ts';
import type { State } from './state.ts';

/** The agent creates this file in the workspace root when it is done; `air serve` then delivers. */
export const DONE_FILE = 'AIR_DONE';
/** The agent's running notes in `out/`: what is done, what is next, decisions made (spec §5). */
export const PROGRESS_FILE = 'PROGRESS.md';

/** The request body after its front matter. */
export function requestText(body: string): string {
  const fm = parseFrontMatter(body);
  return fm.bodyStart === undefined ? '' : fm.lines.slice(fm.bodyStart).join('\n').trim();
}

const DELIVERY: Record<Request['deliver'], (r: Request) => string> = {
  comment: () =>
    'Deliver a written report. When you are done, write your final report in Markdown to `out/REPORT.md`; ' +
    'air posts it on the issue as a comment.',
  pr: ({ repos: [r] }) =>
    `Deliver a pull request against \`${r!.ref}\` of ${r!.url}. Work in \`repo/\` and commit your work on a new ` +
    `branch there. Uncommitted changes are not delivered, and air opens no PR if there are no commits beyond ` +
    `\`${r!.ref}\`. Don't push: air pushes the branch and opens the PR. Write a short summary of the change ` +
    'in Markdown to `out/REPORT.md` for the PR description.',
  artifact: () =>
    'Deliver files. Leave the result files in `out/`; air zips the regular files and directories there (symlinks ' +
    'are skipped) and attaches them to the issue. An empty `out/` counts as a failure.',
};

export function taskPrompt(state: State, request: Request, body: string, dir: string): string {
  const layout = [
    request.repos[0] ? `- \`repo/\`: ${request.repos[0].url} ${checkedOut(request)}. Setup ran there.` : undefined,
    request.context ? '- `context/`: the request\'s context zip, extracted.' : undefined,
    request.resume?.out ? '- `out/`: the earlier work\'s `out/`, as its checkpoint left it; see "Delivering" below.' : '- `out/`: empty; see "Delivering" below.',
    '- `request.md`: the issue body as claimed, front matter included.',
  ].filter(Boolean);
  return [
    `# ${state.title} (${state.repo}#${state.issue})`,
    '',
    `This task comes from ${state.url}, filed by @${state.author}. Work on your own: nobody is watching to answer`,
    `questions, so make reasonable decisions and note them in your report. You have ${formatMinutes(request.timeoutMinutes)}.`,
    '',
    '## Workspace',
    '',
    `Your working directory is \`${dir}\` (also \`$AIR_WORKSPACE\`). It holds:`,
    '',
    ...layout,
    '',
    ...(request.resume ? [
      '## Continuing earlier work',
      '',
      'This request was started before and stopped early. You are continuing that work: its state is in',
      `\`out/${PROGRESS_FILE}\`${request.resume.branches.length ? ' and in the git log of `repo/`' : ''}. Read them first, then carry on from where it`,
      'left off rather than starting over.',
      '',
    ] : []),
    '## Progress',
    '',
    `Keep \`out/${PROGRESS_FILE}\` up to date as you work: what is done, what is next, and the decisions you made.`,
    request.repos[0]
      ? 'Commit your work in `repo/` often, work-in-progress commits included. If you are stopped early, air keeps only your commits and `out/`, and whoever continues starts from them.'
      : 'If you are stopped early, air keeps only `out/`, and whoever continues starts from it.',
    '',
    '## Delivering',
    '',
    DELIVERY[request.deliver](request),
    '',
    `When you have finished, and only then, create the empty file \`${DONE_FILE}\` in \`${dir}\`. air delivers the result`,
    'as soon as that file appears, and closes your session.',
    '',
    'The request follows. Its "Done when" list is how the result will be judged.',
    '',
    '---',
    '',
    requestText(body),
    '',
  ].join('\n');
}

function checkedOut(request: Request): string {
  const r = request.repos[0]!;
  const b = request.resume?.branches.find((x) => x.repo === r.path);
  return b ? `checked out at the earlier work's checkpoint, \`${b.sha}\` on branch \`${b.branch}\` (the request's \`ref\` is \`${r.ref}\`)` : `checked out at \`${r.ref}\``;
}

function formatMinutes(m: number): string {
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return [h ? `${h} h` : '', rest ? `${rest} min` : ''].filter(Boolean).join(' ');
}
