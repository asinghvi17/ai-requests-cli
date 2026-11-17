# ai-requests-cli

`air` hands AI work to colleagues who have spare Claude or Codex subscription quota. A request is a GitHub
issue in a shared requests repo. Requesters file them, and volunteers run `air serve`, which claims requests
that fit their quota and runs Claude Code or Codex on them unattended in tmux.

## Install

Download the binary for your platform (`air-linux-x64`, `air-linux-arm64`, `air-darwin-arm64`,
`air-darwin-x64`) from the latest release:

```sh
gh release download --repo asinghvi17/ai-requests-cli --pattern air-darwin-arm64 --output ~/.local/bin/air
chmod +x ~/.local/bin/air
```

air needs the GitHub CLI, logged in (`gh auth login`). Volunteers also need tmux and `claude` or `codex`.

## Request work

Once: name the requests repo and install the Claude Code skill.

```sh
air config init --repo org/requests   # the skill and every command read `repo` from ~/.config/air/config.toml
air skill install
```

Then, in any Claude Code session, say **"hand this off as an AI request"**. The skill gathers the task, the
repos it touches and any context files, writes the request, checks it, and files it with `air submit` once you
say yes. It gives you the issue's URL and number. Follow it with:

```sh
air status 12             # state, who holds it, latest result
air wait 12 --timeout 4h  # block until there's a result
air fetch 12              # report, PR branches and artifacts into ./air-12/
air cancel 12             # stop it: the server holding it stops its agent and gives it back
```

## Volunteer

```sh
air config init --repo org/requests   # unless you did above: Claude Code and Codex agents, both unattended
air doctor --fix                      # check each agent can run unattended; offers to set up folder trust
tmux new -s air-serve 'air serve'     # serve; detach with C-b d
air attach                            # watch: window 0 is the server log, one window per job
```

`air doctor` checks that each agent's binary runs, that its launch flags put it in an unattended mode, that
Claude Code has finished its first-run setup and trusts `workspace_root` (or a folder above it, but not above
a git repo that `workspace_root` is in). On a first run that trust is usually missing: `air doctor --fix` asks
"Trust ~/air for Claude Code? [y/N]" and, on yes, writes that one entry to Claude Code's `.claude.json`, as
answering "Yes, I trust this folder" in `workspace_root` would. `air config init` offers to run it, and plain
`air doctor` only reads. Codex needs nothing: `air serve` tells it to trust each job's directory when it starts
it. `air serve` runs the same check at startup and takes no new work for an agent that fails it. Other agents
keep working.

While a job runs, `air serve` reads its tmux pane on every tick. If the agent has sat at a prompt (a
permission request, folder trust, onboarding, a Codex approval) for a minute, or its screen hasn't changed for
15 minutes, the server log names the job, the prompt and the fix. The tmux status bar shows it too, and so
does `air status ISSUE` on your machine. A prompt, not a quiet screen, also gets a comment on the issue
saying the job is waiting on the volunteer: one per prompt, at most 3 per job. The job keeps running, and the
request's `timeout` still applies.

## Reference

### Filing by hand

The skill runs these for you; they also work on their own.

```sh
air submit --repo org/requests ./inputs           # prompts for the request, zips ./inputs, files the issue
air submit --body request.md --dry-run ./inputs   # print the final body and the zip's file list
air lint request.md                               # check a body against spec/v0.md
air cancel 12                                     # cancel it (adds the air:cancel label)
air retry 12                                      # offer it again after a cancel, failure or partial result (--effort L to raise it)
```

`DIR` is zipped honouring `.gitignore` and skipping `.git/`, `node_modules/` and similar (`--exclude NAME`
adds more). Files that look like secrets (`.env*`, keys, credentials, token patterns) are refused unless you
pass `--allow-file PATH` for each. The zip goes on the requests repo's `air-context` release. It is kept while
the issue is open or being worked on, then 14 days after it closes, or until `--expires YYYY-MM-DD` if you
give one. `air sweep` (which `air serve` runs daily) deletes expired zips.

`air wait` exits 0 for done, 3 for partial, 1 for failed or released and 4 on timeout. `air fetch` lays the
result out like the volunteer's workspace: `REPORT.md`, `repo/<path>/` for each pull request's branch (or, for
a partial result, each checkpoint branch), `artifact/` for an artifact zip and `out/` for a checkpoint's files.
An artifact zip holds the agent's `out/` without `out/PROGRESS.md` (its notes for resuming); a checkpoint
keeps it, since the resumed agent reads it.
Zips are checked against their size and SHA-256 and extracted with the same zip-slip and size checks a server
uses. `air retry` is the only way to offer a request again: it refuses while a server holds the request,
points a partial result's checkpoint into the body's `resume` so the next server continues from it, then
removes every `air:*` label (`air:cancel` too). `air cancel` is the one way to cancel: it adds the
`air:cancel` label (creating it if the repo lacks it), the server holding the request stops its agent,
comments and gives it back, and no server claims it until `air retry`. Like `air retry`, it is for the
issue's author or anyone with write access to the requests repo. `air serve` creates every air label a
fresh requests repo lacks when it starts.

`air skill install --dir .claude/skills/ai-request` installs the skill into one project; `--print` shows
where it would go. Re-run it after upgrading air to replace the older copy. It refuses to replace a directory
that isn't the skill.

### Config

`air config init` writes every setting with its default; `--print` shows the file without writing it. It
won't overwrite an existing config. The keys:

- `repo`: the requests repo (or pass `--repo`). `workspace_root`: each job gets a fresh directory under it.
  `max_jobs`: jobs at once. `tick_seconds`: how often `air serve` polls. A job's time limit is its request's
  `timeout`.
- `[subscriptions.NAME]`: per login, `harness`, `window_usd` (what its whole weekly window is worth at API
  prices, below) and `reserve` (the share of each window kept for you). `air config init` writes
  `window_usd = 1000` as a starting guess; calibrate it from your first jobs.
- `[models.HARNESS]`: request tier (`small`, `medium`, `large`) to model. A request never runs below its tier.
- `[agents.HARNESS]`: `command` and `args`. air adds the session, model and prompt. The defaults are
  `claude --permission-mode auto` (Claude Code's auto mode: a classifier approves safe actions and blocks risky
  ones) and `codex --ask-for-approval never --sandbox workspace-write -c
  sandbox_workspace_write.network_access=true`. `--permission-mode bypassPermissions` and Codex's
  `--dangerously-bypass-approvals-and-sandbox` also pass `air doctor`.

Everything air budgets is in **US dollars at API prices**: the tokens an agent uses, priced at the model
provider's published per-token rates, whatever your plan actually costs. A request's `effort` is such an
estimate (XS $1, S $3, M $10, L $30, XL $100), so air claims a request when what a window has left, in
dollars, covers it plus the reserve.

air reads each subscription's quota from its CLI as a percentage of the window. `window_usd` says what the
whole (weekly) window is worth, so that 60% used of a $1000 window leaves $400. To estimate it, run a job or
two: each final comment gives the job's cost at API prices and the window's usage before and after, and
`window_usd` is about the cost divided by the share it used (a $12 job that moved the window from 40% to
41.5% puts it near $800). Without `window_usd` a readable subscription takes no requests.

The logins are listed in `~/.config/air/subscriptions.json`; with no file, they are the default `claude` and
`codex` logins. An entry may set `configDir` (Claude Code's `CLAUDE_CONFIG_DIR`) or `codexHome` (`CODEX_HOME`)
to pick a login. For a login whose usage air can't read, give it a manual budget in dollars there, under the
same name as in `config.toml`, whose `harness` there says which agent it runs:

```json
[{ "name": "claude", "harness": "manual", "configDir": "/home/me/.claude-work", "reset": { "every": "weekly", "day": 0 }, "budget": { "usd": 500 } }]
```

`air serve` charges a manual budget each job's cost when the job ends (delivered, failed, stopped early as
partial, or cancelled), and the final comment says "Charged $X to manual budget `claude`." It prices the
tokens in the agent's own records:

- **Claude Code:** the transcripts of the job's sessions, `<CLAUDE_CONFIG_DIR or ~/.claude>/projects/*/<session>.jsonl`
  and its subagents' files beside them. Every API call counts once, its input, 5-minute and 1-hour cache
  writes, cache reads and output priced at its model's rates (fast mode and US-only inference included).
  Claude Code writes its own total only when a session exits, so air prices the tokens itself; for a
  finished session the two agree.
- **Codex:** the rollouts `<CODEX_HOME or ~/.codex>/sessions/*/*/*/rollout-*.jsonl` that the job's sessions
  wrote in its workspace. Each increase of a session's `token_count` total is priced at the model then in
  use, cached input at the cached rate.

The prices are one table in [`src/usage/prices.ts`](src/usage/prices.ts), keyed by model id, with the page
each came from. A model that isn't in it is not charged: `air serve` logs a warning naming the model and
the final comment says its calls were left out. A job whose agent left no record air can read isn't
charged either, and the final comment says so. A job that costs more than twice its effort's dollars is
stopped early as partial. Spend made outside air (your own use of the login) goes in with
`air usage spend NAME USD`.

The agent inherits the environment you start `air serve` in, every variable of it (git identity, proxy
settings, tokens), so it works as it would in your own shell. air only adds `AIR_WORKSPACE`, `AIR_CONTEXT`
and `AIR_OUT`, plus the login's `CLAUDE_CONFIG_DIR` or `CODEX_HOME` when `subscriptions.json` sets one.
It removes the variables that Claude Code and Codex set for the commands they run, so `air serve` can be
started from inside either: `CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_SESSION_ID`,
`CLAUDE_CODE_SESSION_ATTENDED`, `CLAUDE_PID`, `CLAUDE_EFFORT`, `AI_AGENT`, `CLAUDE_CODE_ENTRYPOINT`,
`CLAUDE_CODE_EXECPATH`, `CODEX_THREAD_ID`, `CODEX_TOOL_CALL_ID`, `CODEX_SANDBOX`,
`CODEX_SANDBOX_NETWORK_DISABLED` and `CODEX_CI`. Left in place, they make the agent take itself for a
child of that session: a Claude Code that inherits `CLAUDE_CODE_CHILD_SESSION` saves no transcript, so its
job would have no usage record and no cost.
`air doctor` checks each agent with that same environment and config dir.

### Serving

```sh
air usage            # quota air reads for each subscription config.toml names
air serve            # tick every 60 s: claim what fits, set it up, start the agent in tmux, deliver
air serve --manual   # claim and set up, but wait for `air run ISSUE`
air serve --once     # one tick, then wait for its jobs to finish (re-polls for up to 60 s if it finds nothing: --once-wait)
air attach [ISSUE]   # watch the server log (window 0) or a job
air stop ISSUE       # interrupt the agent; keeps the claim and workspace (air:paused)
air start ISSUE      # resume the agent's own session
air pause | resume   # stop or resume taking new work; running jobs continue
air release ISSUE    # give a claimed request back
```

The tmux server is private: `tmux -L air attach` reaches it without air.

### Other installs

With curl instead of gh:

```sh
curl -fLo ~/.local/bin/air https://github.com/asinghvi17/ai-requests-cli/releases/latest/download/air-darwin-arm64
chmod +x ~/.local/bin/air
```

`air --version` prints the version a binary was built from: `package.json`'s version, plus the git short
SHA (`0.1.0+5c79762`) for a build that isn't a tagged release.

**macOS:** a binary downloaded with a browser is quarantined; clear that with
`xattr -d com.apple.quarantine ~/.local/bin/air`. curl, gh and scp installs aren't quarantined.

### How it works

A request is a GitHub issue carrying a versioned YAML front-matter block (`air: 0`, `effort`, `harness`,
`repos`, `setup`, `check`, `deliver`, ...); spec/v0.md defines it. `air serve` polls the requests repo, claims
issues whose effort fits the local quota, prepares a workspace and starts the agent in a tmux window. air is
TypeScript on Node 26 with zero runtime dependencies; all GitHub access goes through the user's `gh` CLI. See
CONVENTIONS.md for the layout and docs/decisions.md for the decision log.
