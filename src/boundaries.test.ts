// The module boundaries of docs/architecture.md, checked on every relative import under src/ by
// scripts/boundaries.ts. A file under src/<domain>/ is in that domain; DOMAIN placed the files not yet moved
// there, and is empty since every file is in its domain (P7). ALLOWED held the violations still to fix: a new
// one fails, and so does an entry that no longer occurs, so the list only shrank, and it is empty now (P7).
// Tests, test helpers and e2e/ may import anything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { check } from '../scripts/boundaries.ts';

const MAY: Record<string, string[]> = {
  lib: [], gh: ['lib'], request: ['lib', 'gh'], agents: ['lib', 'request'], setup: ['lib', 'agents'],
  server: ['lib', 'gh', 'request', 'agents', 'setup'], cli: ['lib', 'gh', 'request', 'agents', 'setup', 'server'],
};
const DOMAIN: Record<string, string> = {};
const TEST_HELPERS = ['lib/git-fixture.ts', 'lib/zip-fixture.ts'];
/** Today's violations, `from -> to: rule`. Only ever remove entries. */
const ALLOWED = new Set<string>([]);

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
