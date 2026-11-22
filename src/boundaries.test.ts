// The module boundaries of docs/architecture.md, checked on every relative import under src/. A file under
// src/<domain>/ is in that domain; DOMAIN places the files not yet moved there, and shrinks as later phases
// move them (scripts/move.ts). ALLOWED holds today's violations: a new one fails, and so does an entry that no
// longer occurs, so the list only shrinks. Tests and test helpers may import anything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import ts from 'typescript';

/** Which domains each domain may import. agents may import request only through request/vocab.ts. */
const MAY: Record<string, string[]> = {
  lib: [], gh: ['lib'], request: ['lib', 'gh'], agents: ['lib', 'request'], setup: ['lib', 'agents'],
  server: ['lib', 'gh', 'request', 'agents', 'setup'], cli: ['lib', 'gh', 'request', 'agents', 'setup', 'server'],
};
/** Path (a file, or a directory ending in `/`) → domain, for production files not under src/<domain>/. */
const DOMAIN: Record<string, string> = {
  'toml.ts': 'lib', 'version.ts': 'lib', 'usage/lock.ts': 'lib', 'usage/run.ts': 'lib', 'serve/zipout.ts': 'lib',
  'submit/zipwrite.ts': 'lib', 'workspace/exec.ts': 'lib', 'workspace/git.ts': 'lib', 'workspace/zip.ts': 'lib',
  'spec/': 'request', 'requester/': 'request', 'submit/': 'request', 'sweep/': 'request', 'skill/': 'request',
  'claim/text.ts': 'request', 'claim/trust.ts': 'request', 'workspace/context.ts': 'request',
  'usage/': 'agents', 'serve/agent.ts': 'agents', 'serve/prompts.ts': 'agents', 'serve/trust.ts': 'agents',
  'workspace/launch.ts': 'agents', 'workspace/task.ts': 'agents',
  'config.ts': 'setup', 'serve/preflight.ts': 'setup', 'cli/firstrun.ts': 'setup',
  'claim/': 'server', 'match/': 'server', 'serve/': 'server', 'tmux/': 'server', 'workspace/': 'server',
};
/** Test helpers not yet under a testing/ or fixtures/ directory. */
const TEST_HELPERS = ['gh/fake.ts', 'gh/releases-fake.ts', 'serve/fake-gh.ts', 'requester/fixture.ts',
  'submit/fixture.ts', 'workspace/git-fixture.ts', 'workspace/zip-fixture.ts'];
/** Today's violations, `from -> to: rule`. Only ever remove entries. */
const ALLOWED = new Set<string>([
  'claim/claim.ts -> claim/text.ts: not via request/index.ts',
  'claim/claim.ts -> claim/trust.ts: not via request/index.ts',
  'claim/claim.ts -> gh/gh.ts: not via gh/index.ts',
  'claim/claim.ts -> gh/issues.ts: not via gh/index.ts',
  'claim/claim.ts -> spec/frontmatter.ts: not via request/index.ts',
  'claim/claim.ts -> spec/lint.ts: not via request/index.ts',
  'claim/claim.ts -> spec/markers.ts: not via request/index.ts',
  'claim/claim.ts -> workspace/state.ts: directory cycle',
  'claim/repos.ts -> claim/text.ts: not via request/index.ts',
  'claim/repos.ts -> gh/issues.ts: not via gh/index.ts',
  'claim/repos.ts -> spec/frontmatter.ts: not via request/index.ts',
  'claim/repos.ts -> workspace/git.ts: directory cycle',
  'claim/repos.ts -> workspace/git.ts: not via lib/index.ts',
  'claim/repos.ts -> workspace/state.ts: directory cycle',
  'claim/trust.ts -> gh/issues.ts: not via gh/index.ts',
  'cli/cancel.ts -> cli/main.ts: file cycle',
  'cli/cancel.ts -> cli/requests.ts: file cycle',
  'cli/cancel.ts -> requester/cancel.ts: not via request/index.ts',
  'cli/claim.ts -> claim/claim.ts: not via server/index.ts',
  'cli/claim.ts -> cli/main.ts: file cycle',
  'cli/claim.ts -> cli/requests.ts: file cycle',
  'cli/fetch.ts -> cli/main.ts: file cycle',
  'cli/fetch.ts -> cli/requests.ts: file cycle',
  'cli/fetch.ts -> requester/fetch.ts: not via request/index.ts',
  'cli/firstrun.ts -> cli/main.ts: file cycle',
  'cli/firstrun.ts -> cli/main.ts: setup may not import cli',
  'cli/firstrun.ts -> cli/requests.ts: file cycle',
  'cli/firstrun.ts -> cli/requests.ts: setup may not import cli',
  'cli/firstrun.ts -> serve/trust.ts: not via agents/index.ts',
  'cli/firstrun.ts -> usage/index.ts: not via agents/index.ts',
  'cli/jobs.ts -> cli/firstrun.ts: file cycle',
  'cli/jobs.ts -> cli/firstrun.ts: not via setup/index.ts',
  'cli/jobs.ts -> cli/main.ts: file cycle',
  'cli/jobs.ts -> cli/requests.ts: file cycle',
  'cli/jobs.ts -> config.ts: not via setup/index.ts',
  'cli/jobs.ts -> serve/context.ts: not via server/index.ts',
  'cli/jobs.ts -> serve/jobs.ts: not via server/index.ts',
  'cli/jobs.ts -> serve/preflight.ts: not via setup/index.ts',
  'cli/jobs.ts -> serve/server.ts: not via server/index.ts',
  'cli/jobs.ts -> serve/state.ts: not via server/index.ts',
  'cli/jobs.ts -> tmux/env.ts: not via server/index.ts',
  'cli/jobs.ts -> tmux/tmux.ts: not via server/index.ts',
  'cli/jobs.ts -> usage/index.ts: not via agents/index.ts',
  'cli/jobs.ts -> workspace/state.ts: not via server/index.ts',
  'cli/lint.ts -> cli/main.ts: file cycle',
  'cli/lint.ts -> spec/lint.ts: not via request/index.ts',
  'cli/lint.ts -> submit/submit.ts: not via request/index.ts',
  'cli/main.ts -> cli/cancel.ts: file cycle',
  'cli/main.ts -> cli/claim.ts: file cycle',
  'cli/main.ts -> cli/fetch.ts: file cycle',
  'cli/main.ts -> cli/jobs.ts: file cycle',
  'cli/main.ts -> cli/lint.ts: file cycle',
  'cli/main.ts -> cli/release.ts: file cycle',
  'cli/main.ts -> cli/requests.ts: file cycle',
  'cli/main.ts -> cli/retry.ts: file cycle',
  'cli/main.ts -> cli/setup.ts: file cycle',
  'cli/main.ts -> cli/skill.ts: file cycle',
  'cli/main.ts -> cli/status.ts: file cycle',
  'cli/main.ts -> cli/submit.ts: file cycle',
  'cli/main.ts -> cli/sweep.ts: file cycle',
  'cli/main.ts -> cli/wait.ts: file cycle',
  'cli/main.ts -> config.ts: not via setup/index.ts',
  'cli/main.ts -> gh/gh.ts: not via gh/index.ts',
  'cli/main.ts -> usage/index.ts: not via agents/index.ts',
  'cli/main.ts -> version.ts: not via lib/index.ts',
  'cli/release.ts -> claim/claim.ts: not via server/index.ts',
  'cli/release.ts -> cli/main.ts: file cycle',
  'cli/release.ts -> cli/requests.ts: file cycle',
  'cli/requests.ts -> cli/main.ts: file cycle',
  'cli/requests.ts -> config.ts: not via setup/index.ts',
  'cli/requests.ts -> gh/issues.ts: not via gh/index.ts',
  'cli/retry.ts -> cli/main.ts: file cycle',
  'cli/retry.ts -> cli/requests.ts: file cycle',
  'cli/retry.ts -> requester/retry.ts: not via request/index.ts',
  'cli/retry.ts -> spec/frontmatter.ts: not via request/index.ts',
  'cli/setup.ts -> cli/main.ts: file cycle',
  'cli/setup.ts -> cli/requests.ts: file cycle',
  'cli/setup.ts -> workspace/setup.ts: not via server/index.ts',
  'cli/skill.ts -> cli/firstrun.ts: file cycle',
  'cli/skill.ts -> cli/firstrun.ts: not via setup/index.ts',
  'cli/skill.ts -> cli/main.ts: file cycle',
  'cli/skill.ts -> cli/requests.ts: file cycle',
  'cli/skill.ts -> skill/install.ts: not via request/index.ts',
  'cli/status.ts -> cli/main.ts: file cycle',
  'cli/status.ts -> cli/requests.ts: file cycle',
  'cli/status.ts -> requester/status.ts: not via request/index.ts',
  'cli/status.ts -> workspace/state.ts: not via server/index.ts',
  'cli/submit.ts -> cli/lint.ts: file cycle',
  'cli/submit.ts -> cli/main.ts: file cycle',
  'cli/submit.ts -> cli/requests.ts: file cycle',
  'cli/submit.ts -> gh/releases.ts: not via gh/index.ts',
  'cli/submit.ts -> spec/frontmatter.ts: not via request/index.ts',
  'cli/submit.ts -> submit/collect.ts: not via request/index.ts',
  'cli/submit.ts -> submit/submit.ts: not via request/index.ts',
  'cli/sweep.ts -> claim/trust.ts: not via request/index.ts',
  'cli/sweep.ts -> cli/main.ts: file cycle',
  'cli/sweep.ts -> cli/submit.ts: file cycle',
  'cli/sweep.ts -> gh/releases.ts: not via gh/index.ts',
  'cli/sweep.ts -> sweep/sweep.ts: not via request/index.ts',
  'cli/wait.ts -> cli/main.ts: file cycle',
  'cli/wait.ts -> cli/requests.ts: file cycle',
  'cli/wait.ts -> requester/status.ts: not via request/index.ts',
  'cli/wait.ts -> spec/frontmatter.ts: not via request/index.ts',
  'config.ts -> toml.ts: not via lib/index.ts',
  'match/match.ts -> spec/frontmatter.ts: not via request/index.ts',
  'match/match.ts -> usage/prices.ts: not via agents/index.ts',
  'match/match.ts -> usage/types.ts: not via agents/index.ts',
  'requester/cancel.ts -> claim/claim.ts: request may not import server',
  'requester/cancel.ts -> gh/gh.ts: not via gh/index.ts',
  'requester/cancel.ts -> gh/issues.ts: not via gh/index.ts',
  'requester/fetch.ts -> gh/gh.ts: not via gh/index.ts',
  'requester/fetch.ts -> gh/issues.ts: not via gh/index.ts',
  'requester/fetch.ts -> workspace/exec.ts: not via lib/index.ts',
  'requester/fetch.ts -> workspace/git.ts: not via lib/index.ts',
  'requester/retry.ts -> claim/claim.ts: request may not import server',
  'requester/retry.ts -> gh/gh.ts: not via gh/index.ts',
  'requester/retry.ts -> gh/issues.ts: not via gh/index.ts',
  'requester/status.ts -> claim/claim.ts: request may not import server',
  'requester/status.ts -> gh/gh.ts: not via gh/index.ts',
  'requester/status.ts -> gh/issues.ts: not via gh/index.ts',
  'serve/agent.ts -> config.ts: agents may not import setup',
  'serve/context.ts -> claim/trust.ts: not via request/index.ts',
  'serve/context.ts -> config.ts: not via setup/index.ts',
  'serve/context.ts -> gh/gh.ts: not via gh/index.ts',
  'serve/context.ts -> gh/issues.ts: not via gh/index.ts',
  'serve/context.ts -> gh/releases.ts: not via gh/index.ts',
  'serve/context.ts -> serve/preflight.ts: not via setup/index.ts',
  'serve/context.ts -> usage/index.ts: not via agents/index.ts',
  'serve/context.ts -> usage/types.ts: not via agents/index.ts',
  'serve/context.ts -> workspace/context.ts: not via request/index.ts',
  'serve/deliver.ts -> claim/text.ts: not via request/index.ts',
  'serve/deliver.ts -> serve/zipout.ts: not via lib/index.ts',
  'serve/deliver.ts -> spec/frontmatter.ts: not via request/index.ts',
  'serve/deliver.ts -> spec/markers.ts: not via request/index.ts',
  'serve/deliver.ts -> workspace/context.ts: not via request/index.ts',
  'serve/deliver.ts -> workspace/git.ts: not via lib/index.ts',
  'serve/deliver.ts -> workspace/task.ts: not via agents/index.ts',
  'serve/github.ts -> gh/gh.ts: not via gh/index.ts',
  'serve/github.ts -> gh/issues.ts: not via gh/index.ts',
  'serve/jobs.ts -> claim/text.ts: not via request/index.ts',
  'serve/jobs.ts -> claim/trust.ts: not via request/index.ts',
  'serve/jobs.ts -> config.ts: not via setup/index.ts',
  'serve/jobs.ts -> serve/agent.ts: not via agents/index.ts',
  'serve/jobs.ts -> spec/frontmatter.ts: not via request/index.ts',
  'serve/jobs.ts -> spec/lint.ts: not via request/index.ts',
  'serve/jobs.ts -> spec/markers.ts: not via request/index.ts',
  'serve/jobs.ts -> usage/index.ts: not via agents/index.ts',
  'serve/jobs.ts -> usage/manual.ts: not via agents/index.ts',
  'serve/jobs.ts -> usage/prices.ts: not via agents/index.ts',
  'serve/jobs.ts -> usage/spent.ts: not via agents/index.ts',
  'serve/jobs.ts -> usage/types.ts: not via agents/index.ts',
  'serve/jobs.ts -> workspace/launch.ts: not via agents/index.ts',
  'serve/jobs.ts -> workspace/task.ts: not via agents/index.ts',
  'serve/preflight.ts -> usage/types.ts: not via agents/index.ts',
  'serve/server.ts -> claim/text.ts: not via request/index.ts',
  'serve/server.ts -> claim/trust.ts: not via request/index.ts',
  'serve/server.ts -> config.ts: not via setup/index.ts',
  'serve/server.ts -> serve/prompts.ts: not via agents/index.ts',
  'serve/server.ts -> spec/lint.ts: not via request/index.ts',
  'serve/server.ts -> spec/markers.ts: not via request/index.ts',
  'serve/server.ts -> sweep/sweep.ts: not via request/index.ts',
  'serve/server.ts -> usage/prices.ts: not via agents/index.ts',
  'serve/server.ts -> usage/types.ts: not via agents/index.ts',
  'skill/install.ts -> version.ts: not via lib/index.ts',
  'submit/submit.ts -> gh/releases.ts: not via gh/index.ts',
  'submit/submit.ts -> submit/zipwrite.ts: not via lib/index.ts',
  'sweep/sweep.ts -> gh/issues.ts: not via gh/index.ts',
  'sweep/sweep.ts -> gh/releases.ts: not via gh/index.ts',
  'tmux/tmux.ts -> gh/issues.ts: not via gh/index.ts',
  'usage/cache.ts -> usage/lock.ts: not via lib/index.ts',
  'usage/claude.ts -> usage/run.ts: not via lib/index.ts',
  'usage/codex.ts -> usage/run.ts: not via lib/index.ts',
  'usage/codex.ts -> version.ts: not via lib/index.ts',
  'usage/index.ts -> usage/run.ts: not via lib/index.ts',
  'usage/manual.ts -> usage/lock.ts: not via lib/index.ts',
  'workspace/context.ts -> gh/gh.ts: not via gh/index.ts',
  'workspace/context.ts -> workspace/zip.ts: not via lib/index.ts',
  'workspace/git.ts -> spec/frontmatter.ts: lib may not import request',
  'workspace/launch.ts -> workspace/state.ts: agents may not import server',
  'workspace/setup.ts -> claim/claim.ts: directory cycle',
  'workspace/setup.ts -> claim/text.ts: directory cycle',
  'workspace/setup.ts -> claim/text.ts: not via request/index.ts',
  'workspace/setup.ts -> claim/trust.ts: directory cycle',
  'workspace/setup.ts -> claim/trust.ts: not via request/index.ts',
  'workspace/setup.ts -> gh/gh.ts: not via gh/index.ts',
  'workspace/setup.ts -> gh/issues.ts: not via gh/index.ts',
  'workspace/setup.ts -> spec/frontmatter.ts: not via request/index.ts',
  'workspace/setup.ts -> spec/lint.ts: not via request/index.ts',
  'workspace/setup.ts -> spec/markers.ts: not via request/index.ts',
  'workspace/setup.ts -> workspace/context.ts: not via request/index.ts',
  'workspace/setup.ts -> workspace/exec.ts: not via lib/index.ts',
  'workspace/setup.ts -> workspace/git.ts: not via lib/index.ts',
  'workspace/setup.ts -> workspace/launch.ts: not via agents/index.ts',
  'workspace/setup.ts -> workspace/task.ts: not via agents/index.ts',
  'workspace/state.ts -> gh/issues.ts: not via gh/index.ts',
  'workspace/state.ts -> usage/types.ts: not via agents/index.ts',
  'workspace/task.ts -> spec/frontmatter.ts: agents may not import request',
  'workspace/task.ts -> workspace/state.ts: agents may not import server',
]);

const src = import.meta.dirname;
const files = readdirSync(src, { recursive: true, encoding: 'utf8' }).map((f) => f.split('\\').join('/'))
  .filter((f) => f.endsWith('.ts')).sort();
const isTest = (f: string) => /\.test\.ts$|(^|\/)(testing|fixtures)\//.test(f) || TEST_HELPERS.includes(f);
const prodFiles = files.filter((f) => !isTest(f));
const tableKey = (f: string) => Object.keys(DOMAIN).filter((k) => f === k || (k.endsWith('/') && f.startsWith(k)))
  .sort((a, b) => b.length - a.length)[0];
const domainOf = (f: string) => DOMAIN[tableKey(f) ?? ''] ?? (f.split('/')[0]! in MAY ? f.split('/')[0]! : undefined);

/** Every relative import under src/ that stays inside src/, as [from, to] paths relative to src/. */
const imports = files.flatMap((from) => ts.preProcessFile(readFileSync(join(src, from), 'utf8'), true, true)
  .importedFiles.filter((i) => i.fileName.startsWith('.'))
  .map((i): [string, string] => [from, posix.normalize(posix.join(dirname(from), i.fileName))])
  .filter(([, to]) => !to.startsWith('../')));

/** Whether `to` reaches `from` along `edges`, so that the edge from → to is on a cycle. */
function onCycle(edges: [string, string][], from: string, to: string): boolean {
  const seen = new Set<string>(), todo = [to];
  for (let n = todo.pop(); n !== undefined; n = todo.pop()) {
    if (n === from) return true;
    if (!seen.has(n)) seen.add(n), todo.push(...edges.filter(([a]) => a === n).map(([, b]) => b));
  }
  return false;
}

function violations(): string[] {
  const prod = imports.filter(([from]) => !isTest(from));
  const dirs = prod.map(([a, b]): [string, string] => [dirname(a), dirname(b)]).filter(([a, b]) => a !== b);
  const found = new Set<string>();
  for (const [from, to] of prod) {
    const add = (rule: string) => found.add(`${from} -> ${to}: ${rule}`);
    if (isTest(to)) add('test code');
    if (onCycle(prod, from, to)) add('file cycle');
    if (dirname(from) !== dirname(to) && onCycle(dirs, dirname(from), dirname(to))) add('directory cycle');
    const [d, e] = [domainOf(from)!, domainOf(to)!];
    const vocab = d === 'agents' && to === 'request/vocab.ts';
    if (d === e || isTest(to)) continue;
    if (!MAY[d]!.includes(e) || (d === 'agents' && e === 'request' && !vocab)) add(`${d} may not import ${e}`);
    else if (!vocab && to !== `${e}/index.ts`) add(`not via ${e}/index.ts`);
  }
  return [...found];
}

test('every production file has a domain, and DOMAIN has no stale entries', () => {
  assert.deepEqual(prodFiles.filter((f) => !domainOf(f)), [], 'add these to DOMAIN');
  const used = new Set(prodFiles.map(tableKey));
  assert.deepEqual(Object.keys(DOMAIN).filter((k) => !used.has(k)), [], 'these DOMAIN keys match no file');
  assert.deepEqual(Object.keys(DOMAIN).filter((k) => k.split('/')[0] === DOMAIN[k]), [],
    'these files are in place: remove them from DOMAIN');
});

test('imports keep to the module boundaries (docs/architecture.md)', () => {
  const found = violations();
  assert.deepEqual(found.filter((v) => !ALLOWED.has(v)), [], 'new boundary violations');
  assert.deepEqual([...ALLOWED].filter((v) => !found.includes(v)), [], 'fixed: remove these from ALLOWED');
});
