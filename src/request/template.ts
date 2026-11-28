// The issue template (spec/templates/ai-request.md) filled in from prompts, for `air submit` on a terminal.
import { DELIVERIES, EFFORTS, HARNESSES, MODEL_TIERS } from './frontmatter.ts';

export type Ask = (question: string) => Promise<string>;

const q = (s: string) => JSON.stringify(s);

async function choose(ask: Ask, label: string, options: readonly string[], dflt: string): Promise<string> {
  for (;;) {
    const a = (await ask(`${label} [${options.join('/')}] (${dflt}): `)).trim();
    if (a === '') return dflt;
    const hit = options.find((o) => o.toLowerCase() === a.toLowerCase());
    if (hit) return hit;
  }
}

/** Lines until one that is just `.` (or, with `blankEnds`, an empty line). */
async function lines(ask: Ask, label: string, blankEnds: boolean): Promise<string[]> {
  const out: string[] = [];
  for (let first = true; ; first = false) {
    const a = await ask(first ? label : '> ');
    if (a.trim() === '.' || (blankEnds && a.trim() === '')) return out;
    out.push(a);
  }
}

/** Fills the issue template (spec/templates/ai-request.md) from prompts. */
export async function promptRequest(ask: Ask, opts: { context: boolean }): Promise<{ title: string; body: string }> {
  const title = (await ask('Title (one line): ')).trim();
  const effort = await choose(ask, 'Effort, share of a weekly window: XS 1% S 3% M 8% L 20% XL 40%', EFFORTS, 'S');
  const deliver = await choose(ask, 'Deliver', DELIVERIES, 'comment');
  const harness = await choose(ask, 'Harness', HARNESSES, 'any');
  const model = await choose(ask, 'Minimum model tier', MODEL_TIERS, 'medium');
  const repoUrl = (await ask(`Git repo to check out, https:// URL (${deliver === 'pr' ? 'required for pr' : 'blank for none'}): `)).trim();
  const ref = repoUrl ? (await ask('Branch, tag or commit (main): ')).trim() || 'main' : '';
  const setup = (await lines(ask, 'Setup commands, one per line (blank line to finish): ', true)).map((s) => s.trim());
  const check = (await ask('Check command, exit 0 = setup worked (blank for none): ')).trim();
  const deadline = (await ask('Deadline YYYY-MM-DD (blank for none): ')).trim();
  const timeout = (await ask('Timeout, e.g. 2h or 30m (4h): ')).trim();
  const task = await lines(ask, 'Task: what should the agent do? Write for someone who has never met you.\nEnd with a line holding only ".":\n', false);
  const done = (await lines(ask, 'Done when: one checkable criterion per line (blank line to finish):\n', true)).map((s) => s.trim().replace(/^[-*]\s*/, ''));
  const contextText = opts.context || repoUrl ? await lines(ask, 'Context: what is in the zip/repo and where to look. End with ".":\n', false) : [];
  const notes = await lines(ask, 'Notes (optional): constraints, style, pitfalls. End with ".":\n', false);

  const fm = ['---', 'air: 0', `effort: ${effort}`, `deliver: ${deliver}`];
  if (harness !== 'any') fm.push(`harness: [${harness}]`);
  if (model !== 'medium') fm.push(`model: ${model}`);
  if (repoUrl) fm.push('repos:', `  - url: ${q(repoUrl)}`, `    ref: ${q(ref)}`);
  if (setup.length) fm.push('setup:', ...setup.map((s) => `  - ${q(s)}`));
  if (check) fm.push(`check: ${q(check)}`);
  if (deadline) fm.push(`deadline: ${q(deadline)}`);
  if (timeout) fm.push(`timeout: ${timeout}`);
  fm.push('---');
  const sections = ['', '## Task', '', ...task, '', '## Done when', '', ...done.map((d) => `- ${d}`)];
  if (contextText.length) sections.push('', '## Context', '', ...contextText);
  if (notes.length) sections.push('', '## Notes', '', ...notes);
  return { title, body: `${[...fm, ...sections].join('\n')}\n` };
}
