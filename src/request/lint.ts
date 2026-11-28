// `air lint`: checks a request issue body against spec/v0.md. Reads the front matter and the `##`
// section headings only; section text is returned for the agent but never interpreted.

import { parseFrontMatter, sortDiagnostics, type Diagnostic, type Request } from './frontmatter.ts';

export const SECTIONS = ['Task', 'Done when', 'Context', 'Notes'] as const;
export type SectionName = (typeof SECTIONS)[number];

export interface Section {
  /** 1-based line of the `##` heading. */
  line: number;
  /** Text under the heading, up to the next `#` or `##` heading. */
  text: string;
}

export type Sections = Partial<Record<SectionName, Section>>;

export interface LintResult {
  ok: boolean;
  /** Present when ok. */
  request?: Request;
  sections: Sections;
  errors: Diagnostic[];
  /** Problems that don't stop a server from acting on the request. */
  warnings: Diagnostic[];
}

/** The longest issue title air derives from `## Task`. */
export const TITLE_LIMIT = 80;

/** The first line of `## Task`'s text (HTML comments and list or quote marks removed): the issue title's source. */
export function taskSummary(sections: Sections): string | undefined {
  const text = (sections.Task?.text ?? '').replace(/<!--[\s\S]*?(?:-->|$)/g, '');
  return text.split('\n').map((l) => l.replace(/^[#>*\-\s]+/, '').trim()).find((l) => l !== '');
}

/** `line` as an issue title: within TITLE_LIMIT, a longer one cut at a word boundary and ended with `...`. */
export function fitTitle(line: string): string {
  if (line.length <= TITLE_LIMIT) return line;
  const room = line.slice(0, TITLE_LIMIT - 2); // a space at TITLE_LIMIT - 3 still ends a whole word
  const cut = room.search(/\s\S*$/);
  const head = (cut > 0 ? room.slice(0, cut) : room.slice(0, TITLE_LIMIT - 3)).replace(/[\s,;:.-]+$/, '');
  return `${head}...`;
}

export function lint(body: string): LintResult {
  const fm = parseFrontMatter(body);
  const errors: Diagnostic[] = fm.ok ? [] : [...fm.errors];
  const warnings: Diagnostic[] = fm.ok ? [...fm.warnings] : [];
  // A newer spec version may change the sections too: report only that.
  if (errors.some((e) => e.code === 'version')) {
    return { ok: false, sections: {}, errors: errors.filter((e) => e.code === 'version'), warnings };
  }
  const { sections, visible } = fm.bodyStart === undefined ? { sections: {}, visible: new Map<SectionName, string>() } : readSections(fm.lines, fm.bodyStart, errors, warnings);

  if (fm.bodyStart !== undefined) {
    const end = fm.lines.length;
    const need = (name: SectionName, why: string) => {
      if (!sections[name]) errors.push({ line: end, code: 'missing', message: `missing \`## ${name}\` section${why}` });
    };
    const required: SectionName[] = ['Task', 'Done when'];
    need('Task', '');
    need('Done when', '');
    if (fm.ok && (fm.request.context || fm.request.repos.length > 0)) {
      need('Context', ' (required when `context` or `repos` is set)');
      required.push('Context');
    }

    for (const name of required) {
      const s = sections[name];
      if (s && visible.get(name)!.trim() === '') errors.push({ line: s.line, code: 'section', message: `\`## ${name}\` is empty` });
    }
    const summary = taskSummary(sections);
    if (summary && summary.length > TITLE_LIMIT) {
      warnings.push({ line: sections.Task!.line, code: 'section', message: `the first line of \`## Task\` becomes the issue title and is ${summary.length} characters, over ${TITLE_LIMIT}; without --title it is cut to "${fitTitle(summary)}"` });
    }
    const done = sections['Done when'];
    const doneText = visible.get('Done when') ?? '';
    if (done && doneText.trim() !== '' && !/^ {0,3}(?:[-*+]|\d+[.)])\s+\S/m.test(doneText)) {
      errors.push({ line: done.line, code: 'section', message: '`## Done when` must be a list of checkable criteria (`- ...`)' });
    }
  }

  const sorted = sortDiagnostics(errors);
  const result: LintResult = { ok: sorted.length === 0, sections, errors: sorted, warnings: sortDiagnostics(warnings) };
  if (result.ok && fm.ok) result.request = fm.request;
  return result;
}

/**
 * Collects `##` sections, skipping headings inside fenced code blocks and HTML comments. `visible` is
 * each section's text with HTML comments removed, including one left open on the heading line.
 */
function readSections(
  lines: string[],
  start: number,
  errors: Diagnostic[],
  warnings: Diagnostic[],
): { sections: Sections; visible: Map<SectionName, string> } {
  const sections: Sections = {};
  const visible = new Map<SectionName, string>();
  let current: { name: SectionName; line: number; from: number; inComment: boolean } | undefined;
  let fence: { char: string; len: number } | undefined;
  let inComment = false;

  const finish = (to: number) => {
    if (current) {
      const text = lines.slice(current.from, to).join('\n').trim();
      sections[current.name] = { line: current.line, text };
      visible.set(current.name, stripComments((current.inComment ? '<!--' : '') + text));
    }
    current = undefined;
  };

  for (let i = start; i < lines.length; i++) {
    const line = lines[i]!;
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (f && f[1]![0] === fence.char && f[1]!.length >= fence.len && line.trim() === f[1]) fence = undefined;
      continue;
    }
    const startedInComment = inComment;
    inComment = endsInComment(line, inComment);
    if (startedInComment) continue;
    if (f) {
      fence = { char: f[1]![0]!, len: f[1]!.length };
      continue;
    }
    const h = /^ {0,3}(#{1,2})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (!h) continue;
    finish(i);
    if (h[1] === '#') continue;
    const title = h[2]!.replace(/<!--.*$/, '').trim();
    const name = SECTIONS.find((s) => s.toLowerCase() === title.toLowerCase());
    if (!name) {
      warnings.push({ line: i + 1, code: 'section', message: `unknown section \`## ${title}\` (known: ${SECTIONS.join(', ')}); its text still reaches the agent` });
      continue;
    }
    if (sections[name]) {
      errors.push({ line: i + 1, code: 'section', message: `duplicate \`## ${name}\` section (first at line ${sections[name].line})` });
      continue;
    }
    current = { name, line: i + 1, from: i + 1, inComment };
  }
  finish(lines.length);
  return { sections, visible };
}

/** Whether an HTML comment is still open at the end of `line`, given whether one was open at its start. */
function endsInComment(line: string, open: boolean): boolean {
  let i = 0;
  for (;;) {
    if (open) {
      const close = line.indexOf('-->', i);
      if (close < 0) return true;
      i = close + 3;
      open = false;
    } else {
      const start = line.indexOf('<!--', i);
      if (start < 0) return false;
      i = start + 4;
      open = true;
    }
  }
}

/** Removes HTML comments; an unclosed one hides the rest of the text, as in rendered Markdown. */
function stripComments(text: string): string {
  return text.replace(/<!--[\s\S]*?(?:-->|$)/g, '');
}
