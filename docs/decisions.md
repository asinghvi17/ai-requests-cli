# Decisions

Append entries, newest last: date, decision, why.

- 2026-11-07: Request format v0 (spec/v0.md). Front matter in a strict YAML subset that every YAML parser
  reads identically (plain scalars with `: ` or ` #` must be quoted), parsed without a library. `model` is
  a tier (`small | medium | large`, default `medium`) that servers map to their own models. `repo.ref` is
  required, `timeout` is capped at 24h, `harness` may be a single value and `any` can't be combined.
  Lifecycle adds `air:paused` and requester-set `air:cancel`; claims are resolved by lowest comment id, and
  an `air-release` marker (same host+nonce) ends a claim so issues can be re-offered. Fixed workspace
  layout (`repo/`, `context/`, `out/`) and `$AIR_*` env vars give `setup`, `check` and `deliver: artifact`
  a defined meaning. Why: the server must act on the format without guessing.

- 2026-11-07: v0 hardening after review of PR #3 (`air` stays 0; v0 is unreleased). Context zips are
  downloaded once to a file, checked against `bytes`/`sha256`, and their entries are checked for zip-slip
  (relative paths that stay inside `context/`, no symlinks or special files) before anything is written.
  For `deliver: pr` the issue author must have write/admin on `repo.url`, checked via the collaborator
  permission API, so a volunteer's credentials can't push for someone who couldn't. Markers count only
  from trusted authors (`OWNER`; `MEMBER`/`COLLABORATOR` are confirmed with the permission API) and only in
  unedited comments; servers never edit marker comments. Unquoted YAML 1.2 bools, nulls and numbers are
  errors in string fields (`ref: 1.10` would otherwise mean `1.1` to other parsers). URLs use a
  conservative character set, and servers run git/curl/gh with argv, never a shell. PR and
  `air-artifact` comment formats are fixed. Zips (context and artifacts) are release assets on the
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
- 2026-11-07: Second review of PR #3 (`air` stays 0).
  - Markers count only alone on their own line and outside fenced code, so quoting one does nothing.
  - An HTML comment left open on a heading line hides the section body for lint.
  - Sweep never deletes an asset while a referring issue is open or claimed/running/paused; `expires`
    applies only after close.
  - Context zips are capped at the smaller of 10 GiB and 20 × `bytes` uncompressed, checked against the
    central directory and again while writing.
  - Each setup command and `check` has a 30-minute timeout and stdin from /dev/null. Setup is
    deliberately outside `timeout`, so `timeout` keeps meaning "agent time", the quantity effort estimates.
  - A `deliver: pr` with no commits beyond `repo.ref` sets `air:failed`, not `air:done`: no requested
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
