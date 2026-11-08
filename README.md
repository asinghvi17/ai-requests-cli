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
pass `--allow-file PATH` for each. The zip goes on the requests repo's `air-context` release with an
expiry (`--expires`, default 30 days); `air sweep` deletes expired zips of closed requests.

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
# Codex works the same way: [subscriptions.codex] with harness = "codex", and a [models.codex] table.
```

Then check what quota air sees, and start serving:

```sh
air usage
air serve
```
