// Picks the files `air submit DIR` puts in a context zip: walks DIR without following symlinks, skips the
// default heavy directories (`.git/`, `node_modules/`, ...) and anything a `.gitignore` excludes.
// `.gitignore` support covers the documented pattern syntax: `#` comments, `!` negation, trailing `/` for
// directories, anchoring by a leading or inner `/`, `*`, `?`, `[...]` and `**`. Nested `.gitignore` files
// apply below their directory, and later patterns win. As in git, nothing inside an ignored directory can be
// re-included.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Directory names skipped at any depth unless `--no-default-excludes` is given. */
export const DEFAULT_EXCLUDES: readonly string[] = [
  '.git', '.hg', '.svn', 'node_modules', '.venv', 'venv', '__pycache__', '.tox', '.nox', '.mypy_cache',
  '.pytest_cache', '.ruff_cache', '.gradle', '.next', '.nuxt', '.parcel-cache', '.turbo', '.terraform',
];

export interface Rule {
  /** Directory of the `.gitignore` the rule came from, relative to the root ('' for the root). */
  base: string;
  negate: boolean;
  dirOnly: boolean;
  re: RegExp;
}

function classToRegex(glob: string, i: number): [string, number] | undefined {
  let j = i + 1;
  let neg = false;
  if (glob[j] === '!' || glob[j] === '^') {
    neg = true;
    j++;
  }
  let body = '';
  if (glob[j] === ']') {
    body += '\\]';
    j++;
  }
  for (; j < glob.length && glob[j] !== ']'; j++) {
    const c = glob[j]!;
    body += c === '\\' || c === '^' || c === '[' ? `\\${c}` : c;
  }
  if (j >= glob.length) return undefined;
  // A negated class still never matches `/`.
  return [neg ? `[^/${body}]` : `[${body}]`, j];
}

function globToRegex(glob: string): string {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*' && (i === 0 || glob[i - 1] === '/') && (i + 2 === glob.length || glob[i + 2] === '/')) {
        if (i + 2 === glob.length) out += '.*';
        else {
          out += '(?:.*/)?';
          i += 2;
          continue;
        }
        i++;
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else if (c === '[') {
      const cls = classToRegex(glob, i);
      if (cls) {
        out += cls[0];
        i = cls[1];
      } else {
        out += '\\[';
      }
    } else if (c === '\\' && i + 1 < glob.length) {
      out += glob[++i]!.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    } else {
      out += c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    }
  }
  return out;
}

/** Parses one `.gitignore` file's text. `base` is its directory relative to the walk root. */
export function parseGitignore(text: string, base = ''): Rule[] {
  const rules: Rule[] = [];
  for (let line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (line === '' || line.startsWith('#')) continue;
    // Trailing spaces are ignored unless escaped.
    line = line.replace(/(?<!\\)\s+$/, '');
    if (line === '') continue;
    let negate = false;
    if (line.startsWith('!')) {
      negate = true;
      line = line.slice(1);
    } else if (line.startsWith('\\!') || line.startsWith('\\#')) {
      line = line.slice(1);
    }
    let dirOnly = false;
    if (line.endsWith('/') && !line.endsWith('\\/')) {
      dirOnly = true;
      line = line.slice(0, -1);
    }
    if (line === '') continue;
    const anchored = line.includes('/');
    if (line.startsWith('/')) line = line.slice(1);
    const body = globToRegex(line);
    rules.push({ base, negate, dirOnly, re: new RegExp(anchored ? `^${body}$` : `^(?:.*/)?${body}$`) });
  }
  return rules;
}

/** Whether `rel` (relative to the root, `/`-separated) is ignored by `rules`; the last matching rule wins. */
export function ignored(rules: readonly Rule[], rel: string, isDir: boolean): boolean {
  let out = false;
  for (const r of rules) {
    if (r.dirOnly && !isDir) continue;
    let sub = rel;
    if (r.base !== '') {
      if (!rel.startsWith(`${r.base}/`)) continue;
      sub = rel.slice(r.base.length + 1);
    }
    if (r.re.test(sub)) out = !r.negate;
  }
  return out;
}

export interface Collected {
  /** Files to zip, relative to the root with `/` separators, sorted. */
  files: string[];
  /** Symlinks and special files, which are never zipped. */
  skipped: string[];
}

/** Walks `root` and returns the files a context zip should hold. */
export function collectFiles(root: string, excludes: readonly string[] = DEFAULT_EXCLUDES): Collected {
  const files: string[] = [];
  const skipped: string[] = [];
  const skip = new Set(excludes);
  const walk = (rel: string, inherited: Rule[]) => {
    const dir = rel === '' ? root : join(root, ...rel.split('/'));
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    let rules = inherited;
    if (entries.some((e) => e.name === '.gitignore' && e.isFile())) {
      rules = [...inherited, ...parseGitignore(readFileSync(join(dir, '.gitignore'), 'utf8'), rel)];
    }
    for (const e of entries) {
      const path = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (skip.has(e.name) || ignored(rules, path, true)) continue;
        walk(path, rules);
      } else if (e.isFile()) {
        if (!ignored(rules, path, false)) files.push(path);
      } else if (!ignored(rules, path, false)) {
        skipped.push(path);
      }
    }
  };
  walk('', []);
  return { files, skipped };
}
