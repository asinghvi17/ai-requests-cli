// Agent command lines. Claude Code runs interactively with the model for the matched tier and a session id
// air picks (`--session-id`), so it can be resumed with `--resume`. Codex CLI runs interactively too; its
// session id is found afterwards in its rollout files, for `codex resume`.
//
// A fresh start gets no prompt on argv: once the agent's screen is ready (`agentReady`), air pastes the
// whole task into it as the first message (`taskMessage`, sent by the tmux layer's `send`). A resume, whose
// session already holds the task, gets a short instruction as its last argument.
//
// Neither may stop at a folder-trust prompt. Claude Code inherits the trust of a folder above the job dir,
// which `air serve` checks at startup (a git root is a boundary: it doesn't inherit across one). Codex asks whenever the
// job dir is in a git repo or is one, and also when a job's agent made it one before a restart. So every
// Codex launch and resume trusts the job dir for that session only, with a config override (`codexTrust`):
// nothing is written to the volunteer's Codex config.
import { closeSync, openSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Agent } from '../config.ts';
import { codexRollouts } from '../usage/spent.ts';
import { TASK_FILE } from '../workspace/task.ts';

export type Harness = 'claude' | 'codex';

/**
 * A fresh start's first message: `task` (the text of AIR_TASK.md), saying where it is kept for re-reading.
 * `restart` when an interrupted run's session could not be resumed: the message says to pick up its work.
 */
export function taskMessage(task: string, restart?: { hasRepo: boolean }): string {
  const again = restart
    ? 'This task was started before and interrupted: first read out/PROGRESS.md' +
      `${restart.hasRepo ? ' and the git log of each repo under repo/' : ''} to see where it stands, and continue from there.\n\n`
    : '';
  return `${again}Your task follows. It is also in ${TASK_FILE} in your working directory: read that file again whenever ` +
    `you need the task back (after your context is compacted, say).\n\n${task.trimEnd()}\n`;
}

const RULE = /^─{20,}$/;

/**
 * Whether `screen` (the pane's visible text) shows the agent's input box, ready for a message. Claude Code
 * draws its prompt `❯` (then a no-break space) between two rules; Codex its composer `› ` above the
 * `? for shortcuts` footer. Dialogs (trust, login, approvals) list their choices with the same marks but have
 * neither frame. From the captured screens fixtures/panes/claude-ready.txt and codex-ready.txt.
 */
export function agentReady(harness: Harness, screen: string): boolean {
  const lines = screen.split('\n').map((l) => l.trimEnd()).filter((l) => l !== '').slice(-8);
  if (harness === 'claude') return lines.some((l, i) => /^❯(\s|$)/.test(l) && RULE.test(lines[i - 1] ?? '') && RULE.test(lines[i + 1] ?? ''));
  const composer = lines.findIndex((l) => l.startsWith('› '));
  return composer >= 0 && lines.slice(composer + 1).some((l) => /\? for shortcuts|context left/.test(l));
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
  /** A resume's last word: what to do next. A fresh start has none; its task is pasted (`taskMessage`). */
  instruction?: string;
  /** The job dir the agent starts in, symlinks resolved (Codex keys trust on the real path). */
  dir: string;
}

/**
 * `-c` override that makes Codex trust `dir` for this session. The value is an inline table: the dotted form
 * (`projects."<dir>".trust_level`) is split at every `.`, including those inside the quoted path.
 */
export function codexTrust(dir: string): string[] {
  return ['-c', `projects={${JSON.stringify(dir)}={trust_level="trusted"}}`];
}

export function agentArgv(a: AgentArgs): string[] {
  const { command, args } = a.agent;
  const last = a.instruction !== undefined ? [a.instruction] : [];
  if (a.harness === 'claude') {
    const session = a.resume !== undefined ? ['--resume', a.resume] : a.sessionId !== undefined ? ['--session-id', a.sessionId] : [];
    return [...command, ...session, '--model', a.model, ...args, ...last];
  }
  if (a.resume !== undefined) return [...command, 'resume', a.resume, ...codexTrust(a.dir), ...args, ...last];
  return [...command, '--model', a.model, ...codexTrust(a.dir), ...args, ...last];
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
