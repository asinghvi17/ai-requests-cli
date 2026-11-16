---
air: 0
effort: L
harness: [claude]
model: large
repos:
  - url: https://github.com/acme-analytics/billing-service.git
    ref: main
    path: service
  - url: https://github.com/acme-analytics/billing-client.git
    ref: main
    path: client
  - url: https://github.com/acme-analytics/api-guidelines.git
    ref: v3
    deliver: none
setup:
  - cd repo/service && npm ci
  - cd repo/client && npm ci
check: cd repo/service && npm test -- --run src/api
deliver: pr
timeout: 6h
---

## Task

Add pagination to the invoice list endpoint and its client.

- billing-service: `GET /v1/invoices` takes `limit` (1 to 200, default 50) and `cursor`, and returns
  `{ data, next_cursor }`. The cursor is opaque to clients: base64url of `(created_at, id)` of the last
  row. Keep the unpaginated response for requests without `limit` or `cursor` until v2; log a deprecation
  warning for them.
- billing-client: `listInvoices()` returns an async iterator over all pages, and `listInvoicesPage()`
  returns one page. Update the README example.

Follow the pagination rules in `repo/api-guidelines/pagination.md` (read-only: don't change it).

## Done when

- One pull request on billing-service and one on billing-client, each with tests: first page, middle page,
  last page (`next_cursor: null`), an invalid cursor (400), and `limit` out of range (400).
- `npm test` passes in `repo/service` and in `repo/client`.
- The summary in `out/REPORT.md` (air puts it in both PR descriptions, which link each other) says the
  client PR must merge after the service PR.

## Context

- `repo/service/src/api/invoices.ts` holds the handler; queries are in `src/db/invoices.ts`, with an index
  on `(customer_id, created_at, id)` already.
- `repo/client/src/invoices.ts` holds the client; `src/http.ts` has the request helper.
- `repo/api-guidelines` is the company API style guide at tag `v3`.

## Notes

The two PRs are reviewed by different teams: keep each PR to its own repo, and don't refactor beyond what
pagination needs.
