// Workspace teardown: the one way air deletes a workspace (a delivered job's at once, the others after the
// days serve/tidy.ts keeps them), guarded so that nothing outside workspace_root is ever removed. The caller
// stops the job's processes first (its tmux pane): rm never races an agent writing into the workspace.
import { randomBytes } from 'node:crypto';
import { lstatSync, readdirSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { checkRepo } from '../gh/issues.ts';

const WORKSPACE_NAME = /^\d+-[A-Za-z0-9]{8,64}$/;
/** A workspace renamed aside for removal (`removeWorkspace`); one a crash left is removed by `removeTrash`. */
const TRASH_NAME = /^\.\d+-[A-Za-z0-9]{8,64}\.trash-[0-9a-f]{12}$/;

/**
 * Deletes workspace `dir`. Refuses (throws) unless it is exactly `<root>/<owner>__<name>/<issue>-<nonce>`
 * (trailing slashes and `..` resolved first). The directory is first renamed to a unique trash name in the
 * same parent, then that entry is checked: a real directory, not a symlink, whose real path is that trash
 * name in root's real repo directory. Only then is it removed (rm does not follow the symlinks inside it). A
 * check that fails renames it back. So swapping the workspace or its repo directory for a symlink between the
 * checks and the rm can't point the rm elsewhere. The repo directory stays: a claim may be creating a
 * workspace in it.
 */
export function removeWorkspace(root: string, dir: string): void {
  const path = resolve(dir);
  const repoName = basename(dirname(path));
  const refuse = (why: string) => new Error(`not removing ${dir}: ${why}`);
  if (!isRepoDir(repoName)) throw refuse('it is not in a requests repo directory');
  if (!WORKSPACE_NAME.test(basename(path)) || path !== join(resolve(root), repoName, basename(path))) throw refuse(`it is not a workspace directly under ${root}`);
  const parent = dirname(path);
  if (!realDir(parent) || !realDir(path)) throw refuse('it, or its repo directory, is a symlink or not a directory');
  const trash = join(parent, `.${basename(path)}.trash-${randomBytes(6).toString('hex')}`);
  renameSync(path, trash);
  try {
    checkTrash(root, repoName, trash);
  } catch (e) {
    renameSync(trash, path);
    throw refuse((e as Error).message);
  }
  rmSync(trash, { recursive: true });
}

/** Removes the workspaces `removeWorkspace` renamed aside but did not finish removing (it crashed), in `repo`'s directory. Returns them. */
export function removeTrash(root: string, repo: string): string[] {
  const repoName = repo.replace('/', '__');
  let names: string[];
  try {
    names = readdirSync(join(root, repoName));
  } catch {
    return [];
  }
  const done: string[] = [];
  for (const name of names.filter((n) => TRASH_NAME.test(n))) {
    const trash = join(resolve(root), repoName, name);
    checkTrash(root, repoName, trash);
    rmSync(trash, { recursive: true });
    done.push(trash);
  }
  return done;
}

function isRepoDir(name: string): boolean {
  try {
    checkRepo(name.replace('__', '/'));
    return true;
  } catch {
    return false;
  }
}

function realDir(path: string): boolean {
  const st = lstatSync(path);
  return st.isDirectory() && !st.isSymbolicLink();
}

/** Throws unless `trash` is a real directory, not a symlink, and really is `<root>/<repoName>/<its name>`. */
function checkTrash(root: string, repoName: string, trash: string): void {
  if (!realDir(trash)) throw new Error('it was swapped for a symlink or a file');
  if (realpathSync(trash) !== join(realpathSync(root), repoName, basename(trash))) throw new Error(`its real path is outside ${root}`);
}
