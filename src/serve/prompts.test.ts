// Prompt detection against pane text: real captures of the installed CLIs, see fixtures/panes/README.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { matchPrompt, PROMPTS, waitingFor } from './prompts.ts';

const pane = (name: string) => readFileSync(new URL(`./fixtures/panes/${name}.txt`, import.meta.url), 'utf8');
const fix = { configFile: '/home/u/.config/air/config.toml', workspaceRoot: '/home/u/air', attach: '`air attach 12`' };

test('each captured prompt matches its pattern, and only for its own harness', () => {
  const cases: [string, 'claude' | 'codex', string][] = [
    ['claude-onboarding', 'claude', 'claude-onboarding'],
    ['claude-trust', 'claude', 'claude-trust'],
    ['claude-bypass', 'claude', 'claude-bypass-confirm'],
    ['claude-permission', 'claude', 'claude-permission'],
    ['codex-login', 'codex', 'codex-login'],
    ['codex-trust', 'codex', 'codex-trust'],
    ['codex-approval', 'codex', 'codex-approval'],
  ];
  for (const [file, harness, id] of cases) {
    assert.equal(matchPrompt(harness, pane(file))?.id, id, file);
    assert.equal(matchPrompt(harness === 'claude' ? 'codex' : 'claude', pane(file)), undefined, `${file} for the other harness`);
  }
});

test('a working agent is no prompt; nor is prompt text that scrolled far up', () => {
  assert.equal(matchPrompt('claude', pane('claude-auto-working')), undefined);
  // An idle agent whose output quotes prompts: the text is near the bottom, but no prompt footer is.
  assert.equal(matchPrompt('claude', pane('claude-output-mentions-prompt')), undefined);
  const scrolled = `${pane('claude-trust')}${'output line\n'.repeat(40)}`;
  assert.equal(matchPrompt('claude', scrolled), undefined);
});

test('a prompt wrapped by a narrow pane still matches', () => {
  const narrow = pane('claude-trust').replace('Is this a project you created or one', 'Is this a project you\ncreated or one');
  assert.equal(matchPrompt('claude', narrow)?.id, 'claude-trust');
});

test('fixes: config prompts name the setting or command; others say how to attach', () => {
  const trust = waitingFor(matchPrompt('claude', pane('claude-trust'))!, fix);
  assert.equal(trust.fix, 'run `mkdir -p /home/u/air && cd /home/u/air && claude`, answer "Yes, I trust this folder", then /exit (folders below it inherit the trust)');
  const bypass = waitingFor(matchPrompt('claude', pane('claude-bypass'))!, fix);
  assert.match(bypass.fix, /^use auto mode: args = \["--permission-mode", "auto"\] under \[agents.claude\] in \/home\/u\/.config\/air\/config.toml/);
  const perm = waitingFor(matchPrompt('claude', pane('claude-permission'))!, fix);
  assert.match(perm.fix, /^attach with `air attach 12` and answer it; if it recurs/);
  const approval = waitingFor(matchPrompt('codex', pane('codex-approval'))!, fix);
  assert.match(approval.fix, /^attach with `air attach 12` and answer it; to stop it recurring, set args = \["--ask-for-approval", "never"/);
  assert.deepEqual(waitingFor('idle', fix), { prompt: 'idle', what: 'no screen change for 15 min: it may be waiting at a prompt', fix: 'attach with `air attach 12` and answer it' });
});

test('every pattern records where its text came from', () => {
  for (const p of PROMPTS) assert.match(p.source, /^(Claude Code|Codex CLI) [\d.]+, (captured: \S+\.txt|binary: ")/, p.id);
});
