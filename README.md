# air

air hands AI work to colleagues who have spare Claude or Codex subscription quota.

A request is a GitHub issue in your team's requests repo. A volunteer's `air serve` picks it up, runs
Claude Code or Codex on it unattended, and posts the result back on the issue.

## Install

```sh
air="air-$(uname -s | tr A-Z a-z)-$(uname -m | sed 's/x86_64/x64/; s/aarch64/arm64/')"
gh release download --repo asinghvi17/ai-requests-cli --pattern "$air" --pattern SHA256SUMS --dir /tmp/air-dl --clobber
(cd /tmp/air-dl && grep " $air\$" SHA256SUMS | shasum -a 256 -c -) && install -m 755 "/tmp/air-dl/$air" ~/.local/bin/air
```

`~/.local/bin` must exist and be on your `PATH`. Run the same lines again to upgrade.

air needs the GitHub CLI (`gh`). Volunteers also need tmux, and Claude Code or Codex.

## Request work

```sh
air skill install
```

The first time, it asks for your team's requests repo (or pass `--repo OWNER/NAME`).

Then, in Claude Code, say **"hand this off as an AI request"**. The skill writes the request with you and
files it once you say yes. It gives you the issue number.

Or write the request yourself, in the [request format](spec/v0.md) ([more](docs/requesting.md#filing-by-hand)):

```sh
air lint request.md && air submit --repo OWNER/NAME --body request.md
```

You need write access to the requests repo, and to each target repo for `deliver: pr`.

```sh
air status 12   # who has it, and the latest result
air wait 12     # wait for the result
air fetch 12    # download the report, branches and files into ./air-12/
```

## Volunteer your quota

```sh
air serve
```

The first run sets itself up. It asks for the requests repo (or pass `--repo OWNER/NAME`), finds your
Claude and Codex subscriptions and asks each one's per-window budget (default $20, see
[budgets](docs/serving.md#budgets)), and asks before trusting `~/air` in Claude Code. Then it opens its own tmux session and shows you its log.

Detach with `C-b d` and it keeps serving. Run `air serve` again to come back. `C-c` stops it.

## More

- [docs/requesting.md](docs/requesting.md): filing by hand, cancel and retry, context files, results.
- [docs/serving.md](docs/serving.md): how claiming works, budgets, prompts, job commands.
- [docs/config.md](docs/config.md): every config setting.
- [spec/v0.md](spec/v0.md): the request format. [docs/decisions.md](docs/decisions.md): why things are the
  way they are. [CONVENTIONS.md](CONVENTIONS.md): the code layout.
