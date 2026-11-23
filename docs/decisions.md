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

## 2026-11-17: the `ai-request` Claude Code skill and `air skill install`

- `skills/ai-request/` is a Claude Code skill (`SKILL.md` plus a body skeleton, `template.md`) that turns
  work in any project into a request. It gathers the task, repos and context files, picks `effort` and
  `deliver` and says why, writes the body, checks it with `air lint` and `air submit --dry-run`, files it only
  after the user says yes, and offers `air status`, `wait` and `fetch`. It links to spec/v0.md rather than
  restating it.
- Users get the binary, not the repo, so the skill ships inside it. `scripts/bundle-skill.ts`
  (`npm run skill:bundle`) writes the files into `src/skill/bundle.ts` as strings, which Node and
  `bun build --compile` both load the same way. A test fails when the bundle and `skills/ai-request/` differ.
- `air skill install` writes the skill to `~/.claude/skills/ai-request/`, or to `--dir DIR` itself (not a
  parent), and `--print` only prints that path. It replaces only an empty directory or one whose `SKILL.md`
  says `name: ai-request`. Anything else is refused (exit 1), so `--dir ~` can't wipe a home directory. The
  new copy is built in a sibling directory and swapped in by rename.

## 2026-11-17: trailing text after results, real spend, the agent's environment, resumes keep their branch

- Spec §10: text may follow a comment's `air-result` block (signatures, bot footers) and is ignored. The block is
  the one `<!-- air-result v0 -->` line outside code, the ```` ```yaml ```` fence after it, and the line closing
  that fence. A comment holds exactly one block: a second marker line outside code makes the comment hold no
  result, where before the last one won. Only a claim's first counted result counts, as before.
- Manual budgets are charged what a job actually spent, when it ends (delivered, failed, partial, cancelled or
  lost), once. One source per agent, its own records: Claude Code's session transcripts (`message.usage` of each
  API call, once per message id, subagents included), Codex's rollouts (the largest `total_token_usage` per
  session started in the workspace). Both give tokens, so only budgets in `tokens` are charged; a budget in
  `percent` is not, since no agent reports a share of a plan. No estimate (say, the effort's expected cost) stands
  in for a missing record: the final comment says the job wasn't charged and why.
- The agent inherits the volunteer's whole environment: the launcher no longer runs `env -i` with an allowlist.
  air adds or overrides only `AIR_WORKSPACE`, `AIR_CONTEXT`, `AIR_OUT`, a subscription's `CLAUDE_CONFIG_DIR` or
  `CODEX_HOME`, and `TERM` (tmux's); `TMUX` and `TMUX_PANE` are tmux's own for the pane. `setup` and `check` keep
  their allowlisted environment.
- A resumed request pushes to its checkpoint's branch (`resume.branches[].branch`) instead of the next free
  `air/<N>-<k>`, for its PR or its next checkpoint, so no branch is left over. The push is
  `--force-with-lease` on the checkpoint's commit (or on the branch being absent): if someone moved the branch
  since, air leaves it alone and that repo gets no push, with the reason in the final comment.
- A PR body holds the agent's report (§6 already said so). One too long for GitHub's 65,536-character body is now
  cut, with the full report uploaded as the report asset, where before `createPull` failed.

## 2026-11-17: everything in US dollars at API prices

- Raw tokens mislead across models, and a share of a plan depends on the plan, so efforts, budgets and spend
  are all US dollars at API prices: the agent's tokens at the provider's published per-token rates. Spec §2:
  `effort` is XS $1, S $3, M $10, L $30, XL $100 (was 1, 3, 8, 20, 40 % of a weekly window). Matching compares
  dollars with dollars.
- Budgets in `percent` and `tokens` are gone; a manual budget is `{ "usd": N }`, and its ledger records dollars.
  config.toml's `scale` and `budget` are gone too: `[subscriptions.X] window_usd` says what a readable
  subscription's whole primary window is worth, so its percent meter reads as dollars. Without it a readable
  subscription takes nothing.
- A job's cost is priced from the agent's own token records with one table, `src/usage/prices.ts`, keyed by
  model id, each price citing its page. Claude Code's own total (`cost-state.totalCostUSD` in the transcript)
  can't be used: it is written only when a session exits, so a running job (for the effort check) or a killed
  one has none. The table reproduces it to the cent where it exists. Codex reports no cost at all.
- A model not in the table costs nothing, and serve logs a warning naming it; the final comment names it too.
- Spec §11 rule 4: a job is stopped early once its cost passes twice its effort's dollars, measured from the
  agent's records rather than the window's meter. The final comment says "Cost at API prices: $X; effort E
  expects $Y." and, for a manual budget, "Charged $X to manual budget `name`."

## 2026-11-17: unattended agents by default, `air config init`, `air doctor` and stuck-prompt detection

- Before this, an `[agents.X]` table left out meant `claude` or `codex` with no extra args. Claude Code then
  ran in its default permission mode and Codex with its default approval policy, so each stopped at its first
  prompt, and nothing checked for that. Now `DEFAULT_AGENTS` (`src/config.ts`) fills in any missing key, and
  `air config init` writes all of it out, generated from the same constants. It writes once and never
  overwrites; `--print` shows the file instead.
- Flags, checked against the installed CLIs (Claude Code 2.1.311, Codex CLI 0.164.0):
  - Claude Code: `--permission-mode auto`. `claude --help` lists the modes `acceptEdits`, `auto`,
    `bypassPermissions`, `manual`, `dontAsk` and `plan`. Started in tmux with `--permission-mode auto` in a
    trusted folder, it opened no dialog. `bypassPermissions` opens "WARNING: Claude Code running in Bypass
    Permissions mode" until it is accepted once, which sets `skipDangerousModePermissionPrompt` in
    `settings.json`.
  - Codex: `--ask-for-approval never --sandbox workspace-write -c sandbox_workspace_write.network_access=true`.
    `codex --help` gives `-a never` as "Never ask for user approval", and the sandbox keeps writes inside the
    workspace. `--approve-for-me` (automatic review) is closer to Claude's auto mode, but this CLI also says
    "Approve for me is unavailable" on some accounts, and nothing then answers its prompts.
- `air doctor`, which `air serve` also runs at startup (`src/serve/preflight.ts`), checks each claude or codex
  login listed in subscriptions.json. The agent's binary must be found and `--version` must print a version.
  Its args must carry an unattended mode. For Claude Code, the login's `.claude.json` (`$CLAUDE_CONFIG_DIR`
  or `~/.claude.json`) must have `hasCompletedOnboarding` and must trust `workspace_root` or a folder above it
  (`projects[path].hasTrustDialogAccepted`). Trust is inherited: tested by trusting a parent, and also the
  home directory. Bypass mode also needs `skipDangerousModePermissionPrompt`. For Codex, when
  `workspace_root` is in a git repo, that repo's root must be `trust_level = "trusted"` in `config.toml`.
  Tested: Codex asks "Trust this folder?" in a git repo even with `-a never`, not outside one, and saves the
  answer under the repo root. Only those keys are read, and no file content is printed. Credential stores
  (`.credentials.json`, `auth.json`, keychains) are never opened, so a missing Codex login isn't caught here;
  the runtime check below catches its sign-in screen. Each problem comes with the command or setting that
  fixes it.
- A manual subscription in subscriptions.json may set `configDir` or `codexHome`, and they apply to the
  harness config.toml gives it: a second Claude account whose usage air can't read runs on its own login.
  `loginsOf` resolves this in one place, and `agentEnv` (the agent's environment and the transcripts its spend
  is priced from) and the preflight both use it. Under the full-environment launch the agent sees the
  server's `CLAUDE_CONFIG_DIR`/`CODEX_HOME` unless the login sets its own, and the preflight checks the same
  directory.
- A login that fails is refused through `MatchConfig.refused`. It takes no new requests ("not served: ..."
  in the no-fit log), and the other logins carry on. Jobs already running on it are left alone.
- At runtime, each tick reads the running job's visible pane (`capture-pane -p -J`). A prompt in
  `PROMPTS` (`src/serve/prompts.ts`) is matched against the last 20 non-blank lines, whitespace collapsed,
  and its footer (where captured: "Esc to cancel", "enter continue", ...) must be in the last 3. It counts
  once it has stayed for 60 s, so output that merely quotes a prompt scrolls on, or sits above an idle input
  box without the footer, and never does. A screen unchanged for 15 minutes counts as `idle`: long enough for
  a quiet build. Each pattern records its source. Most were captured from the installed CLIs in tmux with
  throwaway config dirs (`src/serve/fixtures/panes/`). The permission and approval prompts need a working
  model to appear, so their fixtures are built from the CLIs' strings. The Codex approval has no footer
  check. Its screen couldn't be produced: Codex 0.164.0 sends model calls over a websocket and runs shell
  commands inside its code-mode `exec` tool, so a fake model would have to emulate both. Its binary holds the
  footer only as fragments ("to confirm", "to cancel") that other popups share, and the trust screen captured
  from the same build uses another style ("enter continue · esc back").
- Each waiting episode is logged once with its fix, recorded as `job.waiting` (which `air status` shows on the
  serving machine) and put in the tmux status bar. An episode ends when its prompt leaves the screen, or for
  `idle` when the screen changes; a restart keeps it until then. A prompt, never `idle`, posts an issue
  comment: once per episode, at most 3 per job (`waitingComments`), so one false match can't silence the
  real prompts after it. None of this stops the job: the timeout and cut-off rules do.

## 2026-11-17: fixes from the first real-GitHub run

- Labels: `LABELS` (`src/claim/claim.ts`) lists every air label. `air serve` creates the ones the requests repo
  lacks when it starts, `air:cancel`, `air:failed` and `air:partial` included. Before, labels appeared only
  when serve first added one, so `air:cancel` never existed on a fresh repo. `air cancel N` is the one way
  to cancel: it adds `air:cancel` (creating the label if needed). Like `air retry`, it is for the author or
  an account with write access.
- GitHub answers a caller without push access with 403 on the collaborator-permission endpoint, and needs
  triage to label an issue (push to create a label). `permission()` reads a 403 as `none` only for the
  caller's own role: for another's it says nothing, so it still throws, and trust never takes a server's
  marker for forged. The repo check asks for the server's own access first, so a server without push never
  blames the requester. `air cancel` and `air retry` turn a 403 on a label write into a message saying the
  account may not label issues, since an author passes their role check without triage. The fake follows
  these rules (its viewer is admin unless a test records a role).
- The agent's environment drops the variables Claude Code and Codex set for the commands they run
  (`SESSION_MARKERS`, `src/tmux/env.ts`; names read from Claude Code 2.1.311 and Codex 0.164.0). Cause of the
  missing Claude costs: `air serve` was started from a Claude Code session, the agent inherited
  `CLAUDE_CODE_CHILD_SESSION=1`, and Claude Code then saves no transcript ("Transcript saving is off —
  inherited CLAUDE_CODE_CHILD_SESSION marker"), so the job had no usage record to price.
- A cost with no priced call (every call on a model the table lacks) reads "unknown", not `$0.00`. The
  Codex job priced at $0.00 ran on gpt-6-luna, which had no price. The table now has every API model
  `codex debug models` lists, gpt-5.6-sol's promotional price still excepted.
- `air usage` shows only the subscriptions config.toml names.
- A build stamps its version (`scripts/version.ts`, `bun build --define AIR_BUILD_VERSION`): package.json's
  version, plus `+<short sha>` unless HEAD carries the tag `v<version>`. Run from source, it is `<version>+source`.
  (Superseded 2026-11-21: release builds keep the sha too.)
- A Task summary over 80 characters is a lint warning, and `air submit` cuts a derived title at a word
  boundary.
- A `done` artifact zip leaves out `out/PROGRESS.md`. A partial checkpoint's zip keeps it, since resuming reads it.

## 2026-11-17: folder trust is settled at launch, never at a prompt

Replaces the Codex trust check and refines the Claude Code one in the entry above. Each job runs in a fresh
directory under `workspace_root` (`<owner>__<repo>/<N>-<nonce>`), with clones in `repo/<path>/`, and the agent
always starts in that job dir, never in a clone. Tested in tmux with Claude Code 2.1.311 and Codex CLI 0.164.0,
throwaway config dirs, a fake API key and no prompt (so nothing reached a model), `workspace_root` trusted in
Claude Code:

| Agent's cwd | Claude Code | Codex (`-a never -s workspace-write`) | Codex, with air's `-c` |
| --- | --- | --- | --- |
| a new job dir | no prompt | no prompt | no prompt |
| a job dir holding a fresh clone in `repo/o/r` | no prompt | no prompt | no prompt |
| the same job dir again (resume, restart) | no prompt | no prompt | no prompt |
| the clone itself (serve never does this) | prompts | prompts | no prompt |
| a job dir that is a git repo (an agent's `git init`, then a restart) | prompts | prompts, `codex resume` too | no prompt, `codex resume` too |
| a job dir in a git repo that holds `workspace_root` | no prompt | prompts | no prompt |
| the same, with only a folder above that repo trusted | prompts | | |

- Codex: every launch and resume gets `-c 'projects={"<job dir>"={trust_level="trusted"}}'` (`codexTrust`,
  src/serve/agent.ts), keyed on the job dir's real path: Codex resolves symlinks before it looks, and a key with
  the symlinked path still prompted. The dotted form, `-c 'projects."<dir>".trust_level="trusted"'`, does not
  work: Codex splits the key at every `.`, those inside the quoted path included, and `~/.anything` paths have
  them. The override lasts for that session only: nothing is written to the volunteer's `config.toml`. So
  `air doctor` no longer checks Codex trust at all.
- Claude Code (from its 2.1.311 binary, matching the table): it looks for `projects[dir].hasTrustDialogAccepted`
  from the cwd upwards, skipping entries saved as false, and stops at the cwd's git root. So a job dir inherits
  `workspace_root`'s trust, a clone or a job dir that is a git repo does not, and neither does a job dir below a
  git repo whose trusted folder is above that repo. `air doctor` now checks exactly that: a trusted folder at or
  above `workspace_root`'s real path, and not above the git repo `workspace_root` is in, if any. Before, a trusted
  home directory passed even when `workspace_root` sat inside a repo under it, and each job would have prompted.
  The real path is `canonicalPath`: the nearest existing ancestor resolved, the part not created yet joined back
  on. So a `workspace_root` that doesn't exist yet is checked where Claude Code will find it, both behind a
  symlink into a git repo and below a symlinked home (macOS `/var` is `/private/var`). The git root lookup, the
  trust comparison and what `--fix` writes all use that one path (review finding).
- No flag or job-scoped setting makes Claude Code trust a folder. Project trust lives only in the login's
  `.claude.json`, next to its account state, and air writes it only for `workspace_root`, through
  `air doctor --fix` (below), never per job. The one case left is a job dir the agent
  made a git repo itself, met on a restart or resume. Stuck-prompt detection catches it (`claude-trust`, whose fix
  now says to attach and answer, then run `air doctor`); `codex-trust` stays too, as a backstop for a Codex that
  ignores the override.
- `air doctor --fix` (asked for after a Mac run where the only fix was answering Claude Code's prompt in
  `~/air` by hand): for each missing Claude Code trust the check found, it asks "Trust ~/air for Claude Code?
  [y/N]" (one question per state file, naming the logins when there are several) and, on yes, sets
  `projects[<workspace_root's real path>].hasTrustDialogAccepted = true` in that login's `.claude.json`
  (`writeClaudeTrust`, src/serve/trust.ts). It creates `workspace_root` if needed, keeps every other key and
  the entry's other fields, and changes nothing else (no account or credential field). It writes beside the
  file's real path and renames over it, so a symlinked `.claude.json` stays a symlink. The copy is set to the
  file's mode with fchmod, since the umask would cut down the mode it was created with. A running Claude Code
  rewrites the file often, so air reads it again just before the rename. If it changed, air merges into the fresh
  content, up to 5 times, then gives up untouched with "kept changing while air wrote it: close Claude Code, then
  run `air doctor --fix` again" (review findings). It needs a terminal, and checks again after writing. `air config init` offers to run it, and plain `air doctor`
  stays read-only. There is no Codex counterpart: with the per-launch override the check finds no Codex trust
  to fix, and a `config.toml` writer would be a second way to do the same thing.
- `src/serve/trust.e2e.test.ts` runs the installed CLIs through air's tmux layer with `agentArgv`'s argv for
  these cases, including Codex without the override as a control, and checks each first screen with
  `matchPrompt`. Its Claude Code workspace_root is trusted by `writeClaudeTrust`, so the test also shows that
  Claude Code honours the entry `--fix` writes. It is skipped for a CLI that isn't installed (as in CI).
- With #19's environment scrub (`SESSION_MARKERS`, src/tmux/env.ts) both hold: the agent starts without the
  parent session's markers, and Codex still gets the per-launch trust override in its argv. The trust e2e
  starts its agents with `env -i` and only the throwaway login, so the scrub doesn't change what it checks.

## 2026-11-17: the result comment always comes before the label change

- Every path that ends a server's part in an issue now goes through one helper, `postResult` (src/claim/claim.ts):
  the final comment first, then the final label added, then the held labels removed, then the unassign. Before,
  `finishJob` commented first but `giveUp` (every release: failure, partial, cancel, long pause, quota stop,
  interrupted claim or setup, `air release`) moved the labels first, so `air status` could show `air:failed`
  or a released issue with no result yet. The spec (§8) now states the order.
- `readStatus` reads the labels, then the comments (PR #21 had swapped them). With the one write order, a
  label read that finds the held label gone is followed by a comment read that finds its result. Reading the
  comments first gave no such guarantee: both mixes were possible.
- `air wait`'s one extra read after `SETTLE_MS` stays: a read between the server's comment and its label change
  still sees a current result next to a held label. No write order closes that gap.
- A release cut off after its comment (a label write or the unassign failed) is finished, not wedged. Before,
  the retry saw our own release marker, found no holder, was refused ("no claim to release") and marked the job
  lost with `air:running` and the assignment left on the issue (review finding). Now `postResult` checks the
  issue: if the claim's counted result is already there, it skips the comment and does only the writes left.
  That replaces finishJob's `delivery.commented` flag, so there is one way to tell. `release()` finishes a
  release when nothing holds, the latest claim or release marker is our own release, and its workspace hasn't
  recorded the release, using the result it posted. `loseJob` tries that first, so `ensureHeld` and the server
  tick finish the release too.
- `spawn.test.ts` accepts ENOTCONN as well as EPIPE from a gh that exits without reading its input. On macOS
  node's stdio pipes are socket pairs, and that write can fail with either (it failed one macOS CI run).

## 2026-11-17: PR #9 review follow-ups: single-entry delivery, `@air_repo`, `--once` retries

- Delivery is single-entry. `air start N` (or `air run N`) on a job whose agent already created `AIR_DONE`
  delivers in place of starting it, and so does `air serve`'s tick: both could push the PR branch, upload the
  artifact and post the result at once. `finishJob` and `partialJob` now run under the workspace's delivery
  lock, `.air-deliver.lock`: `pidLock` (src/serve/state.ts), the same pid lock file `serve.lock` uses, made
  with an atomic `link` and taken over only when its pid is dead. Whoever finds it held backs off without
  writing anything: the server logs it and the next tick sees the outcome; `air start` says another process is
  delivering. Inside the lock a job that has already ended is left alone, so the loser's later retry does
  nothing either. The lock was chosen over a phase transition in state.json: a read-check-rename on that file
  is not atomic between two processes, and the lock comes with stale handling already.
- Job panes are tagged `@air_repo` (`owner/name`) at launch, with the other tags, and `createTmux` needs the
  repo: `listJobs` (so adoption, `findJob`, stop, attach and the leftover-`starting` cleanup) sees only panes
  tagged with its own repo. Two servers for different requests repos share the `tmux -L air` socket; before,
  each adopted (and could stop, or kill as a duplicate) the other's window of the same issue number. A pane
  without the tag is not ours: there is no fallback, as nothing was deployed with untagged panes.
- `air serve --once` retries a poll that fails (a network error, a 5xx from gh): `ONCE_POLL_TRIES` (3) tries in
  all, `ONCE_RETRY_MS` (2 s) apart and doubling, then the command fails. Before, a failed first poll looked
  like "nothing to do" and `--once` exited 0. `tick()` now returns `POLL_FAILED` for a poll that threw. The
  list-lag re-poll (`ONCE_WAIT_MS`, `ONCE_POLL_MS`: GitHub's list can miss a request filed seconds ago) was
  already named; its constants now say why they exist.

## 2026-11-21: one command to volunteer, one to request

- A volunteer used to run `air config init`, `air doctor --fix`, `tmux new -s air-serve 'air serve'` and
  `air attach`. Now `air serve` alone does it. On a terminal outside air's own tmux it checks `gh auth status`
  (offering `gh auth login`), writes the config when there is none, prints the preflight and asks before each
  missing folder trust, then starts itself in window `serve` of the `tmux -L air` session and attaches. A
  second `air serve` on a terminal while one holds `serve.lock` attaches to the session (from inside air's
  own session it switches to window `serve`). Joining needs no requests repo or serve context, so a server
  started with `--repo` can be joined. Off a terminal, or with `--once`, it serves in place, as before:
  `--once` never attaches, and fails on the held lock.
- `air config` and `air doctor` are gone: their only use was this setup. The preflight report still prints
  at every `air serve` start, and off a terminal it says to run `air serve` in one for the trust fix.
- `air attach` now needs ISSUE. Getting onto the session is `air serve`'s job; `attach ISSUE` stays because
  the waiting-prompt fixes point at one job's window, which also works from inside another tmux.
- The first-run config has a `[subscriptions.NAME]` table only for logins whose binary is installed and whose
  usage air can read, so a missing Codex no longer shows as NOT READY on every start. The preflight checks
  only logins config.toml names, as `air usage` and the matcher already did.
- The server's window runs `/bin/sh -c` around air: a no-op INT trap keeps the shell alive while air shuts
  down on C-c (else the window closes and its SIGHUP cuts the shutdown short), and a failed exit waits for
  Enter so the error stays readable. The server gets the caller's environment through the launcher (as jobs
  do), not the tmux server's, which may date from an earlier session.
- A requester runs `air skill install`, which asks for the requests repo when the config has none (or takes
  `--repo`). It writes the same config, through the same `ensureConfig`.

## 2026-11-22: findings from the first live trial (v0.3.0)

- Every git call on a bare repo air makes (`.air-push.git` in delivery, the treeless clone that resolves a
  commit) passes `--git-dir`. With `safe.bareRepository=explicit` (security-minded users set it; the Claude
  desktop app's Terminal exports it in `GIT_CONFIG_PARAMETERS`) git refuses to find a bare repo from its cwd,
  and delivery read that as "no commits".
- Delivery fetches the agent's branches and HEAD separately, so an unborn HEAD is "no commits" and any other
  git failure is "air could not read the commits", with git's error. A `deliver: pr` that opens nothing says
  "No changes were produced" only when every repo really has no commits; else "No pull request was opened".
- First run asks each subscription's per-window budget (`window_usd`), default 20, and writes 20 without a
  terminal. The old 1000 was a guess at a whole Max window: far more than a volunteer means to give away.
- `air skill install` off a terminal without `--repo`, when the config names no repo, fails (exit 1) saying
  to pass `--repo`, before installing anything. It used to install, write nothing and exit 0.
- `air serve` that starts in an `air` tmux session left from an earlier run says it is joining it.
- The skill links the format spec at the installing air's tag (`{{AIR_TAG}}` in the skill source, filled in
  by `air skill install`), not `main`, which may have moved past the binary.
- The first line of `## Task` stays in the body although it is also the issue title. Dropping it would leave
  a one-line `## Task` empty, which spec §4 forbids, and would lose the rest of a summary cut to fit the title.

## 2026-11-22: cleaning up after jobs

- A delivered job's workspace is deleted by `finishJob` right after delivery, while it still holds the
  delivery lock and after closing the job's window. A process waiting on that lock then finds the workspace
  gone. `pidLock` never creates a lock's directory, so it can't bring the workspace back, and readers take a
  vanished workspace (ENOENT) as delivered elsewhere.
- Workspaces of jobs that ended any other way are kept 7 days (`KEEP_MS`) for debugging. The 7 days count
  from their last state change, or the state file's mtime when that is unreadable. They are removed by a
  cleanup pass (`serve/tidy.ts`) inside the daily sweep `air serve` already ran, before the asset sweep: one
  mechanism with one clock, not a second timer. The pass touches only its own requests repo, since another
  server may serve another repo from the same workspace_root. It never removes a workspace whose job still
  has a process: a live delivery lock, or a tmux pane, which is the case when tmux can't be asked.
- Every workspace deletion goes through `removeWorkspace`. It resolves the path first (trailing slashes,
  `..`), requires `<workspace_root>/<owner>__<name>/<issue>-<nonce>`, renames the workspace to a unique trash
  name in the same directory, and checks that entry (a real directory, real path inside root) before the rm.
  Swapping a directory for a symlink between check and rm therefore can't redirect the rm. A trash entry a
  crash leaves is removed by the next pass.
- Window closing is driven by air's tagged job panes, checked every tick. A pane goes when the workspace
  that recorded it has ended, or when no workspace records it and none holds its issue. A pane of a held
  issue that no workspace records yet is a start in progress (`air run` saves the nonce right after) and
  stays.
- Lock files hold `<pid> <host>`. `alive` (src/pid.ts, the only one) counts EPERM as alive. A pid is only
  judged on the host that wrote it. A lock from another host is stale only past `FOREIGN_LOCK_MS` (15 min).
  `air serve` refreshes its serve lock every minute for that reason, and deliveries are shorter. The 30 s
  grace stays for locks being written. The usage locks follow the same host rule.
- `closeIfIdle` never kills the tmux server and closes only windows air tagged (`@air_own`). Unless a job
  window or another `serve` window is there, it closes air's `log` windows and sets `exit-empty`, so the
  session ends with its last window. A window of the user's keeps it. `air serve` skips the call when
  another server took the serve lock meanwhile.
- Launcher dirs count as air's only when they are directories (not symlinks) owned by this user, since
  tmpdir may be a shared /tmp.
- `air status` without ISSUE lists every repo's workspaces and this machine's leftovers. It is read-only: it
  judges the serve lock without taking it.
- CI installs tmux on macOS, so the tmux, serve and trust end-to-end suites run there too.

## 2026-11-22: module boundaries, enforced by a test before any code moves (refactor P0)

The architecture review set a target layout of eight domains (`lib`, `gh`, `request`, `agents`, `setup`,
`server`, `cli`, `e2e`) with one-way dependency rules (docs/architecture.md). P0 moves no production code: it
adds `src/boundaries.test.ts`, which maps today's files to their target domains and checks every import under
`src/`, and `scripts/move.ts`, which later phases use to move files and rewrite imports. Today's 198 violations
are an explicit allowlist that may only shrink: a new violation fails, and so does a listed one that is gone.
Why: refactoring in phases is safe only if each phase can see what it fixed and cannot add new tangles.
Besides the domain rules, the test forbids import cycles between files and between directories, which the
review named (the `claim` ⇄ `workspace` cycle; every `cli/<cmd>.ts` importing `Invocation` from `main.ts`).
"Import only `<domain>/index.ts`" holds for every cross-domain import, so most of the allowlist (137) is
imports that later phases route through an index.
A relative import names its file with the extension (`.ts`, or `.json`), as nodenext ESM resolution needs
anyway. The boundary test and `scripts/move.ts` reject any other form rather than guess at resolution, so a
specifier's target is its path.

## 2026-11-22: `air doctor`

- `air doctor` is back, as a report of the checks `air serve` runs at startup, from the same functions in
  `src/serve/preflight.ts` (gh login, config, workspace_root, the agent preflight) and `checkTmux` in
  `src/tmux/tmux.ts`. It adds what only an installation check needs: the platform, git, `air` on PATH, and
  each login's usage read straight from its CLI (`readUncached`), so it never writes the usage cache.
- It writes nothing, and has no `--fix`. Folder trust stays with `air serve`'s first-run prompt, the one
  place air writes it; doctor's fix for missing trust names that prompt.
- Install fixes come from `src/serve/hints.ts`, by system: Homebrew on macOS (brew.sh first when it is
  missing), apt, dnf (Fedora's own gh package; RHEL gets gh's dnf4 repo), pacman, else the tool's install
  page. gh, Claude Code and Codex use their projects' own commands. `air serve` prints the same fixes.
- `air serve` now refuses to start when workspace_root can't be made (not a directory, or not writable),
  instead of failing at the first claim.
- An agent or login problem fails doctor only when no login is ready; with one ready it is a warning (`!`).

## 2026-11-23: #30 and #31 under the P0 boundary test

- `air doctor` (#30) and the cleanup work (#31) were written before the boundary test and added 19 violations.
  They are fixed in the code; ALLOWED did not grow. The first domain indexes (`lib`, `gh`, `setup`, `server`,
  `agents`) export only what their importers need today, and grow as later phases route imports through them.
- `Io` lives in `lib/io.ts` and `Invocation` in `cli/args.ts`, not in `cli/main.ts`, so no command imports the
  router that imports it. That removed every `cli` file cycle: 49 entries left ALLOWED.
- `serve/hints.ts` is in the setup domain (install fixes for a volunteer's machine), and `resolveBinary` moved
  there from `serve/preflight.ts`, which imports it, so hints no longer import preflight back.
- `pid.ts` is in lib.
