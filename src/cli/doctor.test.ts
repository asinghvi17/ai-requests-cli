import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectOs, installHint, type Os, type Tool } from '../setup/hints.ts';
import type { AgentCheck } from '../setup/preflight.ts';
import { doctor, doctorDeps, formatDoctor } from './doctor.ts';
import { main } from './main.ts';

const dirs: string[] = [];
const saved = { ...doctorDeps };
after(() => {
  Object.assign(doctorDeps, saved);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'air-doctor-')));
  dirs.push(d);
  return d;
};

async function call(...argv: string[]) {
  let out = '';
  let err = '';
  const code = await main(argv, { out: (s) => { out += s; }, err: (s) => { err += s; } });
  return { code, out, err };
}

const OS_RELEASE: Record<string, string> = {
  ubuntu: 'NAME="Ubuntu"\nID=ubuntu\nID_LIKE=debian\nVERSION_ID="24.04"\n',
  debian: 'PRETTY_NAME="Debian GNU/Linux 13 (trixie)"\nID=debian\n',
  mint: 'NAME="Linux Mint"\nID=linuxmint\nID_LIKE="ubuntu debian"\n',
  fedora: 'NAME="Fedora Linux"\nID=fedora\n',
  rocky: 'NAME="Rocky Linux"\nID="rocky"\nID_LIKE="rhel centos fedora"\n',
  rhel: 'NAME="Red Hat Enterprise Linux"\nID="rhel"\nID_LIKE="fedora"\n',
  arch: 'NAME="Arch Linux"\nID=arch\n',
  manjaro: 'NAME="Manjaro Linux"\nID=manjaro\nID_LIKE=arch\n',
  alpine: 'NAME="Alpine Linux"\nID=alpine\n',
};

test('detectOs: macOS by Homebrew, Linux by /etc/os-release ID then ID_LIKE, else other', () => {
  assert.equal(detectOs({ platform: 'darwin', hasBrew: true }), 'macos');
  assert.equal(detectOs({ platform: 'darwin', hasBrew: false }), 'macos-nobrew');
  const linux = (name: string) => detectOs({ platform: 'linux', osRelease: OS_RELEASE[name], hasBrew: false });
  assert.deepEqual(Object.keys(OS_RELEASE).map(linux), ['debian', 'debian', 'debian', 'fedora', 'rhel', 'rhel', 'arch', 'arch', 'other']);
  assert.equal(detectOs({ platform: 'linux', hasBrew: true }), 'other'); // no os-release: Homebrew on Linux is not assumed
  assert.equal(detectOs({ platform: 'freebsd', hasBrew: false }), 'other');
});

test('installHint: each system gets its own package manager, or the projects\' own installers', () => {
  const table = (tool: Tool) => Object.fromEntries((['macos', 'macos-nobrew', 'debian', 'fedora', 'rhel', 'arch', 'other'] as Os[]).map((os) => [os, installHint(tool, os)]));
  assert.deepEqual(table('tmux'), {
    macos: 'brew install tmux',
    'macos-nobrew': 'install Homebrew (https://brew.sh), then run `brew install tmux`',
    debian: 'sudo apt install tmux',
    fedora: 'sudo dnf install tmux',
    rhel: 'sudo dnf install tmux',
    arch: 'sudo pacman -S tmux',
    other: 'see https://github.com/tmux/tmux/wiki/Installing',
  });
  assert.equal(installHint('git', 'arch'), 'sudo pacman -S git');
  assert.equal(installHint('git', 'other'), 'see https://git-scm.com/downloads');
  const gh = table('gh');
  assert.equal(gh.macos, 'brew install gh');
  assert.equal(gh.arch, 'sudo pacman -S github-cli');
  assert.equal(gh.fedora, 'sudo dnf install gh');
  assert.match(gh.debian!, /^\(type -p wget[^]*https:\/\/cli\.github\.com\/packages stable main[^]*&& sudo apt install gh -y$/);
  assert.match(gh.rhel!, /config-manager --add-repo https:\/\/cli\.github\.com\/packages\/rpm\/gh-cli\.repo/);
  assert.equal(gh.other, 'see https://github.com/cli/cli#installation');
  for (const os of ['macos', 'macos-nobrew', 'debian', 'arch'] as Os[]) assert.equal(installHint('claude', os), 'curl -fsSL https://claude.ai/install.sh | bash');
  assert.equal(installHint('codex', 'macos'), 'brew install --cask codex');
  assert.equal(installHint('codex', 'macos-nobrew'), 'curl -fsSL https://chatgpt.com/codex/install.sh | sh');
  assert.equal(installHint('codex', 'fedora'), 'curl -fsSL https://chatgpt.com/codex/install.sh | sh');
  assert.equal(installHint('codex', 'other'), 'see https://developers.openai.com/codex/cli');
});

const claudeReady: AgentCheck = { harness: 'claude', version: '2.1.311 (Claude Code)', problems: [], logins: { claude: [] } };
const codexMissing: AgentCheck = {
  harness: 'codex', problems: [{ what: '`codex` was not found on PATH (or is not executable).', fix: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh\nor set command = ...' }], logins: { codex: [] },
};
let home: string;
let config: string;

/** A machine where everything passes: air on PATH, tmux 3.4, a config naming the repo, claude ready. */
beforeEach(() => {
  home = tmp();
  const bin = join(home, '.local', 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'air'), '', { mode: 0o755 });
  config = join(home, '.config', 'air', 'config.toml');
  mkdirSync(join(home, '.config', 'air'), { recursive: true });
  writeFileSync(config, `repo = "acme/requests"\nworkspace_root = "${home}/air"\n[subscriptions.claude]\nharness = "claude"\n`);
  Object.assign(doctorDeps, {
    platform: () => ({ platform: 'linux', arch: 'x64' }),
    os: () => 'debian',
    env: () => ({ PATH: `/usr/bin:${bin}`, SHELL: '/bin/bash' }),
    home: () => home,
    self: () => join(bin, 'air'),
    tmux: async () => 'tmux 3.4',
    git: () => 'git version 2.43.0',
    gh: () => 'ok',
    configPath: () => config,
    subscriptions: () => [{ name: 'claude', harness: 'claude' }, { name: 'codex', harness: 'codex' }],
    preflight: () => [claudeReady, codexMissing],
    usage: async () => ({ windows: [{ name: 'seven_day', kind: 'weekly', usedPct: 10, resetsAt: null }] }),
  } satisfies Partial<typeof doctorDeps>);
});

test('a ready machine exits 0; a broken optional agent is only a warning', async () => {
  const r = await call('doctor');
  assert.equal(r.code, 0, r.out);
  assert.equal(r.err, '');
  assert.equal(r.out, [
    '✓ system: Linux x64 (Debian/Ubuntu, apt)',
    `✓ air: ${home}/.local/bin/air, on PATH`,
    '✓ tmux: tmux 3.4',
    '✓ git: git version 2.43.0',
    '✓ gh: logged in',
    `✓ config: ${config}, requests repo acme/requests`,
    `✓ workspace_root: ${home}/air (air creates it)`,
    '✓ claude: 2.1.311 (Claude Code)',
    '✓ claude login claude: ready, subscription usage readable',
    '! codex: `codex` was not found on PATH (or is not executable).',
    '    fix: curl -fsSL https://chatgpt.com/codex/install.sh | sh',
    '         or set command = ...',
    '',
    'ready: air can request and serve work (the ! lines are optional)',
    '',
  ].join('\n'));
});

test('missing tmux fails with the install command for this system, and exits 1', async () => {
  doctorDeps.tmux = async () => { throw new Error('tmux is not usable: spawn tmux ENOENT. air needs tmux 3.0 or newer.'); };
  for (const [os, fix] of [['debian', 'sudo apt install tmux'], ['macos', 'brew install tmux'], ['macos-nobrew', 'install Homebrew (https://brew.sh), then run `brew install tmux`'], ['arch', 'sudo pacman -S tmux']] as const) {
    doctorDeps.os = () => os;
    const r = await call('doctor');
    assert.equal(r.code, 1, os);
    assert.match(r.out, new RegExp(`\n✗ tmux is not usable: spawn tmux ENOENT\\. air needs tmux 3\\.0 or newer\\.\n    fix: ${fix.replace(/[()`.]/g, '\\$&')}\n`), os);
    assert.match(r.out, /\n1 problem to fix \(✗\); fix it and run `air doctor` again\n$/);
  }
});

test('each required check fails on its own, with its fix', async () => {
  const fails = async () => (await doctor()).filter((l) => l.mark === 'fail').map((l) => `${l.what} | ${l.fix}`);
  doctorDeps.gh = () => 'logged-out';
  assert.deepEqual(await fails(), ['gh: the GitHub CLI is not logged in | gh auth login']);
  doctorDeps.gh = () => 'missing';
  doctorDeps.os = () => 'arch';
  assert.deepEqual(await fails(), ['gh: the GitHub CLI is not installed | sudo pacman -S github-cli']);
  doctorDeps.gh = () => 'ok';
  doctorDeps.git = () => undefined;
  assert.deepEqual(await fails(), ['git: not found on PATH | sudo pacman -S git']);
  doctorDeps.git = () => 'git version 2.43.0';
  doctorDeps.env = () => ({ PATH: '/usr/bin', SHELL: '/bin/zsh' });
  assert.deepEqual(await fails(), [`air: ${home}/.local/bin is not on PATH, so \`air\` is not found | echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc, then open a new terminal`]);
  doctorDeps.env = () => ({ PATH: `${home}/.local/bin` });
  doctorDeps.platform = () => ({ platform: 'win32', arch: 'x64' });
  doctorDeps.os = () => 'other';
  assert.deepEqual(await fails(), ['system: win32 x64 (unrecognised system): air runs on macOS and Linux, on arm64 or x64 | use a supported machine']);
  doctorDeps.platform = () => ({ platform: 'darwin', arch: 'arm64' });

  writeFileSync(config, '[subscriptions.claude]\nharness = "claude"\n');
  assert.deepEqual(await fails(), [`config: ${config} names no requests repo | add repo = "OWNER/NAME" at the top of ${config}`]);
  writeFileSync(config, 'repo = 3\n');
  assert.deepEqual(await fails(), [`config: ${config}: repo must be a non-empty string | fix that in ${config} (docs/config.md)`]);
  rmSync(config);
  assert.deepEqual(await fails(), [`config: ${config} does not exist | run \`air serve\` (or \`air skill install\`, to only request work) in a terminal: its first run writes it`]);
});

test('workspace_root must be writable, or creatable', async () => {
  const file = join(home, 'file');
  writeFileSync(file, '');
  writeFileSync(config, `repo = "acme/requests"\nworkspace_root = "${file}/air"\n[subscriptions.claude]\nharness = "claude"\n`);
  const r = await call('doctor');
  assert.equal(r.code, 1);
  assert.match(r.out, new RegExp(`\n✗ ${file}, where air would create workspace_root ${file}/air, is not a directory\\.\n    fix: set workspace_root in ${config} to a folder you can write\n`));
  mkdirSync(join(home, 'air'));
  writeFileSync(config, `repo = "acme/requests"\nworkspace_root = "${home}/air"\n[subscriptions.claude]\nharness = "claude"\n`);
  assert.match((await call('doctor')).out, new RegExp(`\n✓ workspace_root: ${home}/air\n`));
});

test('agents: with no login ready, every agent problem fails; with one ready, the rest warn', async () => {
  const marks = async () => (await doctor()).filter((l) => /^(claude|codex)/.test(l.what)).map((l) => `${l.mark} ${l.what}`);
  // Usage unreadable (logged out): the only login is not ready, so it fails.
  doctorDeps.usage = async () => ({ windows: [], note: 'not logged in' });
  assert.deepEqual(await marks(), [
    'ok claude: 2.1.311 (Claude Code)',
    "fail claude login claude: no subscription usage air can read (not logged in), so air serve can't match work to it",
    'fail codex: `codex` was not found on PATH (or is not executable).',
  ]);
  assert.equal(formatDoctor(await doctor()).includes('    fix: log in: claude auth login\n'), true);
  // A trust problem: the fix offers `air serve`'s prompt (doctor never writes trust).
  doctorDeps.usage = saved.usage;
  doctorDeps.preflight = () => [{ ...claudeReady, logins: { claude: [{ what: 'Claude Code does not trust workspace_root.', fix: 'run `claude` there', trust: { stateFile: '/s', dir: '/d' } }] } }];
  const lines = await doctor();
  assert.deepEqual(lines.at(-1), { mark: 'fail', what: 'claude login claude: Claude Code does not trust workspace_root.', fix: 'run `air serve` in a terminal, or run `claude` there' });
  // A login that works but config.toml doesn't name: air serve would not use it.
  doctorDeps.preflight = () => [claudeReady, { harness: 'codex', version: 'codex-cli 0.164.0', problems: [], logins: { codex: [] } }];
  doctorDeps.usage = async () => ({ windows: [{ name: 'primary', kind: 'weekly', usedPct: 1, resetsAt: null }] });
  assert.deepEqual(await marks(), [
    'ok claude: 2.1.311 (Claude Code)',
    'ok claude login claude: ready, subscription usage readable',
    'ok codex: codex-cli 0.164.0',
    `warn codex login codex: works, but ${config} has no [subscriptions.codex], so air serve won't use it`,
  ]);
  doctorDeps.preflight = () => [];
  assert.deepEqual(await marks(), []);
  assert.equal((await call('doctor')).code, 1);
});

test('doctor writes nothing: a failing run leaves the config and workspace_root as they were', async () => {
  writeFileSync(config, '[subscriptions.claude]\nharness = "claude"\n');
  doctorDeps.preflight = () => [{ ...claudeReady, logins: { claude: [{ what: 'untrusted', fix: 'trust it', trust: { stateFile: join(home, '.claude.json'), dir: join(home, 'air') } }] } }];
  assert.equal((await call('doctor')).code, 1);
  assert.deepEqual(readdirSync(home, { recursive: true }).sort(), ['.config', '.config/air', '.config/air/config.toml', '.local', '.local/bin', '.local/bin/air']);
  assert.equal(readFileSync(config, 'utf8'), '[subscriptions.claude]\nharness = "claude"\n');
});
