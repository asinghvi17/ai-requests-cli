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
