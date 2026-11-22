// Relative imports, as the boundary test (scripts/boundaries.ts) and scripts/move.ts read them. There is one
// form: a relative specifier names a file with its extension, `.ts` or `.json` (no extensionless, `.js` or
// directory specifiers), so a specifier resolves to a path by joining alone.
import { readdirSync, statSync } from 'node:fs';
import { posix } from 'node:path';
import ts from 'typescript';

/** Every file under `dir`, as `dir`-joined posix paths, or none when `dir` does not exist. */
export const filesUnder = (dir: string): string[] => {
  try {
    return readdirSync(dir, { recursive: true, encoding: 'utf8' }).map((f) => posix.join(dir, f.split('\\').join('/')))
      .filter((f) => statSync(f).isFile()).sort();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
};

/** The relative specifiers in `text` (static, type-only, re-export and dynamic imports), with their offsets. */
export function relativeImports(text: string): { spec: string; at: number }[] {
  return ts.preProcessFile(text, true, true).importedFiles.filter((i) => i.fileName.startsWith('.'))
    .map((i) => ({ spec: i.fileName, at: text.indexOf(i.fileName, i.pos) }));
}

/** Why `spec` breaks the one specifier form, or undefined. */
export const badForm = (spec: string): string | undefined =>
  /\.(ts|json)$/.test(spec) ? undefined : `${spec}: name the file with its .ts or .json extension`;

/** The path `spec` names, imported from the file at `from` (both posix, relative to the same root). */
export const resolve = (from: string, spec: string): string => posix.normalize(posix.join(posix.dirname(from), spec));
