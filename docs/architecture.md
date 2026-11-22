# Architecture

air is moving, in phases, to the layout below. `src/boundaries.test.ts` enforces the rules on every import
under `src/`, and `scripts/move.ts` moves files. Phase P0 added both and moved nothing.

## Layout

| Domain | Contents |
| --- | --- |
| `src/lib/` | no air knowledge: toml, version, markdown, paths, fs/locks, exec, git, zip |
| `src/gh/` | the GitHub client (`gh api`); in-memory fakes under `gh/testing/` |
| `src/request/` | the request and its lifecycle as GitHub sees it: vocab, frontmatter, lint, markers, labels, trust, template, assets, sweep, submit, requester, skill |
| `src/agents/` | the coding agents: harness, instructions, launch, prompts, probe, claude-trust, cost, usage |
| `src/setup/` | a volunteer's machine: config, gh-login, onboarding, preflight |
| `src/server/` | `air serve`: loop, context, state, match, start, debug, claim, jobs, workspace (per-job workspace prep), tmux |
| `src/cli/` | a thin router, one file per command |
| `src/e2e/` | end-to-end tests |

## Rules

- `lib` imports nothing internal.
- `gh` imports `lib`.
- `request` imports `lib` and `gh`.
- `agents` imports `lib`, and from `request` only `request/vocab.ts`.
- `setup` imports `lib` and `agents`.
- `server` imports everything but `cli`. `cli` imports everything.
- Across domains, import only `<domain>/index.ts` (and `request/vocab.ts` from `agents`).
- Production code never imports tests, `testing/` or `fixtures/`. Tests and test helpers may import anything.
- No import cycles, between files or between directories.

## The boundary test

A file under `src/<domain>/` is in that domain. The `DOMAIN` table in the test places the files that have
not moved yet; the test fails on a production file with no domain and on a table entry that matches nothing
or that a file's location already says, so the table shrinks as files move. `ALLOWED` lists the violations
of P0's tree (198), as `from -> to: rule`. A violation not on the list fails the test, and so does a listed one
that no longer occurs: the list only shrinks. Fix a violation by changing the code, never by adding to the list.

## Moving files

```sh
node scripts/move.ts src/workspace/git.ts src/lib/git.ts [FROM TO ...]
```

moves each file with its tests (or a whole directory), rewrites the relative imports in and to the moved
files across `src/` and `scripts/`, renames the paths in the boundary test's `DOMAIN` and `ALLOWED`, and
lists other files that still mention an old path (plain-string paths are not rewritten). Moves already done
are skipped, so a rerun changes nothing. Then `npm test`: the boundary test says which `DOMAIN` entries to
drop and which violations a move fixed or introduced.
