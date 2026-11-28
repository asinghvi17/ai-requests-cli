// The version `air --version` prints. A built binary has it stamped by scripts/build.ts (scripts/version.ts:
// package.json's version plus `+<git short sha>`, release builds included); run from source, it is
// package.json's version plus `+source`.
import pkg from '../../package.json' with { type: 'json' };

declare const AIR_BUILD_VERSION: string | undefined;

export const VERSION: string = typeof AIR_BUILD_VERSION === 'string' ? AIR_BUILD_VERSION : `${pkg.version}+source`;

/** This version's release tag (release.yml checks a tag is `v` + package.json's version). */
export const TAG = `v${pkg.version}`;
