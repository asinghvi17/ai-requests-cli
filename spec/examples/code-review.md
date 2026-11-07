---
air: 0
effort: S
harness: [claude, codex]
model: large
repo:
  url: https://github.com/acme-analytics/billing-service.git
  ref: feature/proration-v2
setup:
  - git fetch origin main
check: git rev-parse --verify --quiet origin/main
deliver: comment
timeout: 1h
---

## Task

Review the branch `feature/proration-v2` against `main` (`git diff origin/main...HEAD`). It replaces the
mid-cycle plan-change logic in `src/billing/proration.ts` with a day-based calculation and adds a
migration for existing credits.

Look for, in order of priority:

1. Money errors: rounding, currency units (amounts are integer cents everywhere), off-by-one days at
   period boundaries, time-zone handling (billing periods are in the customer's `billing_tz`).
2. Behaviour changes for customers who are not changing plans.
3. The migration in `migrations/2026_11_proration_credits.sql`: is it safe to run twice, and on a live table?
4. Missing tests for the above.

Don't comment on formatting or naming unless it hides a bug. Don't push anything.

## Done when

- The comment lists findings most severe first, each with `file:line`, what goes wrong with a concrete
  example (input → wrong output), and a suggested fix.
- Every claim of a bug was checked by reading the code it depends on; mark anything unverified as
  "unverified".
- It ends with a one-line verdict: "merge", "merge after fixes" or "needs rework".
- If no problems are found, the comment says so and lists what was checked.

## Context

- `src/billing/proration.ts` is the core change; `src/billing/periods.ts` defines billing periods and is
  unchanged but matters for boundary cases.
- Tests run with `npm test` (no network needed after `npm ci`); the review may run them but doesn't have to.
- The design note the author followed is `docs/design/proration-v2.md` on the branch.
