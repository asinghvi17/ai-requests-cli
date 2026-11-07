---
name: AI request
about: Hand a piece of AI work to a colleague with spare Claude/Codex quota
title: ''
labels: ai-request
---
---
air: 0          # spec version; see spec/v0.md
effort: S       # XS 1% | S 3% | M 8% | L 20% | XL 40% of a weekly usage window
deliver: comment  # comment | pr (needs repo) | artifact (files left in $AIR_OUT)
# harness: [any]          # claude | codex | any
# model: medium           # small | medium | large (minimum tier)
# repo:
#   url: https://github.com/org/repo.git
#   ref: main             # branch, tag or commit; must be a branch for deliver: pr
# context:                # zip of inputs, uploaded to this repo's air-context release
#   url: https://github.com/org/requests/releases/download/air-context/inputs.zip
#   sha256: <output of sha256sum inputs.zip>
#   bytes: <size in bytes>
#   expires: 2026-12-31   # optional; default 14 days after this issue closes
# setup:                  # run in repo/ (or the workspace) before the agent starts
#   - "make deps"
# check: "make test"      # exit 0 = setup worked
#                         # quote values YAML would read as numbers/booleans: ref: "1.10"
# deadline: 2026-12-01
# timeout: 4h             # 1m to 24h
---

## Task

<!-- What should the agent do? Write for someone who has never met you and can't ask you questions:
     name files, functions, people's preferences, and what not to touch. -->

## Done when

<!-- A list of checkable criteria, e.g.
- `make test` passes
- The new function is documented in docs/api.md -->

## Context

<!-- Required if you set `repo` or `context`: what is in them and where to start looking. Delete otherwise. -->

## Notes

<!-- Optional: constraints, style, known pitfalls. -->
