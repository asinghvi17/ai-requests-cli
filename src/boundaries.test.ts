// The module boundaries of docs/architecture.md, checked on every relative import under src/ by
// scripts/boundaries.ts. A file under src/<domain>/ is in that domain; DOMAIN places the files not yet moved
// there, and shrinks as later phases move them (scripts/move.ts). ALLOWED holds today's violations: a new one
// fails, and so does an entry that no longer occurs, so the list only shrinks. Tests, test helpers and e2e/
// may import anything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { check } from '../scripts/boundaries.ts';

const MAY: Record<string, string[]> = {
  lib: [], gh: ['lib'], request: ['lib', 'gh'], agents: ['lib', 'request'], setup: ['lib', 'agents'],
  server: ['lib', 'gh', 'request', 'agents', 'setup'], cli: ['lib', 'gh', 'request', 'agents', 'setup', 'server'],
};
const DOMAIN: Record<string, string> = {
  'config.ts': 'setup', 'serve/preflight.ts': 'setup', 'serve/hints.ts': 'setup', 'cli/firstrun.ts': 'setup',
  'claim/': 'server', 'match/': 'server', 'serve/': 'server', 'tmux/': 'server', 'workspace/': 'server',
};
const TEST_HELPERS = ['lib/git-fixture.ts', 'lib/zip-fixture.ts'];
/** Today's violations, `from -> to: rule`. Only ever remove entries. */
const ALLOWED = new Set<string>([
  'claim/claim.ts -> workspace/state.ts: directory cycle',
  'claim/repos.ts -> workspace/state.ts: directory cycle',
  'cli/claim.ts -> claim/claim.ts: not via server/index.ts',
  'cli/firstrun.ts -> cli/requests.ts: setup may not import cli',
  'cli/jobs.ts -> cli/firstrun.ts: not via setup/index.ts',
  'cli/jobs.ts -> serve/context.ts: not via server/index.ts',
  'cli/jobs.ts -> serve/jobs.ts: not via server/index.ts',
  'cli/jobs.ts -> serve/server.ts: not via server/index.ts',
  'cli/jobs.ts -> serve/state.ts: not via server/index.ts',
  'cli/jobs.ts -> tmux/env.ts: not via server/index.ts',
  'cli/jobs.ts -> tmux/tmux.ts: not via server/index.ts',
  'cli/jobs.ts -> workspace/state.ts: not via server/index.ts',
  'cli/main.ts -> config.ts: not via setup/index.ts',
  'cli/release.ts -> claim/claim.ts: not via server/index.ts',
  'cli/requests.ts -> config.ts: not via setup/index.ts',
  'cli/setup.ts -> workspace/setup.ts: not via server/index.ts',
  'cli/skill.ts -> cli/firstrun.ts: not via setup/index.ts',
  'serve/context.ts -> config.ts: not via setup/index.ts',
  'serve/context.ts -> serve/preflight.ts: not via setup/index.ts',
  'serve/jobs.ts -> config.ts: not via setup/index.ts',
  'serve/server.ts -> config.ts: not via setup/index.ts',
  'workspace/setup.ts -> claim/claim.ts: directory cycle',
]);

const report = check(import.meta.dirname, { may: MAY, domain: DOMAIN, testHelpers: TEST_HELPERS });

test('every production file has a domain, DOMAIN has no stale entries, and imports name their files', () => {
  const { unmapped, unused, redundant, badImports } = report;
  assert.deepEqual({ unmapped, unused, redundant, badImports }, { unmapped: [], unused: [], redundant: [], badImports: [] },
    'unmapped: add to DOMAIN; unused, redundant: remove from DOMAIN; badImports: fix the specifier');
});

test('imports keep to the module boundaries (docs/architecture.md)', () => {
  const added = report.violations.filter((v) => !ALLOWED.has(v));
  const fixed = [...ALLOWED].filter((v) => !report.violations.includes(v));
  assert.deepEqual({ added, fixed }, { added: [], fixed: [] }, 'added: fix the import; fixed: remove from ALLOWED');
});
