# Decisions

Append entries, newest last: date, decision, why.

- 2026-11-07: Request format v0 (spec/v0.md). Front matter in a strict YAML subset that every YAML parser
  reads identically (plain scalars with `: ` or ` #` must be quoted), parsed without a library. `model` is
  a tier (`small | medium | large`, default `medium`) that servers map to their own models. a repo's `ref` is
  required, `timeout` is capped at 24h, `harness` may be a single value and `any` can't be combined.
  Lifecycle adds `air:paused` and requester-set `air:cancel`; claims are resolved by lowest comment id, and
  an `air-release` marker (same host+nonce) ends a claim so issues can be re-offered. Fixed workspace
  layout (`repo/`, `context/`, `out/`) and `$AIR_*` env vars give `setup`, `check` and `deliver: artifact`
  a defined meaning. Why: the server must act on the format without guessing.

- 2026-11-07: v0 hardening after review of PR #3. Context zips are
  downloaded once to a file, checked against `bytes`/`sha256`, and their entries are checked for zip-slip
  (relative paths that stay inside `context/`, no symlinks or special files) before anything is written.
  For `deliver: pr` the issue author must have write/admin on each pushed repo, checked via the collaborator
  permission API, so a volunteer's credentials can't push for someone who couldn't. Markers count only
  from trusted authors (`OWNER`; `MEMBER`/`COLLABORATOR` are confirmed with the permission API) and only in
  unedited comments; servers never edit marker comments. Unquoted YAML 1.2 bools, nulls and numbers are
  errors in string fields (`ref: 1.10` would otherwise mean `1.1` to other parsers). URLs use a
  conservative character set, and servers run git/curl/gh with argv, never a shell. PR and
  result comment formats are fixed. Zips (context and artifacts) are release assets on the
  requests repo with an expiry (`context.expires`, artifact `expires`, default 14 days after the issue
  closes). `air sweep`, run daily by `air serve`, deletes expired ones. `deliver: comment` may embed
  images and video with `gh ... --attach` (gh ≥ 2.99; no REST API, and it fails with App installation
  tokens). Why: the review found ways for untrusted input to write outside the workspace, push with
  someone else's credentials, or forge claims.
- 2026-11-07: `gh --attach` feasibility test: not run. gh is 2.103.3, and its `issue comment --help`
  documents `--attach` for images and video only. On asinghvi17/ai-requests-sandbox#1 the runner's gh
  wrapper rejected `--attach` for both a 126-byte .zip and a 1x1 .png ("unsupported or interactive write
  option") before anything reached GitHub. So it is still unknown whether GitHub accepts zips or serves a
  working URL. The spec doesn't depend on it: zips stay release assets. Re-test from a host whose gh
  allows `--attach`.
- 2026-11-07: Second review of PR #3.
  - Markers count only alone on their own line and outside fenced code, so quoting one does nothing.
  - An HTML comment left open on a heading line hides the section body for lint.
  - Sweep never deletes an asset while a referring issue is open or claimed/running/paused; `expires`
    applies only after close.
  - Context zips are capped at the smaller of 10 GiB and 20 × `bytes` uncompressed, checked against the
    central directory and again while writing.
  - Each setup command and `check` has a 30-minute timeout and stdin from /dev/null. Setup is
    deliberately outside `timeout`, so `timeout` keeps meaning "agent time", the quantity effort estimates.
  - A `deliver: pr` with no commits beyond its repos' `ref` sets `air:failed`, not `air:done`: no requested
    change arrived, and failed requests stay retryable.
  - An empty `out/` fails `deliver: artifact`.
  - Over-long comment reports are truncated, and the full text goes to an `air-artifacts` asset.
  - Flow lists accept a trailing comma.
  - The agent reads its prompt from `AIR_TASK.md`.

## 2026-11-07: config is a TOML subset, parsed in-house (`src/toml.ts`)

`~/.config/air/config.toml` (respecting `$XDG_CONFIG_HOME`) is hand-edited, and TOML comments and
`[subscriptions.<name>]` / `[models.<harness>]` tables read better than JSON. With zero runtime dependencies
we parse a subset ourselves (~200 lines): tables with dotted/quoted names, bare/quoted/dotted keys, basic and
literal strings, integers, floats, booleans and multi-line arrays of scalars. Inline tables, arrays of tables,
dates and multi-line strings are rejected with a line number rather than misread. Unknown config keys are
errors so typos surface. A missing file is the all-defaults config.

## 2026-11-07: `serve` starts agents by default; `--manual` waits for `air run`

There is no `--auto`. `stop`, `start`, `pause` and `resume` are first-class commands. Model choice is by tier:
`[models.<harness>]` maps `small`/`medium`/`large` to concrete model names (claude defaults: haiku, sonnet,
opus; other harnesses must list all three).

## 2026-11-07: packaging is `bun build --compile` (`npm run build`)

**Decision: Bun (Anshul, 2026-11-07).** The main reason: Bun's macOS arm64 build, cross-compiled from Linux,
comes out ad-hoc signed, so it runs on Apple Silicon without a signing step on a Mac. `npm run build` compiles
`src/cli/main.ts` for linux-x64, linux-arm64, darwin-arm64 and darwin-x64 into `dist/` (`-- --target T` picks a
target and can be repeated). bun is a pinned dev dependency, so no global install is needed. Bun downloads the
runtime for each cross target into its install cache (`~/.bun/install/cache`, or `$BUN_INSTALL_CACHE_DIR` if
set), which must be writable. Dev and `npm test` stay on plain Node 26. `npm run test:bun` runs the same test
files under `bun test` (39/39 pass on bun 1.4.4), to catch runtime differences in what we ship.

Spike numbers (Linux x64, Node v26.10.0, bun 1.4.4, skeleton CLI). Startup is the median of 30 warm runs of
`air --version`; the first run of a freshly copied binary is in brackets.

| Route | linux-x64 size (gzip) | linux-x64 startup | darwin-arm64 from Linux |
| --- | --- | --- | --- |
| `node src/cli/main.ts` (dev, type stripping) | n/a | 122 ms | n/a |
| Node SEA + esbuild bundle | 150 MB (47 MB) | 67 ms (92 ms) | builds, 145 MB (44 MB); unsigned |
| Node SEA from a `strip`ped node | 117 MB | 57 ms | not tried |
| `bun build --compile` | 109 MB (52 MB) | 21 ms (23 ms) | builds, 89 MB (41 MB); ad-hoc signed |

With `--minify`, the Bun outputs are 109 MB for linux-x64 and linux-arm64, 89 MB for darwin-arm64 and 98 MB for
darwin-x64. Both macOS binaries carry `LC_CODE_SIGNATURE`. Neither has been run yet, because no Mac was
available.

Alternatives considered:
- Node SEA (`node --build-sea`) works but needs a bundler: a SEA can't load modules other than builtins
  (dynamic `import()` of embedded assets via `module.registerHooks` fails with `ERR_UNKNOWN_BUILTIN_MODULE`).
  It cross-builds for macOS using SEA's `executable` field and the official Node tarball, but injection drops
  the Mach-O signature. Apple Silicon kills unsigned binaries, so a Mac (`codesign --sign -`) or `rcodesign`
  would be needed. Its advantage is that it ships the same runtime the tests use; `test:bun` covers that gap.
- Running `src/cli/main.ts` on an installed Node 26 stays supported for development.
- 2026-11-07: usage readers adapt the factory's no-model-turn reads (`claude -p /usage` stream-json, Codex
  `account/rateLimits/read`), copying the logic rather than importing it. Readings are cached 5 min and are stale after 15 min, and stale
  counts as unknown. Plans with no meter use a manual budget plus a local spend ledger.
- 2026-11-07: usage state files (cache, manual ledger) are written under an O_EXCL lockfile through unique temp
  files. A ledger that cannot be trusted is moved aside, and its subscriptions read as unknown until an explicit
  `air usage reset-ledger`, because lost spend must never look like an unused budget. Usage CLIs get an allowlisted environment.
- 2026-11-07: effort matching (`src/match/`). Costs are shares of one weekly window times `scale`, a cost multiplier relative to the reference (largest) plan (Pro = 5). A monthly or manual-monthly window uses the same shares times 7/30, because a month holds about 30/7 weeks of the same work. Manual subscriptions declare the agent harness they fund (`harness = "claude"` or `"codex"`) and match like any subscription of it; without one they are ignored. Unknown usage (stale, incomplete, non-finite) takes nothing.
- 2026-11-07: tmux jobs are tagged with pane options `@air_job`/`@air_nonce` and found only by those tags (re-adoption
  after a restart needs no state file). Jobs run under `env -i` with an allowlist; denied names (GH_*, GITHUB_*, AWS_*,
  SSH_*, ...) throw even when a caller passes them. Why: the volunteer shares the session, and the agent must never see
  the server's credentials.

## 2026-11-07: claiming and workspace setup (`src/claim/`, `src/workspace/`)

- `air:claimed` is added only after the re-read confirms our claim holds (spec §9 step 3), not before the
  wait: a loser removing a label it added would also remove the winner's. Self-assignment happens before
  the wait; a loser unassigns unless the holder posted from the same GitHub account.
- Untrusted issue authors get no reply. Lint failures get one comment per body version (tagged with a hash
  of the body), and newer `air` versions get one `air-unsupported` marker per host and version.
- Anything air quotes that it didn't write (lint messages, setup output) goes in a fence longer than any
  backtick run in it, so it can't carry a counted marker or mention anyone.
- Each claim gets a fresh `<workspace_root>/<owner>__<name>/<issue>-<nonce>/` with `state.json` (phase:
  claimed, setting-up, ready, failed, released, lost). The body snapshot (`request.md`) is written when
  the claim is won, so `air setup` in another process uses the body as claimed.
- Context zips are read by a ~300-line reader on `node:zlib` (zip64 included). Beyond the spec's checks it
  also rejects `.`/empty path segments, control characters, non-UTF-8 names, duplicates and file/directory
  clashes, encryption, and methods other than stored/deflate, and checks each entry's CRC and declared size.
- `setup`/`check` run with an allowlisted environment (same idea as the tmux layer in PR #5; the lists
  should merge), in their own process group, which is killed on timeout and again when the command exits
  so background processes don't outlive their step. git runs with the server's environment (it needs the
  user's credential setup) plus `GIT_TERMINAL_PROMPT=0`.


## 2026-11-07: `air serve` loop and job lifecycle (`src/serve/`)

- The loop is code, no model call. Workspace `state.json` carries a `job` record and is the only job state;
  the server rescans it each tick, so restarts and the `air run/stop/start` commands need no IPC.
  `serve.json` holds only the `air pause` flag.
- Interactive agents don't exit when done, so AIR_TASK.md tells the agent to create `AIR_DONE`; the server then
  closes the session and delivers. Pane exit 0 also delivers; non-zero fails.
- Claude Code gets `--session-id <uuid>` from air, so `air start` can `--resume` it; Codex's id comes from its
  rollout files. A failed resume falls back to a fresh start pointed at `out/` and the git log.
- Agent argv comes from new `[agents.<harness>]` config (`command`, `args`) plus the tier's model;
  `tick_seconds` sets the tick. Subscriptions to read are still `subscriptions.json` (usage module), matched by
  name against `[subscriptions.<name>]` settings.
- `air:done` unassigns the server's account (release markers are not posted for done issues, per §9).
- Any pause (operator, quota) lasting 48 h releases the claim with a comment.
- Artifacts and over-long reports carry no `expires`, so spec §7's default applies: 14 days after the issue closes.
- Every gh call has a timeout (2 min; uploads 30 min) and gh runs in its own process group, killed on expiry.
- No write to an issue (label, comment, resume) without first confirming our claim still holds it. A lost claim
  marks the workspace `lost`, closes our window and leaves the issue to its holder. That costs one comments read
  per held job per tick.

## 2026-11-07: AIR_DONE wins over a closed or dead window; `--once` waits for a lagging issue list

- An agent may exit right after creating `AIR_DONE`, and its window can be gone by the next tick. Wherever the
  server finds a job's window closed or its pane dead (a live tick, a restart, re-adoption), it checks `AIR_DONE`
  first and delivers if it is there. Only without it does a closed window pause the job, or a non-zero exit fail it.
- `air start` and `air run` deliver instead of starting the agent when `AIR_DONE` already exists and the claim holds,
  so a job paused before that check existed can still be finished.
- GitHub's issue list lags a request filed seconds earlier. A `--once` poll that finds no candidates polls again
  every 10 s for up to `--once-wait` seconds (default 60) and logs each empty poll.

## 2026-11-08: tmux clients run with `-u`; a missing window needs two ticks

- Root cause of the live Mac smoke-run pause: tmux treats a client as UTF-8 only if `TMUX` is set or `LC_ALL`, `LC_CTYPE`
  or `LANG` contains `UTF-8`. Otherwise it sanitises command output, and every tab of the `list-panes -F` format
  becomes `_` (tmux 3.6 and 3.8 alike). No row parsed, `startAgent` recorded no pane nonce, and the next tick found
  "no window" for a live agent. air's tmux calls now always pass `-u`. A row without separators is an error, never "no panes".
- "error connecting to" means no server only for a missing socket or a refused connection (not, say, a path too long).
- One tick that cannot find a running job's window never decides its fate: only a second consecutive miss (same
  pane) pauses it, or resumes it after a restart. AIR_DONE is checked first. A running job with no recorded pane
  adopts its issue's only tagged pane.
- `air debug panes` (hidden) prints tmux's raw rows (with and without `-u`), the jobs air parses and the jobs it holds.

## 2026-11-07: `air submit`, `air sweep`, `air lint` and CI

- Context zips are written by a small writer on `node:zlib` (deflate, stored for empty files, no zip64:
  assets are capped at 2 GiB anyway). Local headers are patched in place after streaming, so there are no
  data descriptors. Only regular files go in; symlinks and special files are skipped and reported.
- `.gitignore` is implemented in-process (nested files, negation, anchoring, `**`), not via `git ls-files`,
  so a directory that isn't a repo works the same. Default skipped dirs: `DEFAULT_EXCLUDES` in
  `src/submit/collect.ts`; `--exclude` adds, `--no-default-excludes` clears.
- The secrets check reports a path and a reason, never the matched text. `--allow-file` takes a path or a
  directory. `context.expires` is written only with `--expires`: without it spec §7 keeps the zip until 14
  days after the issue closes. (A fixed default date counted from submission would leave a long-open
  request's zip with no retention at all once it closed.)
- The zip writer checks every entry name against spec §5 (relative, no `..`, `\`, drive letter or control
  characters) and opens each file with `O_NOFOLLOW` after an `lstat`, so only regular files go in and
  symlinks are never followed. A failed write removes the partial zip.
- If filing the issue fails after the upload, submit deletes the zip: no issue would refer to it, so
  `air sweep` would never collect it.
- Sweep errs toward keeping: any error listing assets, issues or comments, or checking trust, aborts before
  deleting anything; a body that no longer parses still holds any asset URL it contains (default expiry);
  asset URLs compare with host/owner/repo case-folded. Only a failed delete is per-asset.
- `air serve` runs `sweep()` at most once per 24 h (spec §7), in the background of the tick loop, never with
  `--once`. The start time is recorded in `serve.json` (`lastSweepAt`) before the sweep runs, so a failing
  sweep is retried the next day, not every tick; a failure is only logged.

## 2026-11-08: job exit status comes from air's launcher too; tmux 3.0 or newer

- Ubuntu 24.04's tmux 3.4 (built with utempter) can leave an exited pane unreaped: `pane_dead` with no status, for good
  (tmux issue 4559, fixed in 3.6). The job launcher now runs the agent as a child and records its exit status in a file
  in its private dir. air uses tmux's status when it has one, else that file. Details in src/tmux/NOTES.md.
- `air serve`, `air run` and `air start` refuse tmux older than 3.0 (pane user options). Checked on 3.0a to 3.8.

## 2026-11-08: nothing of a job outlives its window

- Review of PR #10: once the launcher ran the agent as a child, `kill-window` left the agent running (the hangup signals
  only the session leader). A stop now TERMs, then KILLs, the job's process group before it kills the window, and the
  launcher's reaper does the same when the launcher shell dies (a raw `kill-window`, a dying tmux server). Details in
  src/tmux/NOTES.md.
- `Job.pid` is the agent's pid (the launcher records it); `Job.panePid` is the launcher shell, the group leader.
- An agent killed by signal N reports status 128 + N; failure comments say "killed by signal N (status 128 + N)".

## 2026-11-09: `repos`, `air-result`, partial results, requester commands (approved by Anshul)

- Repos are an optional list, `repos:`. Each entry has `url`, exactly one of `ref` and `pr: N`
  (`refs/pull/N/head`), an optional `path` under `repo/` (default: the repo's name) and an optional
  `deliver: none` (read-only, never pushed, no permission check). Paths are relative `/`-separated segments
  that start with a letter, digit or `_`, unique case-insensitively (macOS file systems ignore case), and
  not nested. `deliver: pr` needs an entry without `deliver: none`, and each such entry uses `ref`, since it
  becomes a PR base: a `pr:` entry can only be read-only.
- Refs and PRs are resolved to SHAs before the claim comment is posted; the comment lists them, and every
  checkout of the claim uses them. An unresolvable entry is handled like a lint failure: no claim, and one
  comment per body version. Setup runs in the workspace root, since there may be several repos or none.
- `deliver: pr` opens one PR per repo with commits, always on the first free `air/<N>[-k]` branch. With one
  PR its body says `Closes`; with several, `Part of`, so merging the first doesn't close the issue, and each
  body lists its siblings. No repo with commits is `failed`.
- The YAML subset allows block lists of maps (`- key: value`, further keys aligned under the first) and maps
  nested in maps, which `repos` and `resume` need; the parser is a small recursive one. Flow lists hold
  scalars only. List positions in messages are 0-based (`repos[1].ref`).
- Every final comment ends with one `air-result` block: the `<!-- air-result v0 -->` line, then a fenced
  `yaml` block in the §3 subset. Only the last such line outside code counts, and its fence must end the
  comment, so a report that quotes a result can't replace the server's. It counts only if the comment
  counts for markers (trusted, unedited), its `host` and `nonce` name the claim that held the issue when it
  was posted, and the same account posted that claim. Artifacts, over-long reports and checkpoint zips are
  named only there, and sweep reads its references from it. `resume.out` has `sha256` and `bytes` like
  `context`, because the next server downloads and extracts it.
- Cut-off rules (§11): a 5-hour window pauses and resumes. A weekly or monthly window waits if it resets
  within 24 h, else it checkpoints as `partial` and releases. An exit without AIR_DONE resumes the session
  once, then becomes `partial`. Using more than 2× the effort share becomes `partial`. A timeout is
  `partial` with a checkpoint, else `failed`. Context limits are not a cut-off. The 48 h pause release skips
  quota pauses waiting on a reset ≤ 24 h away. Checkpoint branches are pushed only for `deliver: pr`, the
  only delivery whose write access was checked. Uncommitted changes are not checkpointed: AIR_TASK.md asks
  for WIP commits and an up-to-date `out/PROGRESS.md`, so the server never commits for the agent.
- Requester commands: `air status`, `air wait` (0 done, 3 partial, 1 failed/released or unreadable, 2
  usage), `air fetch`, `air retry [--effort L]`. `air retry` is the one way to offer a request again.
- Setup, serve and delivery so far handle one repo with `ref`, cloned into `repo/` with setup run there, and
  no `resume`; `air claim` refuses other requests (`not-yet-supported`) until they implement the rest.

## 2026-11-12: cut-offs, partial results and resume intake in `air serve` (spec §11)

- Only `AIR_DONE` delivers. An agent that exits without it, whatever its status, is resumed once (its own
  session, told to read `out/PROGRESS.md` and the git log; a session that can't be resumed gets a fresh start
  with the same instruction), and a second exit becomes `partial`. Before, exit 0 was delivered as done and
  any other exit failed.
- Quota: a window resetting within 24 h pauses as before; further away (or a quota pause still not over 24 h
  after it began, and at least an hour after the reset it waited on) becomes `partial`. Quota pauses are never
  released by the 48 h pause rule, since this bound is tighter. The spec now says so (§8, §11 rule 2).
- Effort cap: more than 2 × the job's matched cost (`expectedCost`, in points of the subscription's primary
  window) used since the first start becomes `partial`; readings that aren't comparable (stale, unknown, a
  window that reset) never trigger it. A `timeout` becomes `partial` when the checkpoint keeps anything, else
  `failed`.
- A checkpoint pushes `air/<N>[-k]` for `deliver: pr` with the same code as PR delivery (read the agent's commits
  into a clean bare repo, push from there) and uploads `out/` as `air-<N>-<nonce>-out.zip`. The final comment
  says why the job stopped and what was kept, then the release and a `partial` result with `report: comment`,
  `usage` and `resume`. `air:partial` is a state label, so no server claims the issue until `air retry`.
- Every final comment now ends with an `air-result`: `release()` writes it (status `failed`, `released` or
  `partial`; `deliver` from the claimed body), and done deliveries add `usage`. Failure comments point to
  `air retry` instead of removing `air:failed` by hand.
- `resume:` requests are served (single-repo layout still): setup fetches each checkpoint SHA from the repo's url
  onto its branch and extracts `resume.out` into `out/` with the context-zip checks, before `setup` runs.
  AIR_TASK.md asks every agent to keep `out/PROGRESS.md` current and to commit WIP often, and tells a resumed
  one it is continuing earlier work.
- Release assets on the requests repo's host are downloaded through gh (`gh api repos/O/R/releases/assets/ID`
  with `Accept: application/octet-stream`, stdout streamed to the file and cut off past `bytes`), so a private
  requests repo works; other URLs are fetched without credentials. air never sees the token.

## 2026-11-12: requester commands `air status`, `wait`, `fetch`, `retry`

- They live in `src/requester/` and reuse the spec's parsers: `countedResults` and `currentClaim` for what
  counts, `fetchContext` (download once, size and SHA-256, zip-slip and size cap, extract from the verified
  file) for artifacts and checkpoint zips, `cloneAt` for branches, and the `formatResult` resume block
  (`formatResume`) for the `resume` that `air retry` writes.
- The latest result is **current** when no counted claim marker comes after it. `air wait` waits only for a
  current one, polling every 30 s; `--timeout` takes a `timeout`-style duration and exits 4. Server errors,
  rate limits and gh timeouts are retried at the next poll; a missing issue or an auth error exits 1.
- Usage errors exit 2 for every command, as spec §12 always said; the router used to exit 1. Refusals that
  depend on state (`air run` on a job that isn't ready, a lost claim) are a separate `CommandError` and
  still exit 1, and so does any `gh` error.
- `air fetch` mirrors the workspace layout (`repo/<path>/`, `out/`, plus `artifact/` and `REPORT.md`), so a
  repo whose path is `out` or `artifact` can't collide with the zips. `DIR` must be new or empty, the first
  failure stops it, and a stale result is fetched with a note. Release assets are downloaded the way servers
  download context zips (through gh, so private requests repos work).
- `air retry` refuses closed issues, issues without `ai-request`, held issues and bodies that fail lint
  (before or after its edit), and runs only for the issue's author or an account with write access. It
  rewrites only the `effort` line and the `resume` block of the front matter (a new block goes at the end),
  keeping every other line as written.
- `formatResult` now quotes a `sha256` YAML would read as a number (all digits), so such a block still
  parses. `air:partial` joins `STATE_LABELS`, so `claimable` refuses a partial request until `air retry`.

## 2026-11-12: multi-repo requests in `air serve` (spec §5, §6, §11)

- `repos:` is served as specified, with 0..n entries; the `not-yet-supported` claim refusal is gone. A request
  without `repos` has no `repo/`; setup and check always run in the workspace root.
- Claim time (`checkRepos`, before the claim comment): for every entry that gets a pull request, its URL must be
  on the requests host, the author must have write/maintain/admin, and so must the server's own account; then
  every entry is resolved to a SHA (branch or tag via `git ls-remote`, `pr` via `refs/pull/N/head`, any other
  ref, abbreviated or not, via a treeless bare clone). A deliverable entry resolves only from a branch. The SHAs
  go in the claim comment and in `state.json` (`repos`), and every checkout of the claim uses them, detached.
- Spec change: the author's permission check moved from "before setup, fail the request" to "before claiming,
  don't claim", next to the new server-can-push check, so no request is claimed that can't be delivered.
  Requester problems (unresolvable entry, wrong host, author without write) get one comment per body version
  and problem; a server that can't push stays silent, since another one may. Both are checked again every poll.
- Spec change: every PR body starts `Part of <requests>#N` (no `Closes` for a single PR: one way, and merging
  a PR never closes the issue, which the requester closes). Siblings are added by editing the bodies once all
  are open.
- Delivery and checkpoints keep a record per repo path (`job.delivery.repos`: branch, pushed SHA, PR, linked),
  so a retry repeats nothing. Commits count from the SHA recorded at claim time, not the branch's current tip.
  The final comment lists the PRs and the delivered repos that got none, and why.
