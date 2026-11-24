// Folder trust, offered by `air serve` on a terminal: the one write air makes to an agent's own state, and only after the volunteer says yes.
// It sets `projects[<dir>].hasTrustDialogAccepted = true` in Claude Code's `.claude.json`, as answering
// "Yes, I trust this folder" there would. Every other key is kept as it was (Claude Code itself writes the file
// with JSON.stringify, so a parse and stringify round trip loses nothing), and nothing else is touched. The
// file is replaced atomically: written beside its real path (a symlinked `.claude.json` stays a symlink) with
// the same mode, then renamed over it. A running Claude Code rewrites the file often, so it is read again just
// before the rename, and a change since the merge means merging again. Codex needs no such write: each launch
// trusts its job dir (harness.ts).
import { closeSync, fchmodSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** Merges before giving up on a state file that keeps changing under us. */
export const TRUST_WRITE_ATTEMPTS = 5;

/**
 * Trusts `dir` (created if missing, keyed by its real path, as Claude Code keys it) in the Claude Code state
 * file `stateFile`. Returns the key written. `beforeRename` is for tests: it runs between the write of the
 * merged copy and the check that the file is unchanged.
 */
export function writeClaudeTrust(stateFile: string, dir: string, opts: { beforeRename?: () => void } = {}): string {
  mkdirSync(dir, { recursive: true });
  const key = realpathSync(dir);
  const target = realpathSync(stateFile);
  const mode = statSync(target).mode & 0o777;
  let text = readFileSync(target, 'utf8');
  for (let attempt = 0; attempt < TRUST_WRITE_ATTEMPTS; attempt++) {
    const out = withTrust(text, key, stateFile);
    const tmp = join(dirname(target), `.${basename(target)}.air-${process.pid}-${Math.random().toString(36).slice(2, 10)}`);
    const fd = openSync(tmp, 'wx', mode);
    let renamed = false;
    try {
      try {
        fchmodSync(fd, mode); // the umask cut down the mode openSync was given
        writeSync(fd, out);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      opts.beforeRename?.();
      const now = readFileSync(target, 'utf8');
      if (now === text) {
        renameSync(tmp, target);
        renamed = true;
        return key;
      }
      text = now;
    } finally {
      if (!renamed) rmSync(tmp, { force: true });
    }
  }
  throw new Error(`${stateFile} kept changing while air wrote it: close Claude Code, then run \`air serve\` again`);
}

/** `text` (a `.claude.json`) with `projects[key].hasTrustDialogAccepted` set, and nothing else changed. */
function withTrust(text: string, key: string, stateFile: string): string {
  const state: unknown = JSON.parse(text);
  if (state === null || typeof state !== 'object' || Array.isArray(state)) throw new Error(`${stateFile} is not a JSON object`);
  const s = state as Record<string, unknown>;
  const projects = s.projects !== null && typeof s.projects === 'object' && !Array.isArray(s.projects) ? (s.projects as Record<string, unknown>) : {};
  const entry = projects[key] !== null && typeof projects[key] === 'object' && !Array.isArray(projects[key]) ? (projects[key] as Record<string, unknown>) : {};
  s.projects = { ...projects, [key]: { ...entry, hasTrustDialogAccepted: true } };
  return `${JSON.stringify(s, null, 2)}${text.endsWith('\n') ? '\n' : ''}`;
}
