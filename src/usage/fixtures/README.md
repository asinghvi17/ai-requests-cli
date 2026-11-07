- `claude-usage.stream.jsonl`: a real `claude -p /usage --output-format stream-json --verbose` run (Claude Code
  2.1.311, 2026-11-07), scrubbed: session/message IDs zeroed, the text report and result text removed.
  `usage_report` is verbatim.
- `codex-auth-required.json`: the real codex-cli 0.164.0 app-server reply with no login.
- `codex-rate-limits.json`: synthetic (no Codex login on the recording machine), in the shape of the factory's
  fake app-server and codex-cli 0.164.0's generated types.
- `codex-secondary-only.json`: synthetic; a reply with no primary window (an incomplete reading).
- `fake-claude.ts`, `fake-codex.ts`, `fake-hang.ts`: stand-in CLIs the readers run in tests.
