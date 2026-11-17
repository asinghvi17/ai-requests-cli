---
air: 0
effort: XS
model: medium
context:
  url: https://github.com/acme-analytics/ai-requests/releases/download/air-context/nightly-crash-logs.zip
  sha256: 5d41402abc4b2a76b9719d911017c592ae0e1a5f8d3c2c7f2f0b1e5c0a7d9e31
  bytes: 3207114
deliver: comment
timeout: 30m
---

## Task

Find why the nightly import job crashed on 2026-11-03 to 2026-11-05.

Our nightly import job crashed three nights in a row (2026-11-03 to 2026-11-05). Using only the logs in the
context zip, answer: what is the first error that leads to each crash, and is it the same cause each night?

## Done when

- The comment names, for each night, the first log line (file and line number) on the path to the crash.
- It says whether the three crashes share a cause, quoting the lines that show it.
- It lists anything in the logs that contradicts its answer.

## Context

`logs/2026-11-0{3,4,5}/` each hold `import.log` (the job) and `db.log` (the database it writes to), in UTC.
`deploys.txt` lists deploys in that week.
