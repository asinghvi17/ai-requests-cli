// A stand-in `claude`: `--version` prints FAKE_CLAUDE_VERSION; `-p /usage` prints FAKE_CLAUDE_OUTPUT (a file).
// It records the CLAUDE_CONFIG_DIR it saw in FAKE_CLAUDE_SEEN, so tests can check per-login config dirs.
import { appendFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (process.env.FAKE_CLAUDE_SEEN) appendFileSync(process.env.FAKE_CLAUDE_SEEN, `${process.env.CLAUDE_CONFIG_DIR ?? ''} ${args[0]}\n`);
if (args[0] === '--version') console.log(`${process.env.FAKE_CLAUDE_VERSION ?? '2.1.311'} (Claude Code)`);
else if (args[0] === '-p' && args[1] === '/usage') {
  if (process.env.FAKE_CLAUDE_EXIT) process.exit(Number(process.env.FAKE_CLAUDE_EXIT));
  process.stdout.write(readFileSync(process.env.FAKE_CLAUDE_OUTPUT!, 'utf8'));
} else process.exit(2);
