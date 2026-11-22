# air

air hands AI work to colleagues who have spare Claude or Codex subscription quota.

A request is a GitHub issue in your team's requests repo. A volunteer's `air serve` picks it up, runs
Claude Code or Codex on it unattended, and posts the result back on the issue.

## Install

```sh
gh release download --repo asinghvi17/ai-requests-cli --pattern air-darwin-arm64 --output ~/.local/bin/air
chmod +x ~/.local/bin/air
```

Pick your platform: `air-darwin-arm64`, `air-darwin-x64`, `air-linux-x64` or `air-linux-arm64`. Without gh,
`curl -fLo ~/.local/bin/air https://github.com/asinghvi17/ai-requests-cli/releases/latest/download/air-darwin-arm64`
works too.

macOS quarantines a binary downloaded in a browser: `xattr -d com.apple.quarantine ~/.local/bin/air` clears it.

air needs the GitHub CLI (`gh`). Volunteers also need tmux, and Claude Code or Codex.

## Request work

```sh
air skill install
```

The first time, it asks for your team's requests repo.

Then, in Claude Code, say **"hand this off as an AI request"**. The skill writes the request with you and
files it once you say yes. It gives you the issue number.

```sh
air status 12   # who has it, and the latest result
air wait 12     # wait for the result
air fetch 12    # download the report, branches and files into ./air-12/
```

## Volunteer your quota

```sh
air serve
```

The first run sets itself up. It asks for the requests repo, finds your Claude and Codex subscriptions,
and asks before trusting `~/air` in Claude Code. Then it opens its own tmux session and shows you its log.

Detach with `C-b d` and it keeps serving. Run `air serve` again to come back. `C-c` stops it.

## More

- [docs/requesting.md](docs/requesting.md): filing by hand, cancel and retry, context files, results.
- [docs/serving.md](docs/serving.md): how claiming works, budgets, prompts, job commands.
- [docs/config.md](docs/config.md): every config setting.
- [spec/v0.md](spec/v0.md): the request format. [docs/decisions.md](docs/decisions.md): why things are the
  way they are. [CONVENTIONS.md](CONVENTIONS.md): the code layout.
