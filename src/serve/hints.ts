// How to install what air needs, on this machine: `detectOs` names the package manager to use, and
// `installHint` gives the command. The startup checks (`air serve`, `air doctor`) print these as fixes. gh, Claude
// Code and Codex use their projects' own install commands (cli/cli docs/install_linux.md, code.claude.com setup,
// the openai/codex README); tmux and git come from the system's package manager.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolveBinary } from './preflight.ts';

/** A machine, by how software is installed on it. `macos-nobrew` is macOS without Homebrew. */
export type Os = 'macos' | 'macos-nobrew' | 'debian' | 'fedora' | 'rhel' | 'arch' | 'other';
export type Tool = 'tmux' | 'git' | 'gh' | 'claude' | 'codex';

export const OS_NAMES: Record<Os, string> = {
  macos: 'macOS, Homebrew',
  'macos-nobrew': 'macOS, no Homebrew',
  debian: 'Debian/Ubuntu, apt',
  fedora: 'Fedora, dnf',
  rhel: 'RHEL/CentOS, dnf',
  arch: 'Arch, pacman',
  other: 'unrecognised system',
};

/** /etc/os-release `ID` and `ID_LIKE` words -> Os; the first word that names one wins. */
const DISTROS: Record<string, Os> = {
  debian: 'debian', ubuntu: 'debian',
  fedora: 'fedora',
  rhel: 'rhel', centos: 'rhel', rocky: 'rhel', almalinux: 'rhel',
  arch: 'arch', manjaro: 'arch', endeavouros: 'arch',
};

/** `platform` is process.platform; `osRelease` the text of /etc/os-release, if any. */
export function detectOs(o: { platform: string; osRelease?: string; hasBrew: boolean }): Os {
  if (o.platform === 'darwin') return o.hasBrew ? 'macos' : 'macos-nobrew';
  if (o.platform !== 'linux') return 'other';
  const field = (key: string) => new RegExp(`^${key}=["']?([^"'\\n]*)`, 'm').exec(o.osRelease ?? '')?.[1] ?? '';
  for (const word of `${field('ID')} ${field('ID_LIKE')}`.toLowerCase().split(/\s+/)) if (Object.hasOwn(DISTROS, word)) return DISTROS[word]!;
  return 'other';
}

/** This machine's Os. */
export function hostOs(env: Record<string, string | undefined> = process.env): Os {
  let osRelease: string | undefined;
  try {
    osRelease = readFileSync('/etc/os-release', 'utf8');
  } catch {}
  const hasBrew = Boolean(resolveBinary('brew', env, homedir())) || existsSync('/opt/homebrew/bin/brew') || existsSync('/usr/local/bin/brew');
  return detectOs({ platform: process.platform, osRelease, hasBrew });
}

const GH_APT = `(type -p wget >/dev/null || (sudo apt update && sudo apt install wget -y)) \\
  && sudo mkdir -p -m 755 /etc/apt/keyrings \\
  && out=$(mktemp) && wget -nv -O$out https://cli.github.com/packages/githubcli-archive-keyring.gpg \\
  && cat $out | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null \\
  && sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \\
  && sudo mkdir -p -m 755 /etc/apt/sources.list.d \\
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null \\
  && sudo apt update \\
  && sudo apt install gh -y`;

const GH_DNF4 = `sudo dnf install 'dnf-command(config-manager)' \\
  && sudo dnf config-manager --add-repo https://cli.github.com/packages/rpm/gh-cli.repo \\
  && sudo dnf install gh`;

const CLAUDE_NATIVE = 'curl -fsSL https://claude.ai/install.sh | bash';
const CODEX_SCRIPT = 'curl -fsSL https://chatgpt.com/codex/install.sh | sh';

/** Each tool's install command per Os; `brew:` marks a Homebrew command, which macOS without Homebrew is told to get first. */
const INSTALL: Record<Tool, Partial<Record<Os, string>> & { docs: string }> = {
  tmux: { macos: 'brew: install tmux', debian: 'sudo apt install tmux', fedora: 'sudo dnf install tmux', rhel: 'sudo dnf install tmux', arch: 'sudo pacman -S tmux', docs: 'https://github.com/tmux/tmux/wiki/Installing' },
  git: { macos: 'brew: install git', debian: 'sudo apt install git', fedora: 'sudo dnf install git', rhel: 'sudo dnf install git', arch: 'sudo pacman -S git', docs: 'https://git-scm.com/downloads' },
  gh: { macos: 'brew: install gh', debian: GH_APT, fedora: 'sudo dnf install gh', rhel: GH_DNF4, arch: 'sudo pacman -S github-cli', docs: 'https://github.com/cli/cli#installation' },
  claude: { macos: CLAUDE_NATIVE, 'macos-nobrew': CLAUDE_NATIVE, debian: CLAUDE_NATIVE, fedora: CLAUDE_NATIVE, rhel: CLAUDE_NATIVE, arch: CLAUDE_NATIVE, docs: 'https://code.claude.com/docs/en/setup' },
  codex: { macos: 'brew: install --cask codex', 'macos-nobrew': CODEX_SCRIPT, debian: CODEX_SCRIPT, fedora: CODEX_SCRIPT, rhel: CODEX_SCRIPT, arch: CODEX_SCRIPT, docs: 'https://developers.openai.com/codex/cli' },
};

/** The command that installs `tool` on `os`, or what to read when air knows none. May span lines. */
export function installHint(tool: Tool, os: Os): string {
  const t = INSTALL[tool];
  const brew = t.macos?.startsWith('brew: ') ? `brew ${t.macos.slice(6)}` : undefined;
  if (os === 'macos-nobrew' && !t[os] && brew) return `install Homebrew (https://brew.sh), then run \`${brew}\``;
  const cmd = os === 'macos' && brew ? brew : t[os];
  return cmd ?? `see ${t.docs}`;
}

/** How to log in, for the tools that have one. */
export const LOGIN_HINT: Record<'gh' | 'claude' | 'codex', string> = {
  gh: 'gh auth login',
  claude: 'claude auth login',
  codex: 'run `codex` and choose "Sign in with ChatGPT"',
};
