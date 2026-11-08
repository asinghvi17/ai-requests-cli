# ai-requests-cli

`air`: file AI work as GitHub issues and serve them from spare subscription quota. A request is a GitHub
issue carrying a versioned YAML front-matter block (`air: 0`, `effort`, `harness`, `repo`, `setup`, `check`,
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
