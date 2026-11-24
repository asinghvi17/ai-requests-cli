// Writing folder trust to Claude Code's state file (what `air serve` offers on a terminal).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../config.ts';
import { defaultPreflightDeps, formatPreflight, preflight, refusals } from '../serve/preflight.ts';
import { writeClaudeTrust } from './claude-trust.ts';

const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'air-trust-')));
  dirs.push(d);
  return d;
};

const state = {
  hasCompletedOnboarding: true,
  oauthAccount: { emailAddress: 'secret@example.com', accountUuid: 'u-1' },
  userID: 'abc',
  projects: {
    '/elsewhere': { allowedTools: ['Bash'], hasTrustDialogAccepted: true },
    '/w/air': { allowedTools: [], lastCost: 1.5, hasTrustDialogAccepted: false },
  },
  numStartups: 7,
};

test('writes only the one trust entry, keeping every other key, its order and format, and the file mode', () => {
  const home = tmp();
  const file = join(home, '.claude.json');
  writeFileSync(file, JSON.stringify(state, null, 2), { mode: 0o600 });
  chmodSync(file, 0o600);
  const root = join(home, 'air');
  assert.equal(writeClaudeTrust(file, root), root);
  const text = readFileSync(file, 'utf8');
  assert.equal(text, JSON.stringify({ ...state, projects: { ...state.projects, [root]: { hasTrustDialogAccepted: true } } }, null, 2));
  assert.equal(statSync(root).isDirectory(), true); // created, as `mkdir -p` in the manual fix would
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(home).sort(), ['.claude.json', 'air']); // no temp file left
  // Again: no change. A trailing newline is kept.
  writeFileSync(file, `${text}\n`);
  writeClaudeTrust(file, root);
  assert.equal(readFileSync(file, 'utf8'), `${text}\n`);
});

test('an entry Claude Code saved untrusted keeps its fields; a symlinked dir is keyed by its real path', () => {
  const home = tmp();
  const real = join(home, 'w', 'air');
  mkdirSync(real, { recursive: true });
  const projects = { '/elsewhere': state.projects['/elsewhere'], [real]: state.projects['/w/air'] };
  const file = join(home, '.claude.json');
  writeFileSync(file, JSON.stringify({ ...state, projects }));
  symlinkSync(real, join(home, 'air'));
  assert.equal(writeClaudeTrust(file, join(home, 'air')), real);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).projects, {
    '/elsewhere': state.projects['/elsewhere'],
    [real]: { allowedTools: [], lastCost: 1.5, hasTrustDialogAccepted: true },
  });
});

test('a symlinked state file stays a symlink, and its target gets the entry', () => {
  const home = tmp();
  const target = join(home, 'state', 'claude.json');
  mkdirSync(join(home, 'state'));
  writeFileSync(target, JSON.stringify({ hasCompletedOnboarding: true }));
  const link = join(home, '.claude.json');
  symlinkSync(target, link);
  writeClaudeTrust(link, join(home, 'air'));
  assert.equal(lstatSync(link).isSymbolicLink(), true);
  assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')), { hasCompletedOnboarding: true, projects: { [join(home, 'air')]: { hasTrustDialogAccepted: true } } });
  assert.deepEqual(readdirSync(join(home, 'state')), ['claude.json']);
});

test('a state file that is not a JSON object is left alone', () => {
  const home = tmp();
  const file = join(home, '.claude.json');
  for (const text of ['[]', '{"projects": ', 'null']) {
    writeFileSync(file, text);
    assert.throws(() => writeClaudeTrust(file, join(home, 'air')));
    assert.equal(readFileSync(file, 'utf8'), text);
    assert.deepEqual(readdirSync(home).filter((f) => f !== 'air'), ['.claude.json']);
  }
});

test('regression: a write Claude Code makes meanwhile is merged, not clobbered', () => {
  // Review finding: the file was read, merged and renamed over, losing whatever Claude Code wrote in between.
  const home = tmp();
  const file = join(home, '.claude.json');
  writeFileSync(file, JSON.stringify({ hasCompletedOnboarding: true, numStartups: 7 }, null, 2));
  let writes = 0;
  const key = writeClaudeTrust(file, join(home, 'air'), {
    beforeRename: () => { if (writes++ === 0) writeFileSync(file, JSON.stringify({ hasCompletedOnboarding: true, numStartups: 8, tipsHistory: { a: 1 } }, null, 2)); },
  });
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { hasCompletedOnboarding: true, numStartups: 8, tipsHistory: { a: 1 }, projects: { [key]: { hasTrustDialogAccepted: true } } });
  assert.deepEqual(readdirSync(home).sort(), ['.claude.json', 'air']);
});

test('regression: a state file that keeps changing is left alone, with a message to close Claude Code', () => {
  const home = tmp();
  const file = join(home, '.claude.json');
  writeFileSync(file, '{"n": 0}');
  let n = 0;
  assert.throws(
    () => writeClaudeTrust(file, join(home, 'air'), { beforeRename: () => writeFileSync(file, `{"n": ${++n}}`) }),
    new RegExp(`^Error: ${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} kept changing while air wrote it: close Claude Code, then run \`air serve\` again$`),
  );
  assert.equal(readFileSync(file, 'utf8'), `{"n": ${n}}`);
  assert.deepEqual(readdirSync(home).sort(), ['.claude.json', 'air']);
});

test('regression: the file mode is kept under a umask that would mask it', () => {
  // Review finding: the temp file was created with the mode, which the umask then cut down.
  const home = tmp();
  const file = join(home, '.claude.json');
  writeFileSync(file, '{}');
  chmodSync(file, 0o644);
  const saved = process.umask(0o077);
  try {
    writeClaudeTrust(file, join(home, 'air'));
  } finally {
    process.umask(saved);
  }
  assert.equal(statSync(file).mode & 0o777, 0o644);
});

test('the trust problem the preflight reports names what air serve writes, and writing it makes the login ready', () => {
  const home = tmp();
  const file = join(home, '.claude.json');
  writeFileSync(file, JSON.stringify({ hasCompletedOnboarding: true }));
  const config = parseConfig('', home);
  const deps = { ...defaultPreflightDeps('/c/config.toml'), home, env: { PATH: '/nonexistent' } };
  const bin = join(home, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\necho "2.1.311 (Claude Code)"\n', { mode: 0o755 });
  deps.env.PATH = bin;
  const [c] = preflight(config, [{ name: 'claude', harness: 'claude' }], deps);
  const [problem] = c!.logins.claude!;
  assert.deepEqual(problem!.trust, { stateFile: file, dir: config.workspace_root });
  assert.match(problem!.fix, /^run `mkdir -p /);
  // Off a terminal the report offers `air serve` in one first; about to ask, it gives only the manual way.
  assert.match(formatPreflight([c!]), /\n {4}fix: {5}run `air serve` in a terminal, or run `mkdir -p /);
  assert.match(formatPreflight([c!], true), /\n {4}fix: {5}run `mkdir -p /);
  assert.doesNotMatch(formatPreflight([c!], true), /air serve/);
  writeClaudeTrust(problem!.trust!.stateFile, problem!.trust!.dir);
  assert.deepEqual(refusals(preflight(config, [{ name: 'claude', harness: 'claude' }], deps)), {});
});
