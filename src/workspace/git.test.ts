import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeBareRepo, insteadOf, type BareRepo } from './git-fixture.ts';
import { checkRef, cloneAt, GitError } from './git.ts';

let dir: string;
let repo: BareRepo;
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'air-git-'));
  repo = makeBareRepo(dir);
});
after(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
async function clone(ref: string, extra: Partial<Parameters<typeof cloneAt>[0]> = {}) {
  const dest = join(dir, `c${n++}`);
  await cloneAt({ url: repo.bare, ref, dest, cwd: dir, log: join(dir, 'log'), allowAnyUrl: true, ...extra });
  const head = execFileSync('git', ['-C', dest, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const branch = execFileSync('git', ['-C', dest, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
  return { dest, head, branch };
}

test('clones at a branch, a tag, a commit and an unreferenced commit', async () => {
  assert.deepEqual((({ head, branch }) => ({ head, branch }))(await clone('main')), { head: repo.main, branch: 'main' });
  const feature = await clone('feature');
  assert.deepEqual([feature.head, feature.branch], [repo.first, 'feature']);
  assert.equal(readFileSync(join(feature.dest, 'README'), 'utf8'), 'one\n');
  assert.deepEqual([(await clone('v1')).head, (await clone('v1')).branch], [repo.first, 'HEAD']);
  assert.equal((await clone(repo.first)).head, repo.first);
  assert.equal((await clone(repo.dangling)).head, repo.dangling);
});

test('https URLs go through git (rewritten here to the local repo)', async () => {
  const url = 'https://github.com/o/target.git';
  const r = await clone('main', { url, allowAnyUrl: false, env: insteadOf(repo.bare, url) });
  assert.equal(r.head, repo.main);
});

test('a missing ref or repo is a GitError', async () => {
  await assert.rejects(clone('nope'), (e: unknown) => e instanceof GitError && /could not find ref "nope"/.test(e.message));
  await assert.rejects(clone('main', { url: join(dir, 'missing.git') }), /git clone exited 128/);
});

test('option-like and revision-syntax refs are refused before git runs', async () => {
  for (const ref of ['--upload-pack=touch /tmp/pwned', '-b', 'main..evil', 'HEAD~1', 'x^', 'a:b', '@{-1}', 'a b', 'a\nb', '', '/x', 'x/', '.hidden', 'x.lock', 'a\\b', 'a*']) {
    assert.throws(() => checkRef(ref), GitError, JSON.stringify(ref));
  }
  for (const ref of ['main', 'feature/x-1', 'v1.10', 'release-2026.11', '0123456789abcdef0123456789abcdef01234567']) checkRef(ref);
  const dest = join(dir, 'never');
  await assert.rejects(cloneAt({ url: repo.bare, ref: '--orphan', dest, cwd: dir, log: join(dir, 'log'), allowAnyUrl: true }), GitError);
  assert.ok(!existsSync(dest));
  await assert.rejects(cloneAt({ url: 'ext::sh -c touch% /tmp/pwned', ref: 'main', dest, cwd: dir, log: join(dir, 'log') }), /refusing repo.url/);
});
