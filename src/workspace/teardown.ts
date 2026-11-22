// Workspace teardown: the one way air deletes a workspace (a delivered job's at once, the others after the
// days serve/tidy.ts keeps them), guarded so that nothing outside workspace_root is ever removed.
import { lstatSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { checkRepo } from '../gh/issues.ts';

const WORKSPACE_NAME = /^\d+-[A-Za-z0-9]{8,64}$/;

/**
 * Deletes workspace `dir`. Refuses (throws) unless it is exactly `<root>/<owner>__<name>/<issue>-<nonce>`,
 * with neither of those two directories a symlink and its real path inside root's: a `..`, a symlinked
 * directory or a path from elsewhere never gets an rm. (rm does not follow the symlinks inside it.) The repo
 * directory stays: a claim may be creating a workspace in it.
 */
export function removeWorkspace(root: string, dir: string): void {
  const parent = dirname(dir);
  const [repoName, name] = [basename(parent), basename(dir)];
  const refuse = (why: string) => new Error(`not removing ${dir}: ${why}`);
  try {
    checkRepo(repoName.replace('__', '/'));
  } catch {
    throw refuse('it is not in a requests repo directory');
  }
  if (!WORKSPACE_NAME.test(name) || resolve(dir) !== join(resolve(root), repoName, name)) throw refuse(`it is not a workspace directly under ${root}`);
  for (const d of [parent, dir]) {
    const st = lstatSync(d);
    if (st.isSymbolicLink() || !st.isDirectory()) throw refuse(`${d} is a symlink or not a directory`);
  }
  if (realpathSync(dir) !== join(realpathSync(root), repoName, name)) throw refuse(`its real path is outside ${root}`);
  rmSync(dir, { recursive: true });
}
