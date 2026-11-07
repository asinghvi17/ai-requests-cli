// Claude Code (2.1.280+) handles `/usage` locally in print mode: no model turn, no tokens spent. Its stream-json
// synthetic assistant event carries usage_report.rate_limits.limits [{ kind, percent, resets_at, scope }].
// Adapted from the factory's packages/runner/src/adapters/claude-usage.ts.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cliEnv, run } from './run.ts';
import type { Reading, Window } from './types.ts';

export interface ClaudeOpts {
  /** Default `claude` on PATH. */
  bin?: string;
  /** CLAUDE_CONFIG_DIR for a second login; default the CLI's own (~/.claude). */
  configDir?: string;
  /** The exact environment for the CLI (configDir is set on top). Default: `cliEnv()`, an allowlisted copy of process.env. */
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export const CLAUDE_USAGE_ARGS = ['-p', '/usage', '--output-format', 'stream-json', '--verbose', '--safe-mode',
  '--no-session-persistence', '--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'];

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

export function parseClaudeUsage(text: string): Window[] {
  const out = new Map<string, Window>();
  for (const line of text.split('\n')) {
    let event: any;
    try { event = JSON.parse(line); } catch { continue; }
    if (event?.type !== 'assistant' || event.local_command_run?.command !== 'usage') continue;
    const limits = event.usage_report?.rate_limits?.limits;
    if (!Array.isArray(limits)) continue;
    for (const row of limits) {
      if (typeof row?.percent !== 'number' || !Number.isFinite(row.percent) || row.percent < 0) continue;
      const reset = typeof row.resets_at === 'string' ? Date.parse(row.resets_at) : NaN;
      const resetsAt = Number.isFinite(reset) ? new Date(reset).toISOString() : null;
      let w: Window | null = null;
      if (row.kind === 'session') w = { name: 'five_hour', kind: 'five_hour', usedPct: row.percent, resetsAt };
      else if (row.kind === 'weekly_all') w = { name: 'seven_day', kind: 'weekly', usedPct: row.percent, resetsAt };
      else if (row.kind === 'weekly_scoped') {
        // A per-model meter: it only binds work on that model, so it is kept apart from the all-model week.
        const model = row.scope?.model?.display_name;
        if (typeof model !== 'string' || !slug(model)) continue;
        w = { name: `seven_day_${slug(model)}`, kind: 'weekly', usedPct: row.percent, resetsAt, scope: model };
      }
      if (w) out.set(w.name, w);
    }
  }
  return [...out.values()];
}

export async function readClaude(o: ClaudeOpts = {}): Promise<Reading> {
  const bin = o.bin ?? 'claude';
  const env = { ...(o.env ?? cliEnv()) };
  if (o.configDir) env.CLAUDE_CONFIG_DIR = o.configDir;
  // An empty cwd: no project's CLAUDE.md, hooks or MCP servers load into the read.
  const cwd = mkdtempSync(join(tmpdir(), 'air-claude-usage-'));
  try {
    let version: string;
    try { version = (await run(bin, ['--version'], { env, cwd, timeoutMs: o.timeoutMs })).trim(); }
    catch { return { windows: [], note: `cannot run ${bin}` }; }
    const v = /^(\d+)\.(\d+)\.(\d+) \(Claude Code\)$/.exec(version);
    const [major, minor, patch] = v ? [Number(v[1]), Number(v[2]), Number(v[3])] : [0, 0, 0];
    if (major < 2 || (major === 2 && (minor < 1 || (minor === 1 && patch < 280)))) {
      return { windows: [], note: `claude ${version || '?'} cannot report usage without a model turn (need 2.1.280+)` };
    }
    let text: string;
    try { text = await run(bin, CLAUDE_USAGE_ARGS, { env, cwd, timeoutMs: o.timeoutMs }); }
    catch { return { windows: [], note: 'claude /usage failed: network, login or timeout' }; }
    const windows = parseClaudeUsage(text);
    if (!windows.length) return { windows: [], note: 'claude /usage gave no limits (not logged in, API key, or schema change)' };
    // The all-model week is what bounds a subscription; a 5-hour meter alone must not pass for a full reading.
    return windows.some(w => w.name === 'seven_day') ? { windows }
      : { windows, incomplete: true, note: 'incomplete: claude /usage reported no weekly (all-model) limit' };
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}
