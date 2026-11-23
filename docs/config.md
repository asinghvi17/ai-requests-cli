# Config

air's settings live in `~/.config/air/config.toml` (or `$XDG_CONFIG_HOME/air/config.toml`). The first
`air serve` or `air skill install` writes it, with every value spelled out. Edit it by hand after that.
Without a terminal to ask on, `air skill install` needs `--repo OWNER/NAME` to write it.

A running `air serve` reads the file again every tick, so an edit takes effect without a restart, except
`workspace_root`, which changes when it restarts. A file that doesn't parse is logged once, and the server
keeps the config it had. `[models]` and `[agents]` edits apply from the next agent launch, a resume of a
running job included; the startup check that each agent can run unattended runs again only on a restart.

## Top level

- `repo`: the requests repo, `OWNER/NAME`. Any command's `--repo` overrides it.
- `workspace_root` (default `~/air`): each job gets a fresh directory under it.
- `max_jobs` (default 1): jobs running at once.
- `tick_seconds` (default 60): how often `air serve` polls. A job's time limit is its request's `timeout`.

## `[subscriptions.NAME]`

One table per login air serves. A login with no table takes no work.

- `harness`: `claude` or `codex`.
- `window_usd`: the per-window budget: what air counts the login's whole weekly window as worth, in US
  dollars at API prices. The first run asks for it and suggests 500 (Enter takes it; 500 without a
  terminal). [serving.md](serving.md#budgets) shows how to check it. Without it, the login takes no work.
- `reserve` (default 0.3): the share of each window kept for you. air takes no new work past `1 - reserve` of
  the window used, until the last 24 hours before it resets.

## `[models.HARNESS]`

Maps a request's tier (`small`, `medium`, `large`) to a model. A request runs on the tier its `model` names,
`medium` when it names none; its effort doesn't change the tier. A request never runs below its tier.

## `[agents.HARNESS]`

How air starts each agent: `command` and `args`. air adds the session, model and prompt. The defaults:

- Claude Code: `claude --permission-mode auto`. In auto mode a classifier approves safe actions and blocks
  risky ones, without asking.
- Codex: `codex --ask-for-approval never --sandbox workspace-write -c sandbox_workspace_write.network_access=true`.

`--permission-mode bypassPermissions` and Codex's `--dangerously-bypass-approvals-and-sandbox` also pass
air's checks.

## Logins: `subscriptions.json`

`~/.config/air/subscriptions.json` lists the logins. Without it there are two: the default `claude` and
`codex` logins.

An entry can pick a login's config dir with `configDir` (Claude Code's `CLAUDE_CONFIG_DIR`) or `codexHome`
(`CODEX_HOME`).

For a login whose usage air can't read, give it a manual budget in dollars. Use the same name as its
`config.toml` table, whose `harness` says which agent it runs:

```json
[{ "name": "claude", "harness": "manual", "configDir": "/home/me/.claude-work", "reset": { "every": "weekly", "day": 0 }, "budget": { "usd": 500 } }]
```

## Manual budgets

`air serve` charges a manual budget each job's cost when the job ends. The final comment says
"Charged $X to manual budget `claude`."

air prices the tokens in the agent's own records: Claude Code's session transcripts, or Codex's rollout
files. The prices are one table in [`src/usage/prices.ts`](../src/usage/prices.ts).

A model missing from that table is not charged; `air serve` logs a warning. Spend made outside air (your own
use of the login) goes in with `air usage spend NAME USD`.
