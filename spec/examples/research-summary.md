---
air: 0
effort: S
harness: [any]
model: large
context:
  url: https://github.com/acme-analytics/ai-requests/releases/download/air-context/onboarding-interviews.zip
  sha256: b430babae81f6615121c5d27f155ced86328a6e8ea3a14d29733e6a8a662e12f
  bytes: 1843302
deliver: comment
timeout: 90m
---

## Task

Summarise the October 2026 onboarding interviews.

Read the twelve customer-interview transcripts in the context zip and write a findings summary about our
onboarding flow for the product team. The interviews were run in October 2026 with admins at companies that
signed up in the previous quarter; each transcript is a conversation between one interviewer (lines prefixed
`I:`) and one customer (`C:`).

Write the summary as Markdown, in this order:

1. **Top findings**: the five most important problems customers hit during onboarding, ranked by how many
   interviews mention them. For each: one sentence, the count (e.g. "7/12"), and one or two short verbatim
   quotes with the transcript file name.
2. **What worked**: up to three things customers praised unprompted.
3. **Requests**: concrete feature requests, deduplicated, with counts.
4. **Open questions**: things the transcripts contradict each other on or don't settle.

Report only what the transcripts say; don't recommend solutions.

## Done when

- The comment follows the four-part structure above and is under 800 words, excluding quotes.
- Every finding has a count and at least one quote whose file name exists in the zip.
- No customer names or company names appear; refer to people as "an admin at a 40-person agency" using
  `participants.csv`.

## Context

The zip extracts to:

- `transcripts/01-…md` to `transcripts/12-…md`: one file per interview, already cleaned of small talk.
- `participants.csv`: `file,company_size,industry,role`, one row per transcript; use it for anonymous
  descriptions.
- `discussion-guide.md`: the questions the interviewer worked from, useful for knowing which topics were
  prompted and which came up unprompted.

## Notes

Transcript 07 was cut short by a call drop; count it but say so if a finding depends on it.
