// A stand-in `claude`: `--version` prints FAKE_CLAUDE_VERSION; `-p /usage` prints FAKE_CLAUDE_OUTPUT (a file,
// default the recorded stream). It records the CLAUDE_CONFIG_DIR it saw in FAKE_CLAUDE_SEEN, and exits 3 if it
// was handed a credential the readers must not pass on.
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const LEAKS = ['GH_TOKEN', 'GITHUB_TOKEN', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'AWS_SECRET_ACCESS_KEY'];
if (LEAKS.some(k => k in process.env)) process.exit(3);
const args = process.argv.slice(2);
if (process.env.FAKE_CLAUDE_SEEN) appendFileSync(process.env.FAKE_CLAUDE_SEEN, `${process.env.CLAUDE_CONFIG_DIR ?? ''} ${args[0]}\n`);
if (args[0] === '--version') console.log(`${process.env.FAKE_CLAUDE_VERSION ?? '2.1.311'} (Claude Code)`);
else if (args[0] === '-p' && args[1] === '/usage') {
  if (process.env.FAKE_CLAUDE_EXIT) process.exit(Number(process.env.FAKE_CLAUDE_EXIT));
  process.stdout.write(readFileSync(process.env.FAKE_CLAUDE_OUTPUT ?? join(import.meta.dirname, 'claude-usage.stream.jsonl'), 'utf8'));
} else process.exit(2);
