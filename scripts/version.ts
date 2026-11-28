// The version a build stamps into air: package.json's version plus `+<git short sha>`, release builds
// included. build.ts hands it to `bun build` as AIR_BUILD_VERSION (src/lib/version.ts).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function buildVersion(root: string): string {
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };
  let sha: string;
  try {
    sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    throw new Error(`can't stamp the version: ${root} is not a git checkout`);
  }
  return `${version}+${sha}`;
}

/** `bun build` flags that stamp the version. */
export function versionDefine(root: string): string[] {
  return ['--define', `AIR_BUILD_VERSION=${JSON.stringify(buildVersion(root))}`];
}
