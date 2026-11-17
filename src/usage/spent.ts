// What a job's agent actually spent, in tokens, from the agent's own session records, for charging a manual
// budget. One source per agent:
// - Claude Code: the session transcripts `<config dir>/projects/<project>/<session id>.jsonl`, plus its
//   subagents' under `<session id>/`. Each API response is an `assistant` line whose `message.usage` holds
//   that call's tokens; a response with several content blocks repeats the same `message.id` and usage, so
//   lines are counted once per id.
// - Codex CLI: the rollouts `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl` whose `session_meta` names the
//   workspace as `cwd`. Each `event_msg` of type `token_count` holds the session's running total in
//   `info.total_token_usage.total_tokens`; a session's spend is its largest total.
// Tokens are everything the model read or wrote: input, cache writes and cache reads, and output (Codex's
// `total_tokens` is input, cached input included, plus output). Undefined means the agent left no record
// air can read: then nothing is charged, rather than a guess.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

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

/**
 * Tokens Claude Code spent in the sessions `ids`, read from their transcripts under `configDir`
 * (CLAUDE_CONFIG_DIR, default `~/.claude`). Undefined if no transcript of them has a usage record.
 */
export function claudeSpent(configDir: string, ids: string[]): number | undefined {
  const projects = join(configDir, 'projects');
  let dirs: string[];
  try {
    dirs = readdirSync(projects).map((d) => join(projects, d));
  } catch {
    return undefined;
  }
  const usage = new Map<string, Record<string, unknown>>();
  for (const id of new Set(ids)) {
    if (!SESSION_ID.test(id)) continue;
    for (const d of dirs) {
      for (const f of [join(d, `${id}.jsonl`), ...jsonlFiles(join(d, id), 2)]) {
        for (const v of jsonLines(f) as { type?: string; uuid?: string; message?: { id?: string; usage?: Record<string, unknown> } }[]) {
          const u = v?.type === 'assistant' ? v.message?.usage : undefined;
          const key = v?.message?.id ?? v?.uuid;
          if (u && typeof u === 'object' && typeof key === 'string') usage.set(key, u);
        }
      }
    }
  }
  if (usage.size === 0) return undefined;
  let total = 0;
  for (const u of usage.values()) total += count(u.input_tokens) + count(u.cache_creation_input_tokens) + count(u.cache_read_input_tokens) + count(u.output_tokens);
  return total;
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

/**
 * Tokens Codex spent in its sessions started in `cwd` since `since`, from their rollouts under `codexHome`
 * (CODEX_HOME, default `~/.codex`). Undefined if no such rollout has a token count.
 */
export function codexSpent(codexHome: string, cwd: string, since: Date): number | undefined {
  const sessions = new Map<string, number>();
  for (const f of codexRollouts(codexHome, since)) {
    const lines = jsonLines(f) as { type?: string; payload?: { type?: string; id?: string; cwd?: string; info?: { total_token_usage?: { total_tokens?: unknown } } } }[];
    const meta = lines[0];
    if (meta?.type !== 'session_meta' || meta.payload?.cwd !== cwd || typeof meta.payload.id !== 'string') continue;
    // A session resumed in another file is counted once, at its largest total.
    let most = sessions.get(meta.payload.id);
    for (const v of lines) {
      const t = v?.type === 'event_msg' && v.payload?.type === 'token_count' ? v.payload.info?.total_token_usage?.total_tokens : undefined;
      if (typeof t === 'number' && Number.isFinite(t) && t >= 0) most = Math.max(most ?? 0, t);
    }
    if (most !== undefined) sessions.set(meta.payload.id, most);
  }
  if (sessions.size === 0) return undefined;
  let total = 0;
  for (const t of sessions.values()) total += t;
  return total;
}
