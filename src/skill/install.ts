// `air skill install`: writes the bundled Claude Code skill (skills/ai-request/, via bundle.ts) into a
// directory, replacing an earlier copy of it.
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { TAG } from '../lib/index.ts';
import { SKILL_FILES } from './bundle.ts';

export const SKILL_NAME = 'ai-request';

export class InstallError extends Error {}

/** Where Claude Code looks for a user's own skills. */
export function defaultSkillDir(home = homedir()): string {
  return join(home, '.claude', 'skills', SKILL_NAME);
}

/** An empty directory, or one holding a SKILL.md whose front matter names this skill. */
function replaceable(dir: string): boolean {
  if (!lstatSync(dir).isDirectory()) return false;
  if (readdirSync(dir).length === 0) return true;
  let skill;
  try {
    skill = readFileSync(join(dir, 'SKILL.md'), 'utf8');
  } catch {
    return false;
  }
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(skill.replace(/\r\n?/g, '\n'));
  return fm !== null && new RegExp(`^name:\\s*${SKILL_NAME}\\s*$`, 'm').test(fm[1]!);
}

/** The skill's files, with `{{AIR_TAG}}` (in links to this repo) made `tag`: the installing air's release. */
export function skillFiles(tag = TAG): Record<string, string> {
  return Object.fromEntries(Object.entries(SKILL_FILES).map(([name, text]) => [name, text.replaceAll('{{AIR_TAG}}', tag)]));
}

/** Writes `files` into the absolute path `dir`. The new copy is built next to it and swapped in by rename. */
export function installSkill(dir: string, files: Readonly<Record<string, string>> = skillFiles()): void {
  const old = exists(dir);
  if (old && !replaceable(dir)) throw new InstallError(`${dir} exists and is not an ${SKILL_NAME} skill; not replacing it`);
  mkdirSync(dirname(dir), { recursive: true });
  const fresh = mkdtempSync(join(dirname(dir), `.${basename(dir)}-new-`));
  try {
    chmodSync(fresh, 0o755); // mkdtemp makes it 0700
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(fresh, name)), { recursive: true });
      writeFileSync(join(fresh, name), text);
    }
    if (old) {
      const stale = `${fresh}-old`;
      renameSync(dir, stale);
      renameSync(fresh, dir);
      rmSync(stale, { recursive: true, force: true });
    } else {
      renameSync(fresh, dir);
    }
  } catch (e) {
    rmSync(fresh, { recursive: true, force: true });
    throw e;
  }
}

/** True for a dangling symlink too, which existsSync reports as absent. */
function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
