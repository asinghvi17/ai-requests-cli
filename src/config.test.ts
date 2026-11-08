import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError, configPath, loadConfig, parseConfig } from './config.ts';

const HOME = '/home/u';

test('config path respects XDG_CONFIG_HOME, ignoring relative values', () => {
  assert.equal(configPath({}, HOME), '/home/u/.config/air/config.toml');
  assert.equal(configPath({ XDG_CONFIG_HOME: '/x' }, HOME), '/x/air/config.toml');
  assert.equal(configPath({ XDG_CONFIG_HOME: 'rel' }, HOME), '/home/u/.config/air/config.toml');
});

test('defaults', () => {
  assert.deepEqual(parseConfig('', HOME), {
    workspace_root: '/home/u/air',
    max_jobs: 1,
    tick_seconds: 60,
    subscriptions: {},
    models: { claude: { small: 'haiku', medium: 'sonnet', large: 'opus' } },
    agents: {},
  });
});

test('full config', () => {
  const c = parseConfig(`
repo = "acme/ai-requests"
workspace_root = "~/work/air"
max_jobs = 3
tick_seconds = 30

[subscriptions.max]
harness = "claude"
scale = 20
reserve = 0.3

[subscriptions.codex-pro]
harness = "codex"
budget = 40

[models.claude]
large = "claude-opus-5-5"

[models.codex]
small = "s"
medium = "m"
large = "l"

[agents.claude]
command = ["/opt/claude/bin/claude"]
args = ["--permission-mode", "acceptEdits"]

[agents.codex]
`, HOME);
  assert.deepEqual(c, {
    repo: 'acme/ai-requests',
    workspace_root: '/home/u/work/air',
    max_jobs: 3,
    tick_seconds: 30,
    subscriptions: {
      max: { harness: 'claude', scale: 20, reserve: 0.3 },
      'codex-pro': { harness: 'codex', scale: 1, reserve: 0, budget: 40 },
    },
    models: {
      claude: { small: 'haiku', medium: 'sonnet', large: 'claude-opus-5-5' },
      codex: { small: 's', medium: 'm', large: 'l' },
    },
    agents: {
      claude: { command: ['/opt/claude/bin/claude'], args: ['--permission-mode', 'acceptEdits'] },
      codex: { command: ['codex'], args: [] },
    },
  });
});

test('validation errors', () => {
  const cases: [string, RegExp][] = [
    ['repo = "nope"', /repo must be OWNER\/NAME/],
    ['max_jobs = 0', /max_jobs must be a positive integer/],
    ['max_jobs = 1.5', /max_jobs/],
    ['workspace_root = "rel/dir"', /workspace_root must be an absolute path/],
    ['colour = "x"', /unknown key colour/],
    ['[subscriptions.a]\nscale = 1', /subscriptions.a.harness is required/],
    ['[subscriptions.a]\nharness = "claude"\nreserve = 1', /reserve must be a number in \[0, 1\)/],
    ['[subscriptions.a]\nharness = "claude"\nplan = "max"', /unknown key subscriptions.a.plan/],
    ['subscriptions = 1', /subscriptions must be a table/],
    ['[models.codex]\nsmall = "s"', /models.codex is missing medium, large/],
    ['[models.claude]\nhuge = "x"', /unknown key models.claude.huge/],
    ['a = ', /line 1/],
    ['[models.toString]\nsmall = "s"', /models.toString is missing medium, large/],
    ['tick_seconds = 0', /tick_seconds must be a number >= 1/],
    ['[agents.gemini]\ncommand = ["g"]', /agents.gemini: harness must be one of claude, codex/],
    ['[agents.claude]\ncommand = []', /agents.claude.command must not be empty/],
    ['[agents.claude]\ncommand = "claude"', /agents.claude.command must be an array of strings/],
    ['[agents.claude]\nargs = [1]', /agents.claude.args must be an array of strings/],
    ['[subscriptions.constructor]\nharness = "claude"', /is not allowed/],
  ];
  for (const [src, re] of cases) assert.throws(() => parseConfig(src, HOME), (e: unknown) => e instanceof ConfigError && re.test(e.message), src);
});

test('loadConfig: missing file is defaults, errors name the file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'air-config-'));
  assert.equal(loadConfig(join(dir, 'none.toml'), HOME).max_jobs, 1);
  const bad = join(dir, 'config.toml');
  writeFileSync(bad, 'max_jobs = "two"\n');
  assert.throws(() => loadConfig(bad, HOME), new RegExp(`${bad}: max_jobs`));
});
