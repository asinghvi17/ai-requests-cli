---
name: ai-request
description: Hand a piece of work off as an air AI request, a GitHub issue that a colleague's agent picks up and does with their spare Claude/Codex quota. Use when the user says "hand this off as an AI request", "file an air request", "make this an air request", "send this to air", or asks to delegate a task to someone else's agent.
---

# File an AI request

An AI request is a GitHub issue in the team's requests repo. A colleague's `air serve` claims it, sets up a
fresh workspace, and runs an agent that has never seen this conversation and can't ask questions. The
format is spec/v0.md (https://github.com/asinghvi17/ai-requests-cli/blob/main/spec/v0.md). Read §2–§4 and §6
there for the exact field rules. This skill doesn't repeat them. `template.md` next to this file is the
body's skeleton.

## 1. Check the tools

Run `air --version` and `gh auth status`. The requests repo is the `repo` in `~/.config/air/config.toml`.
If there's none, ask for it and pass `--repo OWNER/NAME` to every `air` command below.

## 2. Gather

- **Task**: what to do and why, in the user's words, plus what not to touch. Ask about anything the agent
  would otherwise have to guess.
- **Repos**: one `repos:` entry per repo the work reads or changes. `url` is the `https://` clone URL
  (`git remote get-url origin`, with an `git@host:o/r.git` URL rewritten to `https://host/o/r.git`). `ref`
  is a branch, tag or quoted commit SHA, or use `pr: N`. Repos the agent only reads get `deliver: none`.
  The volunteer clones from the remote, so if the work depends on local commits or changes, have the
  user push them to a branch first and use that branch.
- **Context files**: inputs that aren't in a repo (logs, data, screenshots, notes). Copy them into a fresh
  directory, such as one from `mktemp -d`, and pass that directory to `air submit`, which zips and uploads it
  and fills in `context:`. Never write `context:` by hand. air refuses files that look like secrets, so
  leave them out rather than reaching for `--allow-file`.

## 3. Estimate and choose

- **effort**: the expected cost in US dollars at API prices (the agent's tokens at the model's published
  rates). Use `XS` ($1) for a quick lookup or a one-file fix, `S` ($3) for a small change with tests, `M`
  ($10) for a feature across a few files, `L` ($30) for a multi-repo change or a deep investigation, and
  `XL` ($100) for a long migration. Estimate on the high side, because a job that costs more than twice
  its effort's dollars is stopped early as `partial`.
- **deliver**: `pr` when the result is code changes to repos the user can push to. Each repo without
  `deliver: none` must use a branch `ref`, and each one gets its own PR. `artifact` when the result is
  files, such as data, a report with figures, or a patch for a repo the user can't push to. Those go in
  `$AIR_OUT` and come back as a zip. Use `comment` only for a short text answer.
- `model` (`small`/`medium`/`large`), `harness`, `timeout` (default `4h`) and `deadline`, when the task
  needs them.

Tell the user the effort and deliver you picked, with a one-line reason for each.

## 4. Write the body

Write it to a file outside the user's repos, such as `"$(mktemp -d)/request.md"`, following
`template.md` and spec/v0.md:

- front matter: `air: 0`, `effort`, `deliver`, `repos`, and the optional fields chosen above;
- setup: `setup:` commands that install dependencies (they run with `sh -c` in the workspace root, so start
  each with `cd repo/<path> &&`), and a `check:` command that exits 0 when setup worked;
- `## Task`: its first line is a one-line summary that becomes the issue title. Then the full
  instructions, written for someone who has never met the user. Name files, functions and constraints;
- `## Done when`: a list of checkable criteria, such as tests passing, files produced, or what
  `out/REPORT.md` must say;
- `## Context` (required with `repos` or a context directory): what each repo and file is and where to
  start. Add `## Notes` for pitfalls or style, if there are any.

Quote YAML values that would read as numbers or booleans (`ref: "1.10"`, every commit SHA).

## 5. Validate

```sh
air lint request.md
air submit --body request.md --dry-run [DIR]
```

`air lint` checks the body against the spec. `--dry-run` also fills in the context zip, lists the files it
would upload, and prints the final title and body without filing anything. Fix every error and re-run
until both pass. Treat warnings as errors unless there's a reason to keep them.

## 6. Confirm, then file

Show the user the dry run's title, final body and file list, and ask whether to file it. File only after
an explicit yes. If they want changes, edit and go back to step 5.

```sh
air submit --body request.md [DIR]
```

It prints the issue URL. Report that URL and the issue number to the user.

## 7. Follow up

Offer these for the issue number `N`:

- `air status N`: the state label, the server holding it, and the latest result.
- `air wait N --timeout 4h`: blocks until there's a result. It exits 0 for done, 3 for partial, 1 for
  failed or released, and 4 on timeout.
- `air fetch N [DIR]`: downloads the report, the PR branches, the artifact and any checkpoint into
  `./air-N/`.

After a failed or partial result, `air retry N` offers the request again (`--effort` raises the estimate).
