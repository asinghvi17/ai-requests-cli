---
air: 0
effort: S                  # XS $1 | S $3 | M $10 | L $30 | XL $100 at API prices
deliver: pr                # pr | artifact | comment
# model: medium            # small | medium | large
# harness: [any]           # claude | codex | any
repos:                     # omit for none
  - url: https://github.com/org/repo.git
    ref: main              # a branch, for deliver: pr
  - url: https://github.com/org/docs.git
    ref: main
    deliver: none          # read-only
setup:
  - cd repo/repo && npm ci
check: cd repo/repo && npm test
# timeout: 4h
# deadline: 2026-12-31
---

## Task

One-line summary: this line becomes the issue title.

Full instructions for an agent that has never met you: the goal, the files and functions involved, and
what not to touch.

## Done when

- `npm test` passes in `repo/repo`
- A PR adds ... with tests for ...
- `out/REPORT.md` explains ...

## Context

- `repo/repo/src/...`: where to start.
- `repo/docs`: the style guide (read-only).
- `context/`: the files passed to `air submit DIR`, if any.

## Notes

Constraints, style and known pitfalls. Delete this section if there are none.
