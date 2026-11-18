// Codex's app-server answers `account/rateLimits/read` with no thread and no model turn: initialize, initialized,
// one request, EOF. Adapted from the factory's packages/runner/src/adapters/codex-usage.ts and parseCodexRateLimits.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { cliEnv, command, isoOrNull, killGroup, windowOfMinutes } from './run.ts';
import type { Reading, Window } from './types.ts';
import { VERSION } from '../version.ts';

export interface CodexOpts {
  /** Default `codex` on PATH. */
  bin?: string;
  /** CODEX_HOME for a second login; default the CLI's own (~/.codex). */
  codexHome?: string;
  /** The exact environment for the CLI (codexHome is set on top). Default: `cliEnv()`, an allowlisted copy of process.env. */
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/** The `rateLimits` object: `primary`/`secondary` { usedPercent, windowDurationMins, resetsAt (epoch s) }. */
export function parseCodexRateLimits(r: any): Window[] {
  if (!r || typeof r !== 'object') return [];
  const slots = (['primary', 'secondary'] as const).map(slot => [slot, r[slot]] as const)
    .filter(([, w]) => w && typeof w.usedPercent === 'number' && Number.isFinite(w.usedPercent) && w.usedPercent >= 0);
  // Codex flags a reached limit separately; with no window at 100% the flag is the primary's.
  const anyFull = slots.some(([, w]) => w.usedPercent >= 100);
  return slots.map(([slot, w]): Window => {
    const { name, kind } = windowOfMinutes(w.windowDurationMins, slot);
    const resetsAt = typeof w.resetsAt === 'number' ? isoOrNull(w.resetsAt * 1000) : null;
    const reached = !anyFull && slot === 'primary' && !!r.rateLimitReachedType;
    return { name, kind, usedPct: reached ? 100 : w.usedPercent, resetsAt };
  });
}

/** Send one app-server request after the handshake; resolves its `result`, or `{ error }`. */
export function appServerRequest(o: CodexOpts, method: string, params: object): Promise<{ result?: any; error?: string }> {
  const env = { ...(o.env ?? cliEnv()) };
  if (o.codexHome) env.CODEX_HOME = o.codexHome;
  const [file, ...pre] = command(o.bin ?? 'codex');
  return new Promise(resolve => {
    let done = false;
    const child = spawn(file, [...pre, 'app-server', '--listen', 'stdio://'], { env, detached: true, stdio: ['pipe', 'pipe', 'ignore'] });
    const lines = createInterface({ input: child.stdout });
    const finish = (v: { result?: any; error?: string }) => {
      if (done) return;
      done = true; clearTimeout(timer); lines.close(); child.stdin.destroy(); child.stdout.destroy();
      killGroup(child);
      resolve(v);
    };
    const timer = setTimeout(() => finish({ error: 'timeout' }), o.timeoutMs ?? 20000);
    const write = (v: object) => child.stdin.write(JSON.stringify(v) + '\n');
    let bytes = 0;
    child.stdin.on('error', () => {});
    child.on('error', (e: Error) => finish({ error: `cannot run codex: ${e.message}` }));
    child.on('close', () => finish({ error: 'codex app-server exited' }));
    lines.on('line', line => {
      if ((bytes += line.length) > 1 << 20) return finish({ error: 'oversized reply' });
      let m: any;
      try { m = JSON.parse(line); } catch { return; }
      if (m.method) return; // notifications
      if (m.id === 1) {
        if (m.error) return finish({ error: String(m.error.message ?? 'initialize failed') });
        write({ method: 'initialized' });
        write({ id: 2, method, params });
      } else if (m.id === 2) {
        finish(m.error ? { error: String(m.error.message ?? 'request failed') } : { result: m.result });
      }
    });
    write({ id: 1, method: 'initialize', params: { clientInfo: { name: 'air', title: 'air', version: VERSION },
      capabilities: { experimentalApi: false } } });
  });
}

export async function readCodex(o: CodexOpts = {}): Promise<Reading> {
  const r = await appServerRequest(o, 'account/rateLimits/read', { excludeResetCreditDetails: true });
  if (r.error) return { windows: [], note: `codex: ${r.error}` };
  const limits = r.result?.rateLimits;
  const windows = parseCodexRateLimits(limits);
  if (!windows.length) return { windows: [], note: 'codex reported no rate-limit windows' };
  // The primary window is the one Codex enforces first; a secondary alone is not a full reading.
  return typeof limits?.primary?.usedPercent === 'number' && limits.primary.usedPercent >= 0 ? { windows }
    : { windows, incomplete: true, note: 'incomplete: codex reported no primary rate-limit window' };
}
