# air doctor

`air doctor` checks that this machine has what air needs. It prints one line per check:

- `✓` passes.
- `✗` fails. The line below it gives the fix for your system.
- `!` is a problem that doesn't stop air. Examples: Codex is missing but Claude Code is ready, or `air` on
  your PATH is a different copy.

It exits 0 when no line fails, 1 otherwise. It writes nothing: no config, no folder trust, no usage cache.

## What it checks

| Check | Passes when |
| --- | --- |
| system | macOS or Linux, on arm64 or x64 |
| air | the `air` your shell finds on PATH is this one |
| tmux | `tmux -V` runs and is 3.0 or newer |
| git | `git --version` runs |
| gh | `gh auth status` succeeds (installed and logged in) |
| config | `~/.config/air/config.toml` exists, parses, and sets `repo` |
| workspace_root | it, or the folder air would create it in, is a writable directory |
| claude, codex | the binary reports a version, and its launch args are unattended |
| each login | Claude Code finished onboarding and trusts `workspace_root`; its subscription usage reads; config.toml has a `[subscriptions.NAME]` for it |

The tmux, gh, config, workspace_root and agent checks are the ones `air serve` runs at startup, from the
same code. A login problem fails only when no login is ready; otherwise it is a `!`.

## Fixes

Install fixes match your system:

- macOS: Homebrew (`brew install ...`). Without Homebrew, it points you to [brew.sh](https://brew.sh) first.
- Debian and Ubuntu: `apt`. Fedora and RHEL: `dnf`. Arch: `pacman`.
- Anything else: the tool's install page.

gh, Claude Code and Codex use their projects' own install commands.

For missing folder trust, doctor says to run `air serve` in a terminal: it asks before trusting
`workspace_root` in Claude Code (see [serving.md](serving.md#the-first-run)). It also gives the way to do it
by hand in Claude Code. There is no `air doctor --fix`: `air serve` is the one place air writes trust.
