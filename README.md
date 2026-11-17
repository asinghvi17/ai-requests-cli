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
```

## Volunteer

```sh
air config init --repo org/requests   # unless you did above: Claude Code and Codex agents, both unattended
air doctor                            # check each agent can run unattended; it prints the fix for anything that can't
tmux new -s air-serve 'air serve'     # serve; detach with C-b d
air attach                            # watch: window 0 is the server log, one window per job
```

`air doctor` checks that each agent's binary runs, that its launch flags put it in an unattended mode, that
Claude Code has finished its first-run setup and trusts `workspace_root`, and, when `workspace_root` is in a
git repo, that Codex trusts that repo. Most first runs need one thing done by hand: start Claude Code in
`workspace_root` and answer "Yes, I trust this folder". `air serve` runs the same check at startup and takes no
new work for an agent that fails it. Other agents keep working.

While a job runs, `air serve` reads its tmux pane on every tick. If the agent stops at a prompt (a permission
request, folder trust, onboarding, a Codex approval) or its screen hasn't changed for 5 minutes, the server
log names the job, the prompt and the fix. The tmux status bar shows it too, and so does `air status ISSUE` on your machine.
The issue gets one comment saying the job is waiting on the volunteer. The job keeps running, and the
request's `timeout` still applies.

## Reference

### Filing by hand

The skill runs these for you; they also work on their own.

```sh
air submit --repo org/requests ./inputs           # prompts for the request, zips ./inputs, files the issue
air submit --body request.md --dry-run ./inputs   # print the final body and the zip's file list
air lint request.md                               # check a body against spec/v0.md
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
Zips are checked against their size and SHA-256 and extracted with the same zip-slip and size checks a server
uses. `air retry` is the only way to offer a request again: it refuses while a server holds the request,
points a partial result's checkpoint into the body's `resume` so the next server continues from it, then
removes every `air:*` label (`air:cancel` too). To stop a running request, add the `air:cancel` label.

`air skill install --dir .claude/skills/ai-request` installs the skill into one project; `--print` shows
where it would go. Re-run it after upgrading air to replace the older copy. It refuses to replace a directory
that isn't the skill.

### Config

`air config init` writes every setting with its default; `--print` shows the file without writing it. It
won't overwrite an existing config. The keys:

- `repo`: the requests repo (or pass `--repo`). `workspace_root`: each job gets a fresh directory under it.
  `max_jobs`: jobs at once. `tick_seconds`: how often `air serve` polls. A job's time limit is its request's
  `timeout`.
- `[subscriptions.NAME]`: per login, `harness`, `scale` (a Max 20x plan absorbs 4x the effort of a 5x one) and
  `reserve` (the share of each usage window kept for you).
- `[models.HARNESS]`: request tier (`small`, `medium`, `large`) to model. A request never runs below its tier.
- `[agents.HARNESS]`: `command` and `args`. air adds the session, model and prompt. The defaults are
  `claude --permission-mode auto` (Claude Code's auto mode: a classifier approves safe actions and blocks risky
  ones) and `codex --ask-for-approval never --sandbox workspace-write -c
  sandbox_workspace_write.network_access=true`. `--permission-mode bypassPermissions` and Codex's
  `--dangerously-bypass-approvals-and-sandbox` also pass `air doctor`.

air reads each login's quota from its CLI. The logins are listed in `~/.config/air/subscriptions.json`; with
no file, they are the default `claude` and `codex` logins. An entry may set `configDir` (Claude Code's
`CLAUDE_CONFIG_DIR`) or `codexHome` (`CODEX_HOME`) to pick a login. For a login whose usage air can't read,
give it a manual budget there, under the same name as in `config.toml`, and record spend with
`air usage spend NAME AMOUNT`:

```json
[{ "name": "claude", "harness": "manual", "reset": { "every": "weekly", "day": 0 }, "budget": { "percent": 100 } }]
```

The agent gets an empty environment apart from basics such as `PATH`, `HOME` and `TMPDIR`, plus
`CLAUDE_CONFIG_DIR` or `CODEX_HOME`: its git identity comes from `~/.gitconfig`, and proxy variables such as
`HTTPS_PROXY` don't reach it.

### Serving

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

The tmux server is private: `tmux -L air attach` reaches it without air.

### Other installs

With curl instead of gh:

```sh
curl -fLo ~/.local/bin/air https://github.com/asinghvi17/ai-requests-cli/releases/latest/download/air-darwin-arm64
chmod +x ~/.local/bin/air
```

**macOS:** a binary downloaded with a browser is quarantined; clear that with
`xattr -d com.apple.quarantine ~/.local/bin/air`. curl, gh and scp installs aren't quarantined.

### How it works

A request is a GitHub issue carrying a versioned YAML front-matter block (`air: 0`, `effort`, `harness`,
`repos`, `setup`, `check`, `deliver`, ...); spec/v0.md defines it. `air serve` polls the requests repo, claims
issues whose effort fits the local quota, prepares a workspace and starts the agent in a tmux window. air is
TypeScript on Node 26 with zero runtime dependencies; all GitHub access goes through the user's `gh` CLI. See
CONVENTIONS.md for the layout and docs/decisions.md for the decision log.
