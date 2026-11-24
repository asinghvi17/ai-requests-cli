// The lib domain (docs/architecture.md): what other domains import from it.
export { exec, SETUP_TIMEOUT_MS, type ExecResult } from './exec.ts';
export {
  checkoutCheckpoint, checkRef, cloneAt, gitFailure, githubRepo, gitOut, resolveRepo, type ResolveOptions,
} from './git.ts';
export type { Io } from './io.ts';
export { withLock, writeAtomic } from './lock.ts';
export { alive, thisHost, writerGone } from './pid.ts';
export { parseToml, type TomlTable, type TomlValue } from './toml.ts';
export { TAG, VERSION } from './version.ts';
export { extractionCap, extractZip } from './zip.ts';
export { zipDir } from './zipout.ts';
export { writeZip, ZipWriteError } from './zipwrite.ts';
