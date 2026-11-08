# ai-requests-cli

`air`: file AI work as GitHub issues and serve them from spare subscription quota. A request is a GitHub
issue carrying a versioned YAML front-matter block (`air: 0`, `effort`, `harness`, `repo`, `setup`, `check`,
`deliver`, ...). `air submit` files requests; `air serve` runs on a volunteer's machine, polls the requests
repo, claims issues whose effort fits the local Claude/Codex quota, prepares a workspace and starts an agent
in a tmux window (`tmux -L air`). TypeScript on Node 26 with zero runtime dependencies; all GitHub access
goes through the user's `gh` CLI. See CONVENTIONS.md for the layout and docs/decisions.md for the decision log.

## Serving

```sh
air serve            # tick every 60 s: claim what fits, set it up, start the agent in tmux, deliver
air serve --manual   # claim and set up, but wait for `air run ISSUE`
air serve --once     # one tick, then wait for its jobs to finish (re-polls for up to 60 s if it finds nothing: --once-wait)
air attach [ISSUE]   # watch the server log (window 0) or a job
air stop ISSUE       # interrupt the agent; keeps the claim and workspace (air:paused)
air start ISSUE      # resume the agent's own session
air pause | resume   # stop or resume taking new work; running jobs continue
```

Agents are configured in `~/.config/air/config.toml`:

```toml
[agents.claude]
command = ["claude"]
args = ["--permission-mode", "acceptEdits"]   # whatever lets it work unattended on your machine
```
