---
air: 0
effort: S
harness: [claude, codex]
model: large
repos:
  - url: https://github.com/acme-analytics/billing-service.git
    pr: 212
    path: service
  - url: https://github.com/acme-analytics/billing-client.git
    pr: 87
    path: client
  - url: https://github.com/acme-analytics/billing-service.git
    ref: main
    path: service-main
deliver: comment
timeout: 1h
---

## Task

Review two pull requests that ship together: billing-service#212 replaces the mid-cycle plan-change
logic in `src/billing/proration.ts` with a day-based calculation, and billing-client#87 updates the
client to the new `ProrationQuote` response. Neither has been reviewed against the other.

Look for, in order of priority:

1. Money errors: rounding, currency units (amounts are integer cents everywhere), off-by-one days at
   period boundaries, time-zone handling (billing periods are in the customer's `billing_tz`).
2. Contract mismatches: fields the service sends that the client ignores or misreads, or the reverse.
3. Behaviour changes for customers who are not changing plans: compare with `repo/service-main`.
4. Missing tests for the above.

Don't comment on formatting or naming unless it hides a bug. Don't push anything.

## Done when

- The comment lists findings most severe first, each with `repo/<path>/file:line`, what goes wrong with a
  concrete example (input → wrong output), and a suggested fix.
- Every claimed bug was checked by reading the code it depends on; anything unverified is marked
  "unverified".
- It ends with one verdict per PR: "merge", "merge after fixes" or "needs rework".

## Context

- `repo/service` is billing-service at the head of PR #212, `repo/client` is billing-client at the head of
  PR #87, and `repo/service-main` is billing-service's `main`, for comparison.
- `src/billing/proration.ts` is the core change; `src/billing/periods.ts` defines billing periods and is
  unchanged but matters for boundary cases.
- The response type is `ProrationQuote` in `repo/service/src/api/types.ts` and
  `repo/client/src/types.ts`.
