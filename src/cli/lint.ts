// `air lint [FILE|-]`: check a request body against spec/v0.md. Reads stdin when FILE is `-` or absent.
// A filled-in copy of the issue template (with GitHub's `name:`/`about:` header) lints as its request.
import { readFileSync } from 'node:fs';
import { lint, type LintResult } from '../spec/lint.ts';
import { blankTemplateHeader } from '../submit/submit.ts';
import type { Invocation } from './args.ts';

/** Injectable for tests. */
export const lintDeps = {
  readStdin: (): string => readFileSync(0, 'utf8'),
};

/** `name:line: error: message` lines, errors and warnings in line order. */
export function formatLint(name: string, r: LintResult): string {
  const all = [
    ...r.errors.map((d) => ({ ...d, kind: 'error' })),
    ...r.warnings.map((d) => ({ ...d, kind: 'warning' })),
  ].sort((a, b) => a.line - b.line);
  return all.map((d) => `${name}:${d.line}: ${d.kind}: ${d.message}\n`).join('');
}

export function readInput(path: string | undefined): { name: string; text: string } {
  if (path === undefined || path === '-') return { name: '<stdin>', text: lintDeps.readStdin() };
  return { name: path, text: readFileSync(path, 'utf8') };
}

export function lintCommand(inv: Invocation): number {
  let input;
  try {
    input = readInput(inv.positionals[0]);
  } catch (e) {
    inv.io.err(`air lint: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
  const r = lint(blankTemplateHeader(input.text));
  const report = formatLint(input.name, r);
  if (r.ok) {
    inv.io.out(`${report}${input.name}: ok\n`);
    return 0;
  }
  const n = r.errors.length;
  inv.io.err(`${report}${input.name}: ${n} error${n === 1 ? '' : 's'}\n`);
  return 1;
}
