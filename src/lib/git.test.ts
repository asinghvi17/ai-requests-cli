import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeBareRepo, insteadOf, type BareRepo } from './git-fixture.ts';
import type { RepoEntry } from '../request/frontmatter.ts';
import { checkoutCheckpoint, checkRef, cloneAt, GitError, gitFailure, resolveRepo, type ResolveOptions } from './git.ts';

let dir: string;
let repo: BareRepo;
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'air-git-'));
  repo = makeBareRepo(dir);
});
after(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
async function clone(sha: string, extra: Partial<Parameters<typeof cloneAt>[0]> = {}) {
  const dest = join(dir, `c${n++}`);
  await cloneAt({ url: repo.bare, sha, dest, cwd: dir, log: join(dir, 'log'), allowAnyUrl: true, ...extra });
  const head = execFileSync('git', ['-C', dest, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const branch = execFileSync('git', ['-C', dest, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
  return { dest, head, branch };
}

const resolve = (e: Partial<RepoEntry>, o: ResolveOptions = {}) => resolveRepo({ url: repo.bare, path: 'r', ...e }, { allowAnyUrl: true, ...o });

test('resolves a branch, a tag, a pull request and a commit to a full SHA', async () => {
  assert.deepEqual(await resolve({ ref: 'main' }), { sha: repo.main });
  assert.deepEqual(await resolve({ ref: 'feature' }), { sha: repo.first });
  assert.deepEqual(await resolve({ ref: 'v1' }), { sha: repo.first });
  assert.deepEqual(await resolve({ ref: 'v2' }), { sha: repo.main }, 'an annotated tag resolves to its commit');
  assert.deepEqual(await resolve({ pr: 5 }), { sha: repo.dangling });
  assert.deepEqual(await resolve({ ref: repo.first.slice(0, 9) }), { sha: repo.first });
  assert.deepEqual(await resolve({ ref: repo.main }), { sha: repo.main });
  assert.deepEqual(await resolve({ ref: repo.dangling }), { sha: repo.dangling }, 'a full SHA no ref reaches is fetched by name');
});

test('resolves a commit with safe.bareRepository=explicit (the bare clone is used by --git-dir)', async () => {
  const env = { ...process.env, GIT_CONFIG_PARAMETERS: "'safe.bareRepository=explicit'" };
  assert.deepEqual(await resolve({ ref: repo.first.slice(0, 9) }, { env }), { sha: repo.first });
  assert.deepEqual(await resolve({ ref: repo.dangling }, { env }), { sha: repo.dangling });
});

test('an entry that names nothing, or a non-branch where a branch is needed, does not resolve', async () => {
  assert.match((await resolve({ ref: 'nope' }) as { error: string }).error, /`nope` is not a branch, tag or commit of/);
  assert.match((await resolve({ ref: 'abcdef1' }) as { error: string }).error, /`abcdef1` is not a branch, tag or commit/);
  assert.match((await resolve({ ref: 'f'.repeat(40) }) as { error: string }).error, /is not a branch, tag or commit/);
  assert.match((await resolve({ pr: 6 }) as { error: string }).error, /pull request #6 of .* was not found/);
  assert.match((await resolve({ ref: 'v1' }, { branch: true }) as { error: string }).error, /`v1` is not a branch of .*`deliver: pr`/);
  assert.deepEqual(await resolve({ ref: 'main' }, { branch: true }), { sha: repo.main });
  assert.match((await resolve({ ref: 'main', url: join(dir, 'missing.git') }) as { error: string }).error, /git ls-remote .* failed/);
  assert.match((await resolveRepo({ url: 'ext::sh -c touch% /tmp/pwned', ref: 'main' }) as { error: string }).error, /refusing repo url/);
  assert.match((await resolve({ ref: 'a..b' }) as { error: string }).error, /refusing ref/);
});

test('clones at a commit, fetching one no branch or tag reaches', async () => {
  assert.deepEqual((({ head, branch }) => ({ head, branch }))(await clone(repo.main)), { head: repo.main, branch: 'HEAD' });
  const first = await clone(repo.first);
  assert.equal(first.head, repo.first);
  assert.equal(readFileSync(join(first.dest, 'README'), 'utf8'), 'one\n');
  assert.equal((await clone(repo.dangling)).head, repo.dangling);
});

test('https URLs go through git (rewritten here to the local repo)', async () => {
  const url = 'https://github.com/o/target.git';
  const r = await clone(repo.main, { url, allowAnyUrl: false, env: insteadOf(repo.bare, url) });
  assert.equal(r.head, repo.main);
  assert.deepEqual(await resolveRepo({ url, ref: 'main' }, { env: insteadOf(repo.bare, url) }), { sha: repo.main });
});

test('a missing commit or repo is a GitError', async () => {
  await assert.rejects(clone('f'.repeat(40)), (e: unknown) => e instanceof GitError && /could not fetch commit f{40}/.test(e.message));
  await assert.rejects(clone(repo.main, { url: join(dir, 'missing.git') }), /git clone exited 128/);
});

test('option-like and revision-syntax refs are refused before git runs', async () => {
  for (const ref of ['--upload-pack=touch /tmp/pwned', '-b', 'main..evil', 'HEAD~1', 'x^', 'a:b', '@{-1}', 'a b', 'a\nb', '', '/x', 'x/', '.hidden', 'x.lock', 'a\\b', 'a*']) {
    assert.throws(() => checkRef(ref), GitError, JSON.stringify(ref));
  }
  for (const ref of ['main', 'feature/x-1', 'v1.10', 'release-2026.11', '0123456789abcdef0123456789abcdef01234567']) checkRef(ref);
  const dest = join(dir, 'never');
  await assert.rejects(cloneAt({ url: repo.bare, sha: '--orphan', dest, cwd: dir, log: join(dir, 'log'), allowAnyUrl: true }), /not a full SHA/);
  assert.ok(!existsSync(dest));
  await assert.rejects(cloneAt({ url: 'ext::sh -c touch% /tmp/pwned', sha: repo.main, dest, cwd: dir, log: join(dir, 'log') }), /refusing repo url/);
});

test('a checkpoint commit is fetched by SHA and checked out on its branch', async () => {
  const c = await clone(repo.main);
  await checkoutCheckpoint({ dir: c.dest, sha: repo.dangling, branch: 'air/12', log: join(dir, 'log') });
  assert.equal(execFileSync('git', ['-C', c.dest, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), repo.dangling);
  assert.equal(execFileSync('git', ['-C', c.dest, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim(), 'air/12');
  await assert.rejects(checkoutCheckpoint({ dir: c.dest, sha: 'f'.repeat(40), branch: 'air/12', log: join(dir, 'log') }), /could not fetch checkpoint commit f{40}/);
  await assert.rejects(checkoutCheckpoint({ dir: c.dest, sha: 'HEAD', branch: 'air/12', log: join(dir, 'log') }), /refusing checkpoint sha/);
  await assert.rejects(checkoutCheckpoint({ dir: c.dest, sha: repo.main, branch: '-f', log: join(dir, 'log') }), GitError);
});

test('a repo that cannot be read is reported by git\'s fatal line, not the hint after it', async () => {
  const missing = join(mkdtempSync(join(tmpdir(), 'air-git-')), 'nope.git');
  const r = await resolveRepo({ url: missing, ref: 'main' }, { allowAnyUrl: true });
  assert.match((r as { error: string }).error, /failed: fatal: .*does not appear to be a git repository$/);
  assert.equal(gitFailure({ code: 128, stderr: "fatal: 'x' does not appear to be a git repository\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.\n" }), "fatal: 'x' does not appear to be a git repository");
  assert.equal(gitFailure({ code: 1, stderr: 'something odd\n' }), 'something odd');
  assert.equal(gitFailure({ code: 2, stderr: '' }), 'exit 2');
});
