// The version a build stamps into air: package.json's version, plus `+<git short sha>` unless HEAD is that
// version's release tag `v<version>`. build.ts hands it to `bun build` as AIR_BUILD_VERSION (src/version.ts).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const git = (root: string, ...args: string[]): string | undefined => {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return undefined;
  }
};

export function buildVersion(root: string): string {
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };
  const tags = git(root, 'tag', '--points-at', 'HEAD')?.split('\n') ?? [];
  if (tags.includes(`v${version}`)) return version;
  const sha = git(root, 'rev-parse', '--short', 'HEAD');
  if (!sha) throw new Error(`can't stamp the version: ${root} is not a git checkout`);
  return `${version}+${sha}`;
}

/** `bun build` flags that stamp the version. */
export function versionDefine(root: string): string[] {
  return ['--define', `AIR_BUILD_VERSION=${JSON.stringify(buildVersion(root))}`];
}
