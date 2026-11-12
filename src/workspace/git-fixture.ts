// A local bare repo for clone tests: `main` (2 commits), `feature`, tags `v1` (lightweight, on the first commit)
// and `v2` (annotated, on main), a commit no branch or tag reaches, and `refs/pull/5/head` pointing at it.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface BareRepo { bare: string; main: string; first: string; dangling: string }

export function makeBareRepo(dir: string): BareRepo {
  const work = join(dir, 'work');
  mkdirSync(work, { recursive: true });
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
  const git = (...args: string[]) => execFileSync('git', args, { cwd: work, env, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  writeFileSync(join(work, 'README'), 'one\n');
  git('add', 'README');
  git('commit', '-q', '-m', 'one');
  const first = git('rev-parse', 'HEAD');
  git('tag', 'v1');
  git('branch', 'feature');
  writeFileSync(join(work, 'README'), 'two\n');
  git('commit', '-q', '-am', 'two');
  const main = git('rev-parse', 'HEAD');
  git('tag', '-a', '-m', 'v2', 'v2');
  git('checkout', '-q', '-b', 'tmp');
  writeFileSync(join(work, 'README'), 'dangling\n');
  git('commit', '-q', '-am', 'dangling');
  const dangling = git('rev-parse', 'HEAD');
  const bare = join(dir, 'bare.git');
  git('clone', '-q', '--bare', '--no-local', work, bare);
  execFileSync('git', ['--git-dir', bare, 'update-ref', 'refs/pull/5/head', dangling], { env });
  execFileSync('git', ['--git-dir', bare, 'branch', '-D', 'tmp'], { env });
  execFileSync('git', ['--git-dir', bare, 'config', 'uploadpack.allowAnySHA1InWant', 'true'], { env });
  return { bare, main, first, dangling };
}

/** Environment that makes git fetch `url` from `bare` instead (via GIT_CONFIG_* insteadOf). */
export function insteadOf(bare: string, url: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return insteadOfAll([[bare, url]], base);
}

/** `insteadOf` for several repos: each `[bare, url]` pair makes git fetch `url` from `bare`. */
export function insteadOfAll(pairs: [bare: string, url: string][], base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, GIT_CONFIG_COUNT: String(pairs.length) };
  pairs.forEach(([bare, url], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = `url.${bare}.insteadOf`;
    env[`GIT_CONFIG_VALUE_${i}`] = url;
  });
  return env;
}
