// The module boundary check behind src/boundaries.test.ts (docs/architecture.md). `check` reads every file
// under a source root and reports what breaks the rules; the test holds the tables and the allowlist.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { badForm, filesUnder, relativeImports, resolve } from './imports.ts';

export type Rules = {
  /** Which domains each domain may import. agents may import request only through request/vocab.ts. */
  may: Record<string, string[]>;
  /** Path (a file, or a directory ending in `/`) → domain, for production files not under <root>/<domain>/. */
  domain: Record<string, string>;
  /** Test helpers not under a testing/ or fixtures/ directory or e2e/. */
  testHelpers: string[];
};

export type Report = {
  /** Production files with no domain. */
  unmapped: string[];
  /** `domain` keys that match no production file. */
  unused: string[];
  /** `domain` keys that say what a shorter key or the file's directory already says. */
  redundant: string[];
  /** Imports that break the specifier form or name no file. */
  badImports: string[];
  /** `from -> to: rule`. */
  violations: string[];
};

export function check(root: string, rules: Rules): Report {
  const files = filesUnder(root).map((f) => posix.relative(root.split('\\').join('/'), f));
  const isTest = (f: string) => /\.test\.ts$|(^|\/)(testing|fixtures)\/|^e2e\//.test(f) || rules.testHelpers.includes(f);
  const prodFiles = files.filter((f) => f.endsWith('.ts') && !isTest(f));
  const keyOf = (f: string, keys = Object.keys(rules.domain)) =>
    keys.filter((k) => f === k || (k.endsWith('/') && f.startsWith(k))).sort((a, b) => b.length - a.length)[0];
  const domainOf = (f: string, keys?: string[]): string | undefined => {
    const k = keyOf(f, keys), top = f.split('/')[0]!;
    return k !== undefined ? rules.domain[k] : top in rules.may && f.includes('/') ? top : undefined;
  };
  const used = new Set(prodFiles.map((f) => keyOf(f)));
  const keys = Object.keys(rules.domain);

  const badImports: string[] = [], edges: [string, string][] = [];
  for (const from of files.filter((f) => f.endsWith('.ts'))) {
    for (const { spec } of relativeImports(readFileSync(join(root, from), 'utf8'))) {
      const to = resolve(from, spec), bad = badForm(spec) ?? (existsSync(join(root, to)) ? undefined : `${spec}: no such file`);
      if (bad) badImports.push(`${from}: ${bad}`);
      else if (!to.startsWith('../') && !isTest(from)) edges.push([from, to]);
    }
  }

  const dirs = edges.map(([a, b]): [string, string] => [dirname(a), dirname(b)]).filter(([a, b]) => a !== b);
  const found = new Set<string>();
  for (const [from, to] of edges) {
    const add = (rule: string) => found.add(`${from} -> ${to}: ${rule}`);
    if (isTest(to)) add('test code');
    if (onCycle(edges, from, to)) add('file cycle');
    if (dirname(from) !== dirname(to) && onCycle(dirs, dirname(from), dirname(to))) add('directory cycle');
    const [d, e] = [domainOf(from), domainOf(to)];
    if (d === undefined || e === undefined || d === e || isTest(to)) continue; // unmapped files are reported above
    const vocab = d === 'agents' && to === 'request/vocab.ts';
    if (!rules.may[d]?.includes(e) || (d === 'agents' && e === 'request' && !vocab)) add(`${d} may not import ${e}`);
    else if (!vocab && to !== `${e}/index.ts`) add(`not via ${e}/index.ts`);
  }

  return {
    unmapped: prodFiles.filter((f) => domainOf(f) === undefined),
    unused: keys.filter((k) => !used.has(k)),
    redundant: keys.filter((k) => domainOf(k, keys.filter((o) => o !== k)) === rules.domain[k]),
    badImports,
    violations: [...found],
  };
}

/** Whether `to` reaches `from` along `edges`, so that the edge from → to is on a cycle. */
function onCycle(edges: [string, string][], from: string, to: string): boolean {
  const seen = new Set<string>(), todo = [to];
  for (let n = todo.pop(); n !== undefined; n = todo.pop()) {
    if (n === from) return true;
    if (!seen.has(n)) seen.add(n), todo.push(...edges.filter(([a]) => a === n).map(([, b]) => b));
  }
  return false;
}
