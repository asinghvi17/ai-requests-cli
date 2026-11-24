// The unattended preflight against fake agents: stand-in binaries on PATH and hand-written agent state.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseConfig, type Config } from './config.ts';
import { configFile as subscriptionsFile, loadConfig as loadSubscriptions } from '../agents/usage/index.ts';
import { serveContext } from '../server/context.ts';
import { canonicalPath, defaultPreflightDeps, formatPreflight, loginsOf, preflight, refusals, unattendedMode, type Login, type PreflightDeps } from './preflight.ts';

const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'air-preflight-'));
  dirs.push(d);
  return d;
};

const CONFIG_FILE = '/home/u/.config/air/config.toml';

/** A machine: HOME, a bin dir with fake `claude` / `codex` that print a version, and the air config. */
function machine(o: { bins?: Record<string, string>; config?: string } = {}) {
  const home = realpathSync(tmp()); // Claude Code saves trust at real paths (macOS tmpdir is under a symlink)
  const bin = join(home, 'bin');
  mkdirSync(bin);
  const bins = o.bins ?? { claude: 'echo "2.1.311 (Claude Code)"', codex: 'echo "codex-cli 0.164.0"' };
  for (const [name, script] of Object.entries(bins)) writeFileSync(join(bin, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  const config = parseConfig(o.config ?? '', home);
  const deps: PreflightDeps = { ...defaultPreflightDeps(CONFIG_FILE), home, env: { PATH: bin }, os: 'debian' };
  return { home, bin, config, deps };
}

/** Claude Code state as `claude` leaves it after onboarding and trusting `trusted`. */
function claudeState(dir: string, o: { onboarded?: boolean; trusted?: string[]; untrusted?: string[] } = {}) {
  mkdirSync(dir, { recursive: true });
  const projects: Record<string, object> = {};
  for (const p of o.untrusted ?? []) projects[p] = { allowedTools: [], hasTrustDialogAccepted: false };
  for (const p of o.trusted ?? []) projects[p] = { allowedTools: [], hasTrustDialogAccepted: true };
  writeFileSync(join(dir, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: o.onboarded ?? true, oauthAccount: { emailAddress: 'secret@example.com' }, projects }));
}

const claude: Login = { name: 'claude', harness: 'claude' };
const codex: Login = { name: 'codex', harness: 'codex' };

test('the default agents are ready once Claude Code is onboarded and trusts a folder above workspace_root', () => {
  const m = machine();
  // Default (no CLAUDE_CONFIG_DIR): ~/.claude.json. The home directory's trust covers ~/air; a deeper entry
  // claude wrote with hasTrustDialogAccepted false does not undo it.
  writeFileSync(join(m.home, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, projects: { [m.home]: { hasTrustDialogAccepted: true }, [join(m.home, 'air', 'x')]: { hasTrustDialogAccepted: false } } }));
  const checks = preflight(m.config, [claude, codex], m.deps);
  assert.deepEqual(refusals(checks), {});
  assert.equal(checks[0]!.version, '2.1.311 (Claude Code)');
  assert.equal(checks[1]!.version, 'codex-cli 0.164.0');
  assert.equal(formatPreflight(checks), 'claude: 2.1.311 (Claude Code): ready (login claude)\ncodex: codex-cli 0.164.0: ready (login codex)\n');
});

test('a missing binary refuses every login of that harness, and only that harness', () => {
  const m = machine({ bins: { codex: 'echo "codex-cli 0.164.0"' } });
  const checks = preflight(m.config, [claude, { name: 'max2', harness: 'claude', configDir: '/x' }, codex], m.deps);
  assert.deepEqual(Object.keys(refusals(checks)).sort(), ['claude', 'max2']);
  const out = formatPreflight(checks);
  assert.match(out, /^claude: version unknown: NOT READY \(logins claude, max2\)\n    problem: `claude` was not found on PATH \(or is not executable\)\.\n    fix:     curl -fsSL https:\/\/claude\.ai\/install\.sh \| bash\n             or set command = \["\/path\/to\/claude"\] under \[agents\.claude\] in \/home\/u\/\.config\/air\/config\.toml\n/);
  assert.match(out, /\ncodex: codex-cli 0\.164\.0: ready/);
});

test('a binary that reports no version is refused', () => {
  const m = machine({ bins: { claude: 'exit 3' } });
  const [c] = preflight(m.config, [claude], m.deps);
  assert.match(c!.problems[0]!.what, /claude --version` did not report a version \(exit 3\)/);
});

test('launch args without an unattended mode are refused, with the exact args that fix it', () => {
  const m = machine({ config: '[agents.claude]\nargs = ["--permission-mode", "acceptEdits"]\n[agents.codex]\nargs = ["--sandbox", "workspace-write"]\n' });
  claudeState(m.home, { trusted: ['/'] });
  const checks = preflight(m.config, [claude, codex], m.deps);
  assert.deepEqual(checks.map((c) => c.problems.map((p) => p.fix)), [
    [`set args = ["--permission-mode", "auto"] under [agents.claude] in ${CONFIG_FILE}`],
    [`set args = ["--ask-for-approval", "never", "--sandbox", "workspace-write", "-c", "sandbox_workspace_write.network_access=true"] under [agents.codex] in ${CONFIG_FILE}`],
  ]);
  assert.match(checks[0]!.problems[0]!.what, /^\[agents.claude\] launches claude without an unattended mode \(args = \["--permission-mode", "acceptEdits"\]\)/);
});

test('unattended modes: auto and bypassPermissions for Claude Code, never and bypass for Codex', () => {
  const a = (args: string[], command = ['x']) => ({ command, args });
  assert.equal(unattendedMode('claude', a(['--permission-mode', 'auto'])), 'auto');
  assert.equal(unattendedMode('claude', a(['--permission-mode=bypassPermissions'])), 'bypass');
  assert.equal(unattendedMode('claude', a(['--dangerously-skip-permissions'])), undefined);
  assert.equal(unattendedMode('claude', a(['--permission-mode', 'auto', '--permission-mode', 'plan'])), undefined);
  assert.equal(unattendedMode('claude', a([], ['claude', '--permission-mode', 'auto'])), 'auto');
  assert.equal(unattendedMode('codex', a(['-a', 'never'])), 'never');
  assert.equal(unattendedMode('codex', a(['--ask-for-approval=never'])), 'never');
  assert.equal(unattendedMode('codex', a(['--ask-for-approval', 'on-request'])), undefined);
  assert.equal(unattendedMode('codex', a(['--dangerously-bypass-approvals-and-sandbox'])), 'bypass');
});

test('Claude Code: no state, unfinished onboarding, and an untrusted workspace_root, per login config dir', () => {
  const m = machine();
  const fresh = join(m.home, 'fresh');
  const half = join(m.home, 'half');
  claudeState(half, { onboarded: false, trusted: ['/elsewhere'], untrusted: [m.config.workspace_root] });
  const checks = preflight(m.config, [{ name: 'a', harness: 'claude', configDir: fresh }, { name: 'b', harness: 'claude', configDir: half }], m.deps);
  const [c] = checks;
  assert.deepEqual(c!.problems, []);
  assert.equal(c!.logins.a!.length, 1);
  assert.match(c!.logins.a![0]!.what, new RegExp(`^Claude Code has not been set up with this config: ${fresh}/.claude.json does not exist`));
  assert.equal(c!.logins.a![0]!.fix, `run \`mkdir -p ${m.config.workspace_root} && cd ${m.config.workspace_root} && CLAUDE_CONFIG_DIR=${fresh} claude\`, finish the first-run screens and log in, answer "Yes, I trust this folder", then /exit`);
  assert.deepEqual(c!.logins.b!.map((p) => p.what.split(' (')[0]), [
    "Claude Code's first-run onboarding is not finished",
    `Claude Code does not trust workspace_root ${m.config.workspace_root}`,
  ]);
  assert.deepEqual(Object.keys(refusals(checks)), ['a', 'b']);
  const out = formatPreflight(checks);
  assert.match(out, /^claude: 2\.1\.311 \(Claude Code\): NOT READY \(logins a, b\)\n  login a:\n    problem: /);
  // Nothing from the state files beyond the checked keys is printed.
  assert.doesNotMatch(out, /secret/);
});

test('CLAUDE_CONFIG_DIR in the server environment selects the state file when the login sets none', () => {
  const m = machine();
  const dir = join(m.home, 'env-dir');
  claudeState(dir, { trusted: [m.config.workspace_root] });
  assert.deepEqual(refusals(preflight(m.config, [claude], { ...m.deps, env: { ...m.deps.env, CLAUDE_CONFIG_DIR: dir } })), {});
  assert.deepEqual(Object.keys(refusals(preflight(m.config, [claude], m.deps))), ['claude']);
});

test('bypass mode needs the Bypass Permissions warning accepted once', () => {
  const m = machine({ config: '[agents.claude]\nargs = ["--permission-mode", "bypassPermissions"]\n' });
  const dir = join(m.home, '.claude');
  claudeState(m.home, { trusted: [m.home] });
  const [c] = preflight(m.config, [claude], m.deps);
  assert.match(c!.logins.claude![0]!.what, /would stop at "WARNING: Claude Code running in Bypass Permissions mode"/);
  assert.match(c!.logins.claude![0]!.fix, /choose "Yes, I accept", or use auto mode: args = \["--permission-mode", "auto"\]/);
  mkdirSync(dir);
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ skipDangerousModePermissionPrompt: true, env: { SOME_TOKEN: 'sk-secret' } }));
  assert.deepEqual(refusals(preflight(m.config, [claude], m.deps)), {});
});

test('Claude Code in a git repo: trust from above the repo does not count, from inside it does', () => {
  // Real paths: Claude Code keys trust on them (macOS tmpdir is a symlink).
  const repo = realpathSync(tmp());
  execFileSync('git', ['init', '-q', repo]);
  const root = join(repo, 'air');
  mkdirSync(root);
  const m = machine({ config: `workspace_root = "${root}"\n` });
  claudeState(m.home, { trusted: [dirname(repo)] });
  const [c] = preflight(m.config, [claude], m.deps);
  assert.deepEqual(c!.logins.claude!.map((p) => p.what), [
    `workspace_root ${root} is inside the git repo ${repo}, and Claude Code does not carry the trust of ${dirname(repo)} into a git repo below it, so each job would stop at "Quick safety check: Is this a project you created or one you trust?".`,
  ]);
  for (const trusted of [repo, root]) {
    claudeState(m.home, { trusted: [dirname(repo), trusted] });
    assert.deepEqual(refusals(preflight(m.config, [claude], m.deps)), {}, trusted);
  }
  // A workspace_root reached through a symlink is checked at its real path.
  const link = join(tmp(), 'link');
  symlinkSync(root, link);
  const viaLink = machine({ config: `workspace_root = "${link}"\n` });
  claudeState(viaLink.home, { trusted: [root] });
  assert.deepEqual(refusals(preflight(viaLink.config, [claude], viaLink.deps)), {});
});

test('regression: a workspace_root not created yet, below a symlink into a git repo, is checked in that repo', () => {
  // Review finding: the missing path was walked as written, so the repo behind the symlink went unseen and
  // trust from above that repo passed, while every job then prompted.
  const base = realpathSync(tmp());
  const repo = join(base, 'repo');
  mkdirSync(join(repo, 'x'), { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  symlinkSync(join(repo, 'x'), join(base, 'link'));
  const m = machine({ config: `workspace_root = "${join(base, 'link', 'air')}"\n` });
  claudeState(m.home, { trusted: [base] });
  const [problem] = preflight(m.config, [claude], m.deps)[0]!.logins.claude!;
  assert.match(problem!.what, new RegExp(`is inside the git repo ${repo}, and Claude Code does not carry the trust of ${base} into`));
  // --fix trusts the path Claude Code will see.
  assert.deepEqual(problem!.trust, { stateFile: join(m.home, '.claude.json'), dir: join(repo, 'x', 'air') });
});

test('regression: a workspace_root not created yet, below a symlinked home, matches trust saved at the real path', () => {
  // Review finding: Claude Code saves real paths (macOS /var is /private/var), and a missing ~/air was compared
  // as written, so doctor refused a login that would have run.
  const base = realpathSync(tmp());
  mkdirSync(join(base, 'real'));
  symlinkSync(join(base, 'real'), join(base, 'home'));
  const m = machine({ config: `workspace_root = "${join(base, 'home', 'air')}"\n` });
  claudeState(m.home, { trusted: [join(base, 'real')] });
  assert.deepEqual(refusals(preflight(m.config, [claude], m.deps)), {});
});

test('canonicalPath resolves the nearest existing ancestor and keeps the missing tail', () => {
  const base = realpathSync(tmp());
  mkdirSync(join(base, 'real'));
  symlinkSync(join(base, 'real'), join(base, 'link'));
  assert.equal(canonicalPath(join(base, 'link', 'a', 'b')), join(base, 'real', 'a', 'b'));
  assert.equal(canonicalPath(join(base, 'link')), join(base, 'real'));
  assert.equal(canonicalPath(join(base, 'link', '..', 'real', 'c')), join(base, 'real', 'c'));
});

test('Codex needs no trust set up, in a git repo or not: each launch trusts its job dir', () => {
  const repo = tmp();
  execFileSync('git', ['init', '-q', repo]);
  for (const m of [machine(), machine({ config: `workspace_root = "${join(repo, 'air')}"\n` })]) {
    assert.deepEqual(preflight(m.config, [codex], m.deps)[0]!.logins, { codex: [] });
  }
});

test('loginsOf: claude and codex logins with their dirs, manual ones by their declared harness', () => {
  const config: Config = parseConfig('[subscriptions.pool]\nharness = "codex"\n[subscriptions.other]\nharness = "manual"\n', '/home/u');
  assert.deepEqual(loginsOf([
    { name: 'max', harness: 'claude', configDir: '/c' },
    { name: 'pro', harness: 'codex', codexHome: '/x' },
    { name: 'pool', harness: 'manual', reset: { every: 'weekly', day: 0 }, budget: { usd: 100 } },
    { name: 'other', harness: 'manual', reset: { every: 'weekly', day: 0 }, budget: { usd: 100 } },
  ], config), [
    { name: 'max', harness: 'claude', configDir: '/c' },
    { name: 'pro', harness: 'codex', codexHome: '/x' },
    { name: 'pool', harness: 'codex' },
  ]);
});

test('a manual login runs its agent, and is preflighted, with its own config dir', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'subscriptions.json'), JSON.stringify([
    { name: 'work', harness: 'manual', configDir: '/elsewhere/claude', reset: { every: 'weekly', day: 0 }, budget: { usd: 100 } },
    { name: 'pool', harness: 'manual', codexHome: '/elsewhere/codex', reset: { every: 'weekly', day: 0 }, budget: { usd: 100 } },
  ]));
  const config = parseConfig('[subscriptions.work]\nharness = "claude"\n[subscriptions.pool]\nharness = "codex"\n', '/home/u');
  const saved = { config: process.env.AIR_CONFIG_DIR, state: process.env.AIR_STATE_DIR };
  process.env.AIR_CONFIG_DIR = dir;
  process.env.AIR_STATE_DIR = join(dir, 'state');
  try {
    const ctx = serveContext(config, 'o/requests');
    assert.deepEqual(ctx.agentEnv('work'), { CLAUDE_CONFIG_DIR: '/elsewhere/claude' });
    assert.deepEqual(ctx.agentEnv('pool'), { CODEX_HOME: '/elsewhere/codex' });
    const logins = loginsOf(loadSubscriptions(subscriptionsFile()), config);
    assert.deepEqual(logins, [
      { name: 'work', harness: 'claude', configDir: '/elsewhere/claude' },
      { name: 'pool', harness: 'codex', codexHome: '/elsewhere/codex' },
    ]);
    const m = machine();
    const [claudeCheck] = preflight(m.config, logins, m.deps);
    assert.match(claudeCheck!.logins.work![0]!.what, /^Claude Code has not been set up with this config: \/elsewhere\/claude\/\.claude\.json does not exist/);
  } finally {
    for (const [k, v] of [['AIR_CONFIG_DIR', saved.config], ['AIR_STATE_DIR', saved.state]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
