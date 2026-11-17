# ai-requests-cli

`air`: file AI work as GitHub issues and serve them from spare subscription quota. A request is a GitHub
issue carrying a versioned YAML front-matter block (`air: 0`, `effort`, `harness`, `repos`, `setup`, `check`,
`deliver`, ...). `air submit` files requests; `air serve` runs on a volunteer's machine, polls the requests
repo, claims issues whose effort fits the local Claude/Codex quota, prepares a workspace and starts an agent
in a tmux window (`tmux -L air`). TypeScript on Node 26 with zero runtime dependencies; all GitHub access
goes through the user's `gh` CLI. See CONVENTIONS.md for the layout and docs/decisions.md for the decision log.

## Install

Download the binary for your platform (`air-linux-x64`, `air-linux-arm64`, `air-darwin-arm64`,
`air-darwin-x64`) from the latest release, with curl:

```sh
curl -fLo ~/.local/bin/air https://github.com/asinghvi17/ai-requests-cli/releases/latest/download/air-darwin-arm64
chmod +x ~/.local/bin/air
```

or with gh:

```sh
gh release download --repo asinghvi17/ai-requests-cli --pattern air-darwin-arm64 --output ~/.local/bin/air
chmod +x ~/.local/bin/air
```

**macOS:** a binary downloaded with a browser is quarantined; clear that with
`xattr -d com.apple.quarantine ~/.local/bin/air`. curl, gh and scp installs aren't quarantined.

air also needs the GitHub CLI, logged in (`gh auth login`). Volunteers need tmux and `claude` or `codex`.

## Requester quickstart

```sh
air submit --repo org/requests ./inputs     # prompts for the request, zips ./inputs, files the issue
air submit --body request.md --dry-run ./inputs   # print the final body and the zip's file list
air lint request.md                          # check a body against spec/v0.md
```

`DIR` is zipped honouring `.gitignore` and skipping `.git/`, `node_modules/` and similar (`--exclude NAME`
adds more). Files that look like secrets (`.env*`, keys, credentials, token patterns) are refused unless you
pass `--allow-file PATH` for each. The zip goes on the requests repo's `air-context` release. It is kept while
the issue is open or being worked on, then 14 days after it closes, or until `--expires YYYY-MM-DD` if you
give one. `air sweep` (which `air serve` runs daily) deletes expired zips.

Then follow it:

```sh
air status 12             # state label, holder, latest result (--json for scripts)
air wait 12 --timeout 4h  # block until there's a result; exit 0 done, 3 partial, 1 failed/released, 4 timeout
air fetch 12              # report, PR branches, artifact and checkpoint into ./air-12/
air retry 12              # offer it again after a cancel, failure or partial result (--effort L to raise it)
```

`air fetch` lays the result out like the volunteer's workspace: `REPORT.md`, `repo/<path>/` for each pull
request's branch (or, for a partial result, each checkpoint branch), `artifact/` for an artifact zip and
`out/` for a checkpoint's files. Zips are checked against their size and SHA-256 and extracted with the same
zip-slip and size checks a server uses. `air retry` is the only way to offer a request again: it refuses
while a server holds the request, points a partial result's checkpoint into the body's `resume` so the
next server continues from it, then removes every `air:*` label (`air:cancel` too). To stop a running
request, add the `air:cancel` label.

### From Claude Code

```sh
air skill install          # the ai-request skill, into ~/.claude/skills/ai-request/
air skill install --dir .claude/skills/ai-request   # or into one project
air skill install --print  # where it would go
```

Then, in any Claude Code session, say "hand this off as an AI request" or "file an air request". The skill
gathers the task, the repos it touches and any context files, estimates `effort`, picks `deliver: pr` or
`artifact`, writes the body, checks it with `air lint` and `air submit --dry-run`, and files it only after
you say yes. Re-run `air skill install` after upgrading air to replace the older copy. It refuses to
replace a directory that isn't the skill.

## Volunteer quickstart

`~/.config/air/config.toml`:

```toml
repo = "org/requests"
workspace_root = "~/air"
max_jobs = 1

[subscriptions.claude]
harness = "claude"
window_usd = 1000  # what a full weekly window is worth at API prices (see below)
reserve = 0.3      # keep 30% of each window for yourself

[models.claude]  # tier -> model; a request is never run below its tier
small = "haiku"
medium = "sonnet"
large = "opus"

[agents.claude]  # how air starts the agent
command = ["claude"]
args = ["--permission-mode", "acceptEdits"]   # whatever lets it work unattended on your machine
# Codex works the same way: [subscriptions.codex] with harness = "codex", [models.codex] and [agents.codex].
```

Everything air budgets is in **US dollars at API prices**: the tokens an agent uses, priced at the model
provider's published per-token rates, whatever your plan actually costs. A request's `effort` is such an
estimate (XS $1, S $3, M $10, L $30, XL $100), so air claims a request when what a window has left, in
dollars, covers it plus the reserve.

air reads each subscription's quota from its CLI as a percentage of the window. `window_usd` says what the
whole (weekly) window is worth, so that 60% used of a $1000 window leaves $400. To estimate it, run a job or
two: each final comment gives the job's cost at API prices and the window's usage before and after, and
`window_usd` is about the cost divided by the share it used (a $12 job that moved the window from 40% to
41.5% puts it near $800). Without `window_usd` a readable subscription takes no requests.

For a login whose usage it can't read, give it a manual budget in dollars in
`~/.config/air/subscriptions.json`, under the same name as in `config.toml`:

```json
[{ "name": "claude", "harness": "manual", "reset": { "every": "weekly", "day": 0 }, "budget": { "usd": 500 } }]
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

The agent runs unattended in a fresh workspace under `workspace_root`, so start Claude Code there once by
hand: finish its first-run screens and trust `workspace_root` (subfolders inherit the trust). The agent
inherits the environment you start `air serve` in, every variable of it (git identity, proxy settings,
tokens), so it works as it would in your own shell. air only adds `AIR_WORKSPACE`, `AIR_CONTEXT` and
`AIR_OUT`, plus the subscription's `CLAUDE_CONFIG_DIR` or `CODEX_HOME` when `subscriptions.json` sets one.

Then check what quota air sees, and start serving:

```sh
air usage            # quota air reads for each subscription
air serve            # tick every 60 s: claim what fits, set it up, start the agent in tmux, deliver
air serve --manual   # claim and set up, but wait for `air run ISSUE`
air serve --once     # one tick, then wait for its jobs to finish (re-polls for up to 60 s if it finds nothing: --once-wait)
air attach [ISSUE]   # watch the server log (window 0) or a job
air stop ISSUE       # interrupt the agent; keeps the claim and workspace (air:paused)
air start ISSUE      # resume the agent's own session
air pause | resume   # stop or resume taking new work; running jobs continue
air release ISSUE    # give a claimed request back
```
