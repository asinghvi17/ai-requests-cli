# Architecture

air is moving, in phases, to the layout below. `src/boundaries.test.ts` enforces the rules on every import
under `src/`, and `scripts/move.ts` moves files. Phase P0 added both and moved nothing.

Phase P1 moved the shared code into `src/lib/`: `toml.ts`, `version.ts`, `pid.ts`, `lock.ts` (was
`usage/lock.ts`), `exec.ts` (was `workspace/exec.ts`), `zip.ts` and its test helper `zip-fixture.ts` (were in
`workspace/`), `zipwrite.ts` (was `submit/`) and `zipout.ts` (was `serve/`). Other domains import them through
`lib/index.ts`. Two files the plan put in `lib` stay where they are:

- `workspace/git.ts` imported `RepoEntry` from `spec/frontmatter.ts` (request). P3 cut that and moved it.
- `usage/run.ts` imports nothing, but it is about the agents' usage CLIs: the environment allowlist names
  their logins (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `CLAUDE_CODE_OAUTH_TOKEN`) and `windowOfMinutes` names
  Codex's quota windows. It is in `agents`, with the rest of `usage/`. Its generic part (`run`, `killGroup`,
  `command`) can move to `lib` once it is split out.

Phase P2 gathered the GitHub access in `src/gh/`. The client (`gh.ts`, `issues.ts`, `releases.ts`) was there
already; its in-memory fakes moved to `gh/testing/`: `fake.ts`, `releases-fake.ts` and `fake-gh.ts` (was
`serve/fake-gh.ts`). Other domains import the client through `gh/index.ts`. One file stays where it is:

- `serve/github.ts` (`serveGitHub`: open requests, the artifacts release, pull requests) is `gh api` code, but
  `openRequests` lists issues by `REQUEST_LABEL`, which it imports from `claim/claim.ts` (server). It stays in
  `server` and imports the client through `gh/index.ts`. It can move to `gh` once the label is passed in
  rather than imported. Its `ARTIFACTS_TAG` duplicates the one in `gh/releases.ts`.

Phase P3 moved the request domain into `src/request/`, flat, in one step (the plan had no P3a/P3b split that
said otherwise): `frontmatter.ts`, `lint.ts`, `markers.ts` (were in `spec/`), `text.ts` and `trust.ts` (were
in `claim/`), `context.ts` (was `workspace/context.ts`; the plan's "assets"), `cancel.ts`, `fetch.ts`,
`retry.ts`, `status.ts` (were in `requester/`), `submit.ts`, `collect.ts`, `secrets.ts` (were in `submit/`),
`sweep.ts` (was `sweep/`), and `skill/` (was `src/skill/`; it imports only `lib`, so it can be a directory
without a directory cycle). The two `fixture.ts` test helpers are `request/testing/requester.ts` and
`request/testing/submit.ts`. Other domains import the request domain through `request/index.ts`. Beyond moves:

- `labels.ts` is new: the label constants (`REQUEST_LABEL`, `CANCEL_LABEL`, `STATE_LABELS`, `HELD_LABELS`,
  `LABELS`), cut unchanged from `claim/claim.ts`, so `cancel.ts`, `retry.ts` and `status.ts` no longer import
  the server. `serve/github.ts` now takes `REQUEST_LABEL` from `request/index.ts`, and `serve/deliver.ts`
  takes `ARTIFACTS_TAG` from `gh/index.ts`: `serve/github.ts`'s copy is gone.
- `workspace/git.ts` moved to `lib/git.ts`, with its test and `git-fixture.ts`: `resolveRepo` takes a local
  `{ url, ref?, pr? }` type instead of `RepoEntry`, which `RepoEntry` satisfies. Otherwise `request/fetch.ts`
  → `workspace/git.ts` → `request/frontmatter.ts` would have been a directory cycle.
- Not done: the plan's `vocab.ts` (the front-matter vocabulary `agents` may import) would be a split of
  `frontmatter.ts`, so `workspace/task.ts` → `request/frontmatter.ts` stays on `ALLOWED`. "template" names
  no file today (`blankTemplateHeader` is in `submit.ts`).

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
