# Architecture

air's code is in seven domains under `src/`, with import rules between them. `src/boundaries.test.ts` enforces
the rules on every import under `src/`, and `scripts/move.ts` moves files. The layout was reached in phases P0
to P7 (docs/decisions.md has an entry for each); every file is now in its domain and nothing breaks a rule.

## Layout

| Domain | Contents |
| --- | --- |
| `src/lib/` | no air knowledge: the TOML subset (`toml.ts`), version, a command's output and `CommandError` (`io.ts`), pid and lock files, setup exec, git (resolve, clone, checkpoint), the zip reader and writers |
| `src/gh/` | the GitHub client (`gh api`): issues, comments and labels (`issues.ts`), release assets and repo-wide listings (`releases.ts`); in-memory fakes under `gh/testing/` |
| `src/request/` | the request and its lifecycle as GitHub sees it: front matter (`frontmatter.ts`), lint, markers, labels, trust, the template (`template.ts`), context zips (`context.ts`, the plan's "assets"), sweep, submit with file collection and the secrets check, the requester's side (`status.ts`, `fetch.ts`, `retry.ts`, `cancel.ts`), and skill install under `skill/` |
| `src/agents/` | the coding agents: command lines, ready screen and task handoff (`harness.ts`), launch environment (`launch.ts`), waiting prompts (`prompts.ts`), Claude Code folder trust (`claude-trust.ts`), and under `usage/` the subscription usage readers, prices and spend (the plan's "cost") |
| `src/setup/` | a volunteer's machine: config with the models and tiers (`config.ts`), the startup checks and agent probe (`preflight.ts`), install hints, the doctor checks (`doctor.ts`), first run (`firstrun.ts`: gh login, config, folder trust) |
| `src/server/` | `air serve`, flat: the loop (`server.ts`) and its lifecycle (`run.ts`: tmux window, serve lock, signals, closing the session), the serve context (`context.ts`), the serve lock and state (`state.ts`), matching (`match.ts`), the claim race and release (`claim.ts`, `repos.ts`), per-job workspace prep (`workspace-setup.ts`, `workspace-state.ts`, `workspace-env.ts`, `workspace-teardown.ts`, and `task.ts`, the plan's "instructions"), the job lifecycle (`jobs.ts`), delivery (`deliver.ts`, `github.ts`), cleanup (`tidy.ts`), `air debug panes` (`debug.ts`), and tmux under `tmux/` |
| `src/cli/` | a thin router, one file per command: argument parsing, dispatch and output |

Other domains import a domain through its `index.ts`. Two directories sit inside a domain: `request/skill/` and
`server/tmux/` import nothing from the rest of their domain, so they form no directory cycle. `agents/usage/`
imports only `lib`. The end-to-end suites (`*.e2e.test.ts`) are next to the code they drive; there is no
`src/e2e/`.

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

## Not done

What the phases left, each for its own change:

- `request/vocab.ts` (the front-matter vocabulary `agents` may import) is not split out of `frontmatter.ts`.
  `agents` imports nothing from `request` today: `server/task.ts`, which parses the request for the agent's
  task, is in `server`.
- `server/github.ts` (`serveGitHub`: open requests, the artifacts release, pull requests) is `gh api` code. It
  can move to `gh` once `REQUEST_LABEL` is passed in rather than imported from `request`.
- The generic part of `agents/usage/run.ts` (`run`, `killGroup`, `command`) can move to `lib` once split out.
- The models and tiers are in `setup/config.ts` and the agent probe in `setup/preflight.ts`, not in `agents`.
- `configPath` (`setup/config.ts`) and `configFile` (`agents/usage/index.ts`) find air's config directory
  differently: `configFile` honours `AIR_CONFIG_DIR` and takes `XDG_CONFIG_HOME` as it is; `configPath` ignores
  `AIR_CONFIG_DIR` and a relative `XDG_CONFIG_HOME`.
- The `--repo` and ISSUE parsing is in four copies in `cli` (`requests.ts`'s `target`, `submit.ts`'s
  `repoName`, `jobs.ts`'s `repoFlag` and `issueArg`, and `skill.ts`).

## The boundary test

`src/boundaries.test.ts` holds the tables and runs the check in `scripts/boundaries.ts`. A file under
`src/<domain>/` is in that domain; the `DOMAIN` table placed files that had not moved yet and is empty. The
test fails on a production file with no domain, on an import that breaks the import form or names no file, and
on a table entry that matches nothing or says what a shorter entry or the file's directory already says.
`ALLOWED` listed the violations still to fix, as `from -> to: rule`: 198 in P0's tree, none since P7. A
violation not on the list fails the test, and so does a listed one that no longer occurs: the list only
shrinks. Fix a violation by changing the code, never by adding to the list.

## Moving files

```sh
node scripts/move.ts src/server/github.ts src/gh/github.ts [FROM TO ...]
```

moves each file with its tests (`x.test.ts`, `x.*.test.ts` and `x-*.test.ts`, unless a longer source name such
as `x-y.ts` owns the test) or a whole directory. It rewrites the relative imports in and to the moved files
across `src/` and `scripts/`, renames the paths (and moved directories) in the boundary test's `DOMAIN` and
`ALLOWED`, and lists other files that still mention an old path (plain-string paths are not rewritten). It
stops before changing anything on an import that breaks the import form or names no file, and when two files
would land on one path. A rerun finishes an interrupted one and otherwise changes nothing. Then `npm test`: the
boundary test says which `DOMAIN` entries to drop and which violations a move fixed or introduced.
