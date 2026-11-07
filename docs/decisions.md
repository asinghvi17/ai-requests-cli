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
