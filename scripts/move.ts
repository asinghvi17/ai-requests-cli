// Moves files and rewrites every relative import that points at them, for the module refactor
// (docs/architecture.md). Run from the repo root:
//
//   node scripts/move.ts FROM TO [FROM TO ...]
//
// FROM and TO are repo-relative paths. A file moves with its tests beside it (`x.ts` takes `x.test.ts` and
// `x.*.test.ts`); a directory moves everything in it. Imports are rewritten in every .ts file under src/ and
// scripts/, both in the moved files and in those importing them, and src/boundaries.test.ts gets the new
// paths in its DOMAIN table and ALLOWED list. A pair whose FROM is gone and TO exists was already moved and is
// skipped, so running the same moves again changes nothing. Paths in plain strings (fixtures found through
// import.meta.dirname, package.json's bin, scripts/build.ts) are not rewritten: the script lists the files that
// still mention an old path.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, posix } from 'node:path';
import ts from 'typescript';

const files = (dir: string): string[] => existsSync(dir)
  ? readdirSync(dir, { recursive: true, encoding: 'utf8' }).map((f) => posix.join(dir, f.split('\\').join('/')))
    .filter((f) => statSync(f).isFile())
  : [];

/** FROM → TO for every file still to move: directories expanded, tests beside a file added. */
function plan(pairs: [string, string][]): Map<string, string> {
  const moves = new Map<string, string>();
  for (const [from, to] of pairs) {
    if (!existsSync(from)) {
      if (existsSync(to)) continue;
      throw new Error(`${from} does not exist`);
    }
    if (statSync(from).isDirectory()) {
      for (const f of files(from)) moves.set(f, posix.join(to, posix.relative(from, f)));
      continue;
    }
    moves.set(from, to);
    const [stem, toStem] = [from.replace(/\.ts$/, ''), to.replace(/\.ts$/, '')];
    for (const f of files(dirname(from))) {
      const kind = f.startsWith(`${stem}.`) && /^\.([\w-]+\.)?test\.ts$/.exec(f.slice(stem.length));
      if (kind) moves.set(f, toStem + f.slice(stem.length));
    }
  }
  for (const [from, to] of moves) if (existsSync(to)) throw new Error(`${to} exists (moving ${from})`);
  return moves;
}

/** `text` (of the file at `self`) with each relative import re-pointed for `moves`. */
function rewrite(text: string, self: string, moves: Map<string, string>): string {
  const newSelf = moves.get(self) ?? self;
  let out = text;
  for (const { fileName, pos } of ts.preProcessFile(text, true, true).importedFiles.reverse()) {
    if (!fileName.startsWith('.')) continue;
    const target = posix.normalize(posix.join(dirname(self), fileName));
    const newTarget = moves.get(target) ?? target;
    if (newTarget === target && newSelf === self) continue;
    let spec = posix.relative(dirname(newSelf), newTarget);
    if (!spec.startsWith('.')) spec = `./${spec}`;
    const at = out.indexOf(fileName, pos);
    out = out.slice(0, at) + spec + out.slice(at + fileName.length);
  }
  return out;
}

/** The boundary test's DOMAIN keys and ALLOWED entries, which are paths relative to src/. */
function renameInBoundaries(text: string, moves: Map<string, string>): string {
  for (const [from, to] of moves) {
    if (!from.startsWith('src/') || !to.startsWith('src/')) continue;
    const old = from.slice(4).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text.replace(new RegExp(`(?<=['\\s])${old}(?=['\\s:])`, 'g'), to.slice(4));
  }
  return text;
}

function main(args: string[]): void {
  if (args.length === 0 || args.length % 2 !== 0) throw new Error('usage: node scripts/move.ts FROM TO [FROM TO ...]');
  const pairs = Array.from({ length: args.length / 2 }, (_, i): [string, string] =>
    [posix.normalize(args[2 * i]!), posix.normalize(args[2 * i + 1]!)]);
  const moves = plan(pairs);
  if (moves.size === 0) return console.log('nothing to move');
  const edits = new Map<string, string>();
  for (const f of [...files('src'), ...files('scripts')].filter((f) => f.endsWith('.ts'))) {
    const text = readFileSync(f, 'utf8');
    let next = rewrite(text, f, moves);
    if (f === 'src/boundaries.test.ts') next = renameInBoundaries(next, moves);
    if (next !== text) edits.set(moves.get(f) ?? f, next);
  }
  for (const [from, to] of moves) {
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
    console.log(`${from} -> ${to}`);
    for (let d = dirname(from); d !== '.' && readdirSync(d).length === 0; d = dirname(d)) rmdirSync(d);
  }
  for (const [f, text] of edits) writeFileSync(f, text);
  console.log(`rewrote imports in ${edits.size} files`);
  for (const from of moves.keys()) {
    const r = spawnSync('git', ['grep', '-n', '-F', from.replace(/^src\//, '')], { encoding: 'utf8' });
    if (r.stdout) console.log(`still mentions ${from}:\n${r.stdout}`);
  }
}

if (import.meta.main) main(process.argv.slice(2));
