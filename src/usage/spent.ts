// What a job's agent spent, in US dollars at API prices: its tokens, from the agent's own session records,
// priced per call with the one table in prices.ts. One source per agent:
// - Claude Code: the session transcripts `<config dir>/projects/<project>/<session id>.jsonl`, plus its
//   subagents' under `<session id>/`. Each API response is an `assistant` line whose `message.model` and
//   `message.usage` (input, 5-minute and 1-hour cache writes, cache reads, output, `speed`, `inference_geo`)
//   describe that call; a response with several content blocks repeats the same `message.id`, so lines count
//   once per id. Claude Code's own total (`cost-state.totalCostUSD`) is written only when a session exits,
//   so a running or killed session has none; priced from the same tokens it agrees with this table.
// - Codex CLI: the rollouts `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl` whose `session_meta` names the
//   workspace as `cwd`. `turn_context` lines name the model; each `event_msg` of type `token_count` holds the
//   session's running total in `info.total_token_usage` (input with cached input inside it, output), so each
//   increase is priced at the model then in use. A session resumed into another file counts each token once.
// Undefined means the agent left no usage record air can read: then nothing is charged, rather than a guess.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { callCost } from './prices.ts';

/** A job's cost at API prices, and the models it used that the price table doesn't cover (their calls cost nothing here). */
export interface Spent {
  usd: number;
  unpriced: string[];
}

const SESSION_ID = /^[A-Za-z0-9-]+$/;

function jsonLines(file: string): unknown[] {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: unknown[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // a line being written, or not JSON
    }
  }
  return out;
}

function jsonlFiles(dir: string, depth: number): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((n) => {
    const p = join(dir, n);
    if (n.endsWith('.jsonl')) return [p];
    return depth > 0 ? jsonlFiles(p, depth - 1) : [];
  });
}

const count = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : 0);

class Tally {
  usd = 0;
  calls = 0;
  readonly unpriced = new Set<string>();
  add(model: string, cost: number | undefined): void {
    this.calls++;
    if (cost === undefined) this.unpriced.add(model);
    else this.usd += cost;
  }
  result(): Spent | undefined {
    return this.calls ? { usd: this.usd, unpriced: [...this.unpriced].sort() } : undefined;
  }
}

type ClaudeUsage = Record<string, unknown> & { cache_creation?: Record<string, unknown> };

/**
 * What Claude Code spent in the sessions `ids`, from their transcripts under `configDir` (CLAUDE_CONFIG_DIR,
 * default `~/.claude`). Undefined if no transcript of them has a usage record.
 */
export function claudeSpent(configDir: string, ids: string[]): Spent | undefined {
  const projects = join(configDir, 'projects');
  let dirs: string[];
  try {
    dirs = readdirSync(projects).map((d) => join(projects, d));
  } catch {
    return undefined;
  }
  const calls = new Map<string, { model: string; usage: ClaudeUsage }>();
  for (const id of new Set(ids)) {
    if (!SESSION_ID.test(id)) continue;
    for (const d of dirs) {
      for (const f of [join(d, `${id}.jsonl`), ...jsonlFiles(join(d, id), 2)]) {
        for (const v of jsonLines(f) as { type?: string; uuid?: string; message?: { id?: string; model?: unknown; usage?: ClaudeUsage } }[]) {
          const u = v?.type === 'assistant' ? v.message?.usage : undefined;
          const key = v?.message?.id ?? v?.uuid;
          if (u && typeof u === 'object' && typeof key === 'string') calls.set(key, { model: String(v.message?.model ?? '?'), usage: u });
        }
      }
    }
  }
  const tally = new Tally();
  for (const { model, usage: u } of calls.values()) {
    const written = count(u.cache_creation_input_tokens);
    const w1h = Math.min(written, count(u.cache_creation?.ephemeral_1h_input_tokens));
    const t = { input: count(u.input_tokens), cacheWrite5m: written - w1h, cacheWrite1h: w1h, cacheRead: count(u.cache_read_input_tokens), output: count(u.output_tokens) };
    // Claude Code's own placeholders (errors, interruptions) made no API call.
    if (t.input + written + t.cacheRead + t.output === 0) continue;
    const fast = u.speed === 'fast';
    tally.add(fast ? `${model} (fast mode)` : model, callCost(model, t, { fast, us: u.inference_geo === 'us' }));
  }
  return tally.result();
}

/** Codex rollout files modified at or after `since` (less a minute), newest first. */
export function codexRollouts(codexHome: string, since: Date): string[] {
  const files: { path: string; mtime: number }[] = [];
  for (const path of jsonlFiles(join(codexHome, 'sessions'), 3)) {
    if (!/\/rollout-[^/]*\.jsonl$/.test(path)) continue;
    try {
      const mtime = statSync(path).mtimeMs;
      if (mtime >= since.getTime() - 60_000) files.push({ path, mtime });
    } catch {
      // gone
    }
  }
  return files.sort((a, b) => b.mtime - a.mtime).map((f) => f.path);
}

interface CodexTotals { input_tokens?: unknown; cached_input_tokens?: unknown; output_tokens?: unknown }
type CodexLine = { type?: string; payload?: { type?: string; id?: string; cwd?: string; model?: unknown; info?: { total_token_usage?: CodexTotals; last_token_usage?: CodexTotals } | null } };

/**
 * What Codex spent in its sessions started in `cwd` since `since`, from their rollouts under `codexHome`
 * (CODEX_HOME, default `~/.codex`). Undefined if no such rollout has a token count.
 */
export function codexSpent(codexHome: string, cwd: string, since: Date): Spent | undefined {
  const tally = new Tally();
  const seen = new Map<string, { input: number; cached: number; output: number }>();
  for (const f of codexRollouts(codexHome, since).reverse()) {
    const lines = jsonLines(f) as CodexLine[];
    const meta = lines[0];
    if (meta?.type !== 'session_meta' || meta.payload?.cwd !== cwd || typeof meta.payload.id !== 'string') continue;
    const session = meta.payload.id;
    let model = '?';
    for (const v of lines) {
      if (v?.type === 'turn_context' && typeof v.payload?.model === 'string') model = v.payload.model;
      const total = v?.type === 'event_msg' && v.payload?.type === 'token_count' ? v.payload.info?.total_token_usage : undefined;
      if (!total) continue;
      const now = { input: count(total.input_tokens), cached: count(total.cached_input_tokens), output: count(total.output_tokens) };
      const before = seen.get(session) ?? { input: 0, cached: 0, output: 0 };
      const d = { input: Math.max(0, now.input - before.input), cached: Math.max(0, now.cached - before.cached), output: Math.max(0, now.output - before.output) };
      seen.set(session, { input: Math.max(now.input, before.input), cached: Math.max(now.cached, before.cached), output: Math.max(now.output, before.output) });
      if (d.input + d.output === 0) continue;
      const cached = Math.min(d.cached, d.input);
      const prompt = count(v.payload?.info?.last_token_usage?.input_tokens) || d.input;
      tally.add(model, callCost(model, { input: d.input - cached, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: cached, output: d.output }, { prompt }));
    }
  }
  return tally.result();
}
