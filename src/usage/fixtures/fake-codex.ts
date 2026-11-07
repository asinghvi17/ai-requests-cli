// A stand-in `codex app-server --listen stdio://`: replays the handshake and answers account/rateLimits/read from
// FAKE_CODEX_REPLY (a JSON file: { result } or { error }; default codex-rate-limits.json). Writes the CODEX_HOME
// it saw to FAKE_CODEX_SEEN, and exits 3 if it was handed a credential the readers must not pass on.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
const LEAKS = ['GH_TOKEN', 'GITHUB_TOKEN', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'AWS_SECRET_ACCESS_KEY'];
if (LEAKS.some(k => k in process.env)) process.exit(3);
if (process.argv[2] !== 'app-server') process.exit(2);
if (process.env.FAKE_CODEX_SEEN) writeFileSync(process.env.FAKE_CODEX_SEEN, process.env.CODEX_HOME ?? '');
const reply = JSON.parse(readFileSync(process.env.FAKE_CODEX_REPLY ?? join(import.meta.dirname, 'codex-rate-limits.json'), 'utf8'));
const send = (v: object) => process.stdout.write(JSON.stringify(v) + '\n');
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') {
    send({ id: m.id, result: { userAgent: 'air/0.164.0', codexHome: '/nonexistent/codex-home', platformFamily: 'unix', platformOs: 'linux' } });
    send({ method: 'remoteControl/status/changed', params: { status: 'disabled' } });
  } else if (m.method === 'account/rateLimits/read') {
    if (process.env.FAKE_CODEX_HANG) return;
    send({ id: m.id, ...reply });
  }
});
