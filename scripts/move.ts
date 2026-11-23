// Moves files and rewrites every relative import that points at them, for the module refactor
// (docs/architecture.md). Run from the repo root:
//
//   node scripts/move.ts FROM TO [FROM TO ...]
//
// FROM and TO are repo-relative paths. A file moves with its tests: `x.test.ts`, `x.<anything>.test.ts` and
// `x-<anything>.test.ts` beside it, unless a longer source name in the same directory claims the test
// (`x-y.test.ts` stays with `x-y.ts`). A directory moves everything in it. Imports are rewritten in every .ts
// file under src/ and scripts/, both in the moved files and in those importing them, and src/boundaries.test.ts
// gets the new paths in its DOMAIN table and ALLOWED list. Every relative import must name an existing file
// with its .ts or .json extension (scripts/imports.ts); the script stops, before moving anything, on any that
// does not, or when two files would land on the same path.
//
// Running the same moves again finishes an interrupted run (tests left behind, imports still pointing at an
// old path or still relative to a moved file's old directory) and otherwise changes nothing. Paths in plain
// strings (fixtures found through import.meta.dirname, package.json's bin, scripts/build.ts) are not rewritten:
// the script lists the files that still mention an old path.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, posix } from 'node:path';
import { badForm, filesUnder, relativeImports, resolve } from './imports.ts';

const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory();

/** The tests beside `stem` (a source path without `.ts`) that belong to it rather than to a longer source name. */
function testsOf(stem: string): string[] {
  const dir = dirname(stem), siblings = filesUnder(dir).filter((f) => dirname(f) === dir && f.endsWith('.ts'));
  const sources = siblings.filter((f) => !f.endsWith('.test.ts')).map((f) => f.replace(/\.ts$/, ''));
  const owns = (s: string, t: string) => t.startsWith(s) && /^([.-].*)?\.test\.ts$/.test(t.slice(s.length));
  return siblings.filter((t) => owns(stem, t) && !sources.some((s) => s.length > stem.length && owns(s, t)));
}

/** Old path → new path of every file the moves cover, whether moved already or not. */
function plan(pairs: [string, string][]): Map<string, string> {
  const all = new Map<string, string>();
  const add = (from: string, to: string) => {
    if (all.has(from) && all.get(from) !== to) throw new Error(`${from} would move to both ${all.get(from)} and ${to}`);
    all.set(from, to);
  };
  // A file at its new path whose old path is gone was moved by an earlier run.
  const movedBefore = (from: string, to: string) => !existsSync(from) && add(from, to);
  for (const [from, to] of pairs) {
    if (!existsSync(from) && !existsSync(to)) throw new Error(`${from} does not exist`);
    if (isDir(from) || isDir(to)) {
      for (const f of filesUnder(from)) add(f, posix.join(to, posix.relative(from, f)));
      for (const f of filesUnder(to)) movedBefore(posix.join(from, posix.relative(to, f)), f);
      continue;
    }
    add(from, to);
    // Tests beside the source, and those an earlier run already moved beside the target.
    const [s, o] = [from, to].map((p) => p.replace(/\.ts$/, '')) as [string, string];
    for (const t of testsOf(s)) add(t, o + t.slice(s.length));
    for (const t of testsOf(o)) movedBefore(s + t.slice(o.length), t);
  }
  const targets = new Map<string, string>();
  for (const [from, to] of all) {
    if (targets.has(to)) throw new Error(`${targets.get(to)} and ${from} would both move to ${to}`);
    targets.set(to, from);
    if (existsSync(from) && existsSync(to)) throw new Error(`${to} exists (moving ${from})`);
  }
  return all;
}

/** `text` (of the file now at `self`) with each relative import re-pointed for `all`. */
function rewrite(text: string, self: string, all: Map<string, string>, oldSelf: string | undefined): string {
  const done = (p: string) => all.get(p) ?? p;
  const exists = (p: string) => existsSync(p) || all.has(p);
  let out = text;
  for (const { spec, at } of relativeImports(text).reverse()) {
    const bad = badForm(spec);
    if (bad) throw new Error(`${self}: ${bad}`);
    // Relative to where the file is now, or, if an earlier run moved it without rewriting, to where it was.
    let base = self, target = resolve(self, spec);
    if (!exists(target) && oldSelf !== undefined && exists(resolve(oldSelf, spec))) base = oldSelf, target = resolve(oldSelf, spec);
    if (!exists(target)) throw new Error(`${self}: ${spec}: no such file`);
    const newSelf = done(self);
    if (done(target) === target && newSelf === self && base === self) continue;
    let next = posix.relative(dirname(newSelf), done(target));
    if (!next.startsWith('.')) next = `./${next}`;
    if (next !== spec) out = out.slice(0, at) + next + out.slice(at + spec.length);
  }
  return out;
}

/** The boundary test's DOMAIN keys and ALLOWED entries, which are paths relative to src/. */
function renameInBoundaries(text: string, all: Map<string, string>, pairs: [string, string][]): string {
  const dirKeys = pairs.filter(([f, t]) => isDir(f) || isDir(t)).map(([f, t]): [string, string] => [`${f}/`, `${t}/`]);
  for (const [from, to] of [...all, ...dirKeys]) {
    if (!from.startsWith('src/') || !to.startsWith('src/')) continue;
    const old = from.slice(4).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text.replace(new RegExp(`(?<=['\\s])${old}(?=['\\s:])`, 'g'), to.slice(4));
  }
  return text;
}

function main(args: string[]): void {
  if (args.length === 0 || args.length % 2 !== 0) throw new Error('usage: node scripts/move.ts FROM TO [FROM TO ...]');
  const pairs = Array.from({ length: args.length / 2 }, (_, i): [string, string] =>
    [posix.normalize(args[2 * i]!).replace(/\/$/, ''), posix.normalize(args[2 * i + 1]!).replace(/\/$/, '')]);
  const all = plan(pairs);
  const todo = [...all].filter(([from]) => existsSync(from));
  const moved = new Map([...all].filter(([from]) => !existsSync(from)).map(([from, to]) => [to, from]));
  const edits = new Map<string, string>();
  for (const f of [...filesUnder('src'), ...filesUnder('scripts')].filter((f) => f.endsWith('.ts'))) {
    const text = readFileSync(f, 'utf8');
    let next = rewrite(text, f, all, moved.get(f));
    if (f === 'src/boundaries.test.ts') next = renameInBoundaries(next, all, pairs);
    if (next !== text) edits.set(all.get(f) ?? f, next);
  }
  if (todo.length === 0 && edits.size === 0) return console.log('nothing to move');
  for (const [from, to] of todo) {
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
    console.log(`${from} -> ${to}`);
    for (let d = dirname(from); d !== '.' && readdirSync(d).length === 0; d = dirname(d)) rmdirSync(d);
  }
  for (const [f, text] of edits) writeFileSync(f, text);
  console.log(`rewrote imports in ${edits.size} files`);
  for (const [from] of todo) {
    const r = spawnSync('git', ['grep', '-n', '-F', from.replace(/^src\//, '')], { encoding: 'utf8' });
    if (r.stdout) console.log(`still mentions ${from}:\n${r.stdout}`);
  }
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`move: ${(e as Error).message}`);
    process.exit(1);
  }
}
