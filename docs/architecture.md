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
- Production code never imports tests, `testing/`, `fixtures/` or `e2e/`. Tests, test helpers and `e2e/` may
  import anything.
- No import cycles, between files or between directories.
- A relative import names its file with the extension: `./x.ts`, `../package.json`. No extensionless, `.js` or
  directory imports, so an import's target is its path and nothing else.

## The boundary test

`src/boundaries.test.ts` holds the tables and runs the check in `scripts/boundaries.ts`. A file under
`src/<domain>/` is in that domain. The `DOMAIN` table places the files that have not moved yet. The test fails
on a production file with no domain, on an import that breaks the import form or names no file, and on a table
entry that matches nothing or says what a shorter entry or the file's directory already says, so the table
shrinks as files move. `ALLOWED` lists the violations of P0's tree (198), as `from -> to: rule`. A violation
not on the list fails the test, and so does a listed one that no longer occurs: the list only shrinks. Fix a
violation by changing the code, never by adding to the list.

## Moving files

```sh
node scripts/move.ts src/workspace/git.ts src/lib/git.ts [FROM TO ...]
```

moves each file with its tests (`x.test.ts`, `x.*.test.ts` and `x-*.test.ts`, unless a longer source name such
as `x-y.ts` owns the test) or a whole directory. It rewrites the relative imports in and to the moved files
across `src/` and `scripts/`, renames the paths (and moved directories) in the boundary test's `DOMAIN` and
`ALLOWED`, and lists other files that still mention an old path (plain-string paths are not rewritten). It
stops before changing anything on an import that breaks the import form or names no file, and when two files
would land on one path. A rerun finishes an interrupted one and otherwise changes nothing. Then `npm test`: the
boundary test says which `DOMAIN` entries to drop and which violations a move fixed or introduced.
