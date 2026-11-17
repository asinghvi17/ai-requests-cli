---
air: 0
effort: M
harness: [claude, codex]
model: medium
repos:
  - url: https://github.com/acme-analytics/TimeSeriesKit.jl.git
    ref: main
setup:
  - julia --project=repo/TimeSeriesKit.jl -e 'using Pkg; Pkg.instantiate()'
check: julia --project=repo/TimeSeriesKit.jl -e 'using TimeSeriesKit'
deliver: pr
deadline: 2026-11-20
timeout: 3h
---

## Task

Add `resample` to TimeSeriesKit.jl.

Add a `resample` function to TimeSeriesKit.jl that aggregates a `TimeSeries` onto a regular time grid.

Signature, exported from the package:

```julia
resample(ts::TimeSeries, period::Dates.Period; agg = mean, origin = :start) -> TimeSeries
```

- Buckets are half-open, `[t, t + period)`. With `origin = :start` the first bucket starts at
  `first(timestamps(ts))` floored to `period` (use `Dates.floor`); `origin` may also be a `DateTime`.
- `agg` is any function from a vector of values to a scalar, applied to each column independently.
- Empty buckets produce `missing` in every column (the result's element type widens to
  `Union{Missing, T}` only if at least one bucket is empty).
- Throw `ArgumentError` for a non-positive `period` or an unsorted input (`issorted(timestamps(ts))`).

Follow the style of `rolling` in `src/rolling.jl`, which is the closest existing function.

## Done when

- `resample` is exported, has a docstring with a runnable `jldoctest`, and is listed in `docs/src/api.md`.
- New tests in `test/resample.jl` (included from `test/runtests.jl`) cover: hourly → daily mean, a gap
  that yields `missing`, a custom `agg` (`sum`), a `DateTime` origin, and both `ArgumentError` cases.
- `julia --project=. -e 'using Pkg; Pkg.test()'` passes in `repo/TimeSeriesKit.jl`.
- The PR description explains the bucket convention in one paragraph.

## Context

The package is checked out in `repo/TimeSeriesKit.jl`.

- `src/TimeSeriesKit.jl` holds the module and export list; `src/types.jl` defines `TimeSeries`
  (a sorted `Vector{DateTime}` plus a `Matrix` of values with column names).
- `src/rolling.jl` implements windowed aggregation and its tests are in `test/rolling.jl`.
- CI runs on Julia 1.10 and 1.11; don't use features newer than 1.10.

## Notes

Don't add dependencies; `Statistics` and `Dates` are already in `[deps]`. Keep the change to new code plus
the export line; don't reformat existing files.
