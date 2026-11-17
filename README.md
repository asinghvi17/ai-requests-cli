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

## Volunteer quickstart

`~/.config/air/config.toml`:

```toml
repo = "org/requests"
workspace_root = "~/air"
max_jobs = 1

[subscriptions.claude]
harness = "claude"
scale = 4        # a Max 20x plan absorbs 4x the effort of a 5x one
reserve = 0.3    # keep 30% of each window for yourself

[models.claude]  # tier -> model; a request is never run below its tier
small = "haiku"
medium = "sonnet"
large = "opus"

[agents.claude]  # how air starts the agent
command = ["claude"]
args = ["--permission-mode", "acceptEdits"]   # whatever lets it work unattended on your machine
# Codex works the same way: [subscriptions.codex] with harness = "codex", [models.codex] and [agents.codex].
```

air reads each subscription's quota from its CLI. For a login whose usage it can't read, give it a manual
budget in `~/.config/air/subscriptions.json`, under the same name as in `config.toml`:

```json
[{ "name": "claude", "harness": "manual", "reset": { "every": "weekly", "day": 0 }, "budget": { "tokens": 50000000 } }]
```

`air serve` charges a manual budget what each job actually spent when the job ends (delivered, failed,
stopped early as partial, or cancelled), and the final comment says how much. It reads the spend from the
agent's own records:

- **Claude Code:** the transcripts of the job's sessions, `<CLAUDE_CONFIG_DIR or ~/.claude>/projects/*/<session>.jsonl`
  and its subagents' files beside them. Every API call counts once, with its input, cache-write, cache-read
  and output tokens.
- **Codex:** the rollouts `<CODEX_HOME or ~/.codex>/sessions/*/*/*/rollout-*.jsonl` that the job's sessions
  wrote in its workspace, each session at its last `token_count` total (`total_tokens`: input, cached input
  included, plus output).

Both report tokens, so only a budget in `tokens` is charged. A budget in `percent` is never charged by
`air serve`, since no agent reports what share of a plan a job used, and neither is a job whose agent left
no record air can read: the final comment says so. Spend made outside air (your own use of the login)
goes in with `air usage spend NAME AMOUNT`, in the budget's unit.

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
