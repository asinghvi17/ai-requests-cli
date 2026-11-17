// Agent command lines. Claude Code runs interactively with the model for the matched tier and a session id
// air picks (`--session-id`), so it can be resumed with `--resume`. Codex CLI runs interactively too; its
// session id is found afterwards in its rollout files, for `codex resume`.
import { closeSync, openSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Agent } from '../config.ts';
import { codexRollouts } from '../usage/spent.ts';
import { TASK_INSTRUCTION } from '../workspace/launch.ts';

export type Harness = 'claude' | 'codex';

/** The instruction for a fresh start after an interrupted run whose session could not be resumed. */
export function restartInstruction(hasRepo: boolean): string {
  return `${TASK_INSTRUCTION} This task was started before and interrupted: first read out/PROGRESS.md` +
    `${hasRepo ? ' and the git log of each repo under repo/' : ''} to see where it stands, and continue from there.`;
}
export const RESUME_INSTRUCTION = 'You were interrupted. Continue the task described in AIR_TASK.md where you left off.';
/** The one resume after the agent exited without AIR_DONE (spec §11 rule 3). */
export function exitResumeInstruction(hasRepo: boolean): string {
  return 'Your session ended before the task was finished (there is no AIR_DONE). Read out/PROGRESS.md' +
    `${hasRepo ? ' and the git log of each repo under repo/' : ''}, then continue the task described in AIR_TASK.md, and create AIR_DONE only when it is done.`;
}

export interface AgentArgs {
  harness: Harness;
  agent: Agent;
  model: string;
  /** Resume this session instead of starting fresh. */
  resume?: string;
  /** For a fresh Claude Code start: the session id to create. */
  sessionId?: string;
  /** Last word: the prompt. */
  instruction: string;
}

export function agentArgv(a: AgentArgs): string[] {
  const { command, args } = a.agent;
  if (a.harness === 'claude') {
    const session = a.resume !== undefined ? ['--resume', a.resume] : a.sessionId !== undefined ? ['--session-id', a.sessionId] : [];
    return [...command, ...session, '--model', a.model, ...args, a.instruction];
  }
  if (a.resume !== undefined) return [...command, 'resume', a.resume, ...args, a.instruction];
  return [...command, '--model', a.model, ...args, a.instruction];
}

/**
 * The newest Codex session (rollout file) started in `cwd` at or after `since`, from
 * `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`, whose first line is a `session_meta` record.
 */
export function findCodexSession(cwd: string, since: Date, codexHome = process.env.CODEX_HOME || join(homedir(), '.codex')): string | undefined {
  for (const path of codexRollouts(codexHome, since)) {
    const meta = firstLine(path);
    try {
      const v = JSON.parse(meta ?? '') as { type?: string; payload?: { id?: string; cwd?: string } };
      if (v.type === 'session_meta' && v.payload?.cwd === cwd && typeof v.payload.id === 'string' && /^[A-Za-z0-9-]+$/.test(v.payload.id)) return v.payload.id;
    } catch {
      // not a rollout we understand
    }
  }
  return undefined;
}

function firstLine(path: string): string | undefined {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(64 * 1024);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const s = buf.subarray(0, n).toString('utf8');
    const nl = s.indexOf('\n');
    return nl < 0 ? s : s.slice(0, nl);
  } finally {
    closeSync(fd);
  }
}
