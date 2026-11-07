// A stand-in `codex app-server --listen stdio://`: replays the handshake and answers account/rateLimits/read from
// FAKE_CODEX_REPLY (a JSON file: { result } or { error }). Writes the CODEX_HOME it saw to FAKE_CODEX_SEEN.
import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
if (process.argv[2] !== 'app-server') process.exit(2);
if (process.env.FAKE_CODEX_SEEN) writeFileSync(process.env.FAKE_CODEX_SEEN, process.env.CODEX_HOME ?? '');
const reply = JSON.parse(readFileSync(process.env.FAKE_CODEX_REPLY!, 'utf8'));
const send = (v: object) => process.stdout.write(JSON.stringify(v) + '\n');
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') {
    send({ id: m.id, result: { userAgent: 'air/0.164.0', codexHome: '/home/user/.codex', platformFamily: 'unix', platformOs: 'linux' } });
    send({ method: 'remoteControl/status/changed', params: { status: 'disabled' } });
  } else if (m.method === 'account/rateLimits/read') {
    if (process.env.FAKE_CODEX_HANG) return;
    send({ id: m.id, ...reply });
  }
});
