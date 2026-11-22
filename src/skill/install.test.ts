import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUNDLE, renderBundle } from '../../scripts/bundle-skill.ts';
import { lint } from '../spec/lint.ts';
import { SKILL_FILES } from './bundle.ts';
import { TAG } from '../version.ts';
import { defaultSkillDir, installSkill, InstallError, skillFiles } from './install.ts';

const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'air-skill-'));
  dirs.push(d);
  return d;
}

test('bundle.ts matches skills/ai-request/ (run `npm run skill:bundle` after editing the skill)', () => {
  assert.equal(readFileSync(BUNDLE, 'utf8'), renderBundle());
});

test('the skill has Claude Code front matter, and its template lints', () => {
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(SKILL_FILES['SKILL.md']!);
  assert.ok(fm);
  assert.match(fm[1]!, /^name: ai-request$/m);
  assert.match(fm[1]!, /^description: .*hand this off as an AI request.*file an air request/im);
  assert.deepEqual(lint(SKILL_FILES['template.md']!).errors, []);
});

test('defaultSkillDir is under ~/.claude/skills', () => {
  assert.equal(defaultSkillDir('/home/u'), join('/home/u', '.claude', 'skills', 'ai-request'));
});

test('installs into a new directory, creating its parents', () => {
  const dir = join(tmp(), 'a', 'b', 'ai-request');
  installSkill(dir);
  assert.deepEqual(readdirSync(dir).sort(), Object.keys(SKILL_FILES).sort());
  for (const [name, text] of Object.entries(skillFiles())) assert.equal(readFileSync(join(dir, name), 'utf8'), text);
  assert.deepEqual(readdirSync(join(dir, '..')), ['ai-request']);
});

test("the skill links the format spec at the installing air's release tag, not main", () => {
  assert.match(SKILL_FILES['SKILL.md']!, /blob\/\{\{AIR_TAG\}\}\/spec\/v0\.md/);
  const skill = skillFiles()['SKILL.md']!;
  assert.ok(skill.includes(`https://github.com/asinghvi17/ai-requests-cli/blob/${TAG}/spec/v0.md`));
  assert.match(TAG, /^v\d+\.\d+\.\d+$/);
  assert.ok(!Object.values(skillFiles()).some((t) => t.includes('{{AIR_TAG}}') || t.includes('/blob/main/')));
});

test('writes nested files', () => {
  const dir = join(tmp(), 'ai-request');
  installSkill(dir, { 'SKILL.md': '---\nname: ai-request\n---\n', 'ref/a.md': 'a' });
  assert.equal(readFileSync(join(dir, 'ref', 'a.md'), 'utf8'), 'a');
});

test('replaces an older copy, dropping files it no longer has, and an empty directory', () => {
  const parent = tmp();
  const dir = join(parent, 'ai-request');
  installSkill(dir, { 'SKILL.md': '---\nname: ai-request\ndescription: old\n---\n', 'old.md': 'x' });
  installSkill(dir);
  assert.deepEqual(readdirSync(dir).sort(), Object.keys(SKILL_FILES).sort());
  assert.equal(readFileSync(join(dir, 'SKILL.md'), 'utf8'), skillFiles()['SKILL.md']);
  assert.deepEqual(readdirSync(parent), ['ai-request']);
  const empty = join(parent, 'empty');
  mkdirSync(empty);
  installSkill(empty);
  assert.deepEqual(readdirSync(empty).sort(), Object.keys(SKILL_FILES).sort());
});

test('refuses to replace anything that is not this skill', () => {
  const parent = tmp();
  const cases: Record<string, () => void> = {
    other: () => { mkdirSync(join(parent, 'other')); writeFileSync(join(parent, 'other', 'notes.txt'), 'keep'); },
    otherSkill: () => { mkdirSync(join(parent, 'otherSkill')); writeFileSync(join(parent, 'otherSkill', 'SKILL.md'), '---\nname: deploy\n---\n'); },
    file: () => writeFileSync(join(parent, 'file'), 'keep'),
    link: () => symlinkSync(join(parent, 'nowhere'), join(parent, 'link')),
  };
  for (const [name, make] of Object.entries(cases)) {
    make();
    assert.throws(() => installSkill(join(parent, name)), InstallError, name);
  }
  assert.equal(readFileSync(join(parent, 'other', 'notes.txt'), 'utf8'), 'keep');
  assert.deepEqual(readdirSync(parent).sort(), ['file', 'link', 'other', 'otherSkill']);
});
