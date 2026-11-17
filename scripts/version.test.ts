import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildVersion, versionDefine } from './version.ts';

const root = join(import.meta.dirname, '..');

test('a build is stamped with package.json\'s version, plus the short sha unless HEAD has the release tag', (t) => {
  const d = mkdtempSync(join(tmpdir(), 'air-version-'));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd: d, encoding: 'utf8' }).trim();
  assert.throws(() => (writeFileSync(join(d, 'package.json'), '{"version":"1.2.3"}'), buildVersion(d)), /not a git checkout/);
  git('init', '-q');
  git('add', 'package.json');
  git('commit', '-q', '-m', 'one');
  const sha = git('rev-parse', '--short', 'HEAD');
  assert.equal(buildVersion(d), `1.2.3+${sha}`);
  git('tag', 'v1.2.2');
  assert.equal(buildVersion(d), `1.2.3+${sha}`, 'another version\'s tag is not a release of this one');
  git('tag', 'v1.2.3');
  assert.equal(buildVersion(d), '1.2.3');
  assert.deepEqual(versionDefine(d), ['--define', 'AIR_BUILD_VERSION="1.2.3"']);
});

const bun = join(root, 'node_modules', '.bin', 'bun');
test('the stamp reaches air --version in a bun build', { skip: existsSync(bun) ? false : 'bun not installed' }, (t) => {
  const d = mkdtempSync(join(tmpdir(), 'air-version-build-'));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  const out = join(d, 'air.js');
  const built = spawnSync(bun, ['build', '--target=bun', ...versionDefine(root), join(root, 'src', 'cli', 'main.ts'), '--outfile', out], { encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  const r = spawnSync(bun, [out, '--version'], { encoding: 'utf8' });
  assert.equal(r.stdout, `${buildVersion(root)}\n`, r.stderr);
  assert.match(r.stdout, /^\d+\.\d+\.\d+(\+[0-9a-f]{4,})?\n$/);
});
