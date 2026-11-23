# Requesting work

The Claude Code skill (`air skill install`) is the usual way in. It runs the commands below for you.
Every command reads the requests repo from `~/.config/air/config.toml`, or takes `--repo OWNER/NAME`.

## After filing

```sh
air status 12             # state, who holds it, latest result
air wait 12 --timeout 4h  # block until there's a result
air fetch 12              # report, PR branches and artifacts into ./air-12/
air cancel 12             # stop it
air retry 12              # offer it again (--effort L to raise its budget)
```

`air wait` exits 0 for done, 3 for partial, 1 for failed or released, and 4 on timeout.

## Filing by hand

```sh
air submit ./inputs                              # prompts for the request, zips ./inputs, files the issue
air submit --body request.md --dry-run ./inputs  # print the final body and the zip's file list
air lint request.md                              # check a body against spec/v0.md
```

The request format is [spec/v0.md](../spec/v0.md). Longer examples are in
[spec/examples/](../spec/examples/).

### A short request

```markdown
---
air: 0
effort: S
harness: [any]
model: medium
deliver: comment
timeout: 1h
---

## Task

Summarise the open issues labelled `bug` in acme/widgets.

Group them by component and list the three that block the most users.

## Done when

- Every open `bug` issue appears in exactly one group.
- The top three each say why they were picked.
```

`effort` is what the job may cost; `model` is the least model tier it runs on (`small` is Haiku class,
`medium` Sonnet class, `large` Opus class; default `medium`). They are separate: a small job a Haiku-class
model can do runs on one only with `model: small`.

### The title

The issue title is the first line of `## Task`. A line over 80 characters is cut at a word and ends in
`...`; `air lint` warns when that happens. Pass `--title "..."` to `air submit` to set the title yourself.

## Context files

`air submit DIR` zips DIR for the agent. It honours `.gitignore` and skips `.git/`, `node_modules/` and
similar. `--exclude NAME` skips more.

Files that look like secrets (`.env*`, keys, credentials, token patterns) are refused. Pass
`--allow-file PATH` for each one you mean to send.

The zip goes on the requests repo's `air-context` release. It is kept while the issue is open, then 14 days
after it closes, or until `--expires YYYY-MM-DD`. `air serve` deletes expired zips once a day.

## Results

`air fetch` lays the result out like the volunteer's workspace:

- `REPORT.md`: the agent's report.
- `repo/<path>/`: each pull request's branch, or for a partial result, each checkpoint branch.
- `artifact/`: the artifact zip, unpacked.
- `out/`: a checkpoint's files.

Zips are checked against their size and SHA-256 before they are extracted.

## Cancel and retry

`air cancel` adds the `air:cancel` label. The server holding the request stops its agent, comments, and
gives it back. No server claims it again until `air retry`.

`air retry` offers a cancelled, failed or partial request again. A partial result's checkpoint goes into the
request, so the next server continues from it. It refuses while a server holds the request.

Both are for the issue's author or anyone with write access to the requests repo.

## The skill

`air skill install` puts the skill in `~/.claude/skills/ai-request`. `--dir DIR` installs it into one project
instead, and `--print` shows where it would go.

Re-run it after upgrading air to replace the older copy. It won't replace a directory that isn't the skill.
