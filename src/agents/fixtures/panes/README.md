Visible tmux pane text (`tmux capture-pane -p`) of agents waiting at a prompt, for `prompts.test.ts`.

Captured from the installed CLIs, each run in a 120x40 tmux window with a fresh, throwaway config dir
(paths replaced by `/home/u/air/o__requests/12-abc`):

| File | CLI | How |
| --- | --- | --- |
| `claude-onboarding.txt` | Claude Code 2.1.311 | empty `CLAUDE_CONFIG_DIR` |
| `claude-trust.txt` | Claude Code 2.1.311 | onboarded config, untrusted folder |
| `claude-bypass.txt` | Claude Code 2.1.311 | trusted folder, `--permission-mode bypassPermissions` |
| `claude-auto-working.txt` | Claude Code 2.1.311 | trusted folder, `--permission-mode auto`: no prompt (a fake API key fails the turn) |
| `codex-login.txt` | Codex CLI 0.164.0 | empty `CODEX_HOME` |
| `codex-trust.txt` | Codex CLI 0.164.0 | API-key login, a git repo, `-a never -s workspace-write` |

Composed: `claude-output-mentions-prompt.txt`, an idle Claude Code screen whose output quotes prompt text
(it must match nothing), and, because producing them needs a working model login, `claude-permission.txt` and
`codex-approval.txt`, laid out like the real prompts from the strings in each CLI's binary ("Do you want to
proceed?", "Yes, and don't ask again for", "Esc to cancel"; "Would you like to run the following command?").

Ready screens, for `agentReady` (`serve.test.ts`): `claude-ready.txt` (Claude Code 2.1.311, onboarded config,
trusted folder, `--permission-mode auto`, an approved fake API key) and `codex-ready.txt` (Codex CLI 0.164.0,
API-key login, the job dir trusted with `-c projects={...}`, `-a never -s workspace-write`): each CLI's empty
input box, as air finds it before it pastes the task.
