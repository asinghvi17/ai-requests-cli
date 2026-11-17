// `air doctor --fix`: the one write air makes to an agent's own state, and only after the volunteer says yes.
// It sets `projects[<dir>].hasTrustDialogAccepted = true` in Claude Code's `.claude.json`, as answering
// "Yes, I trust this folder" there would. Every other key is kept as it was (Claude Code itself writes the file
// with JSON.stringify, so a parse and stringify round trip loses nothing), and nothing else is touched. The
// file is replaced atomically: written beside its real path (a symlinked `.claude.json` stays a symlink) with
// the same mode, then renamed over it. Codex needs no such write: each launch trusts its job dir (agent.ts).
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * Trusts `dir` (created if missing, keyed by its real path, as Claude Code keys it) in the Claude Code state
 * file `stateFile`. Returns the key written.
 */
export function writeClaudeTrust(stateFile: string, dir: string): string {
  mkdirSync(dir, { recursive: true });
  const key = realpathSync(dir);
  const target = realpathSync(stateFile);
  const text = readFileSync(target, 'utf8');
  const state: unknown = JSON.parse(text);
  if (state === null || typeof state !== 'object' || Array.isArray(state)) throw new Error(`${stateFile} is not a JSON object`);
  const s = state as Record<string, unknown>;
  const projects = s.projects !== null && typeof s.projects === 'object' && !Array.isArray(s.projects) ? (s.projects as Record<string, unknown>) : {};
  const entry = projects[key] !== null && typeof projects[key] === 'object' && !Array.isArray(projects[key]) ? (projects[key] as Record<string, unknown>) : {};
  s.projects = { ...projects, [key]: { ...entry, hasTrustDialogAccepted: true } };
  const out = `${JSON.stringify(s, null, 2)}${text.endsWith('\n') ? '\n' : ''}`;

  const tmp = join(dirname(target), `.${basename(target)}.air-${process.pid}-${Math.random().toString(36).slice(2, 10)}`);
  const fd = openSync(tmp, 'wx', statSync(target).mode & 0o777);
  try {
    try {
      writeSync(fd, out);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, target);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  return key;
}
