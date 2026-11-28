// A fresh start gets its task as its first message, pasted once the agent's screen is ready (`sendTask`); a
// resume gets a short instruction on argv. With a fake tmux that records starts and sends and plays screens.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claim } from './claim.ts';
import { createTrust } from '../request/trust.ts';
import { DEFAULT_AGENTS, type Config } from '../setup/config.ts';
import { fakeGitHub } from '../gh/testing/fake.ts';
import type { Tmux } from './tmux/tmux.ts';
import { readState, REQUEST_FILE, updateState, type JobRecord } from './workspace-state.ts';
import { TASK_FILE } from '../agents/harness.ts';
import { RESUME_INSTRUCTION, taskMessage } from '../agents/harness.ts';
import type { ServeContext } from './context.ts';
import type { ServeGitHub } from './github.ts';
import { sendTask, startAgent } from './jobs.ts';

const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const BODY = '---\nair: 0\neffort: XS\ndeliver: comment\n---\n\n## Task\n\nSummarise it.\n\n## Done when\n\n- It is summarised.\n';
const TASK = '# Summarise it (o/requests#7)\n\nThe request follows.\n\n## Task\n\nSummarise it.\n';
const RULE = '─'.repeat(40);
const CLAUDE_READY = `Claude Code\n\n${RULE}\n❯ \n${RULE}\n  ⏵⏵ auto mode on\n`;
const CODEX_READY = '>_ OpenAI Codex\n\n› Ask Codex to do anything\n\n  ? for shortcuts\n';
const TRUST = ' Quick safety check\n ❯ 1. Yes, I trust this folder\n   2. No, exit\n Enter to confirm · Esc to cancel\n';

/**
 * Issue 7 claimed and set up, its job `job`, and a fake tmux: `screens` are the screens it shows in turn (the
 * last one stays), `sent` what `send` got, `argv` each start's argv.
 */
async function held(job: Partial<JobRecord> = {}, screens: string[] = [CLAUDE_READY]) {
  const gh = fakeGitHub();
  gh.addIssue({ number: 7, body: BODY });
  const root = mkdtempSync(join(tmpdir(), 'air-send-'));
  dirs.push(root);
  const won = await claim({ gh, issue: 7, root, host: 'box', waitMs: 0, nonce: 'aaaaaaaaaaaa' });
  if (won.status !== 'won') throw new Error('should win');
  writeFileSync(join(won.dir, REQUEST_FILE), BODY);
  writeFileSync(join(won.dir, TASK_FILE), TASK);
  updateState(won.dir, { phase: 'ready', job: { status: 'ready', harness: 'claude', subscription: 'max', model: 'sonnet', runMs: 0, starts: 0, ...job } }, new Date());
  const sent: string[] = [], argv: string[][] = [], logs: string[] = [];
  let nonce = 'n0', shown = 0;
  const tmux = {
    startJob: async (input: { argv: string[] }) => { argv.push(input.argv); nonce = `n${argv.length}`; return '@1'; },
    listJobs: async () => [{ issue: 7, nonce, dead: false }],
    screen: async () => screens[Math.min(shown++, screens.length - 1)]!,
    send: async (_n: number, text: string) => { sent.push(text); return true; },
  } as unknown as Tmux;
  const ctx: ServeContext = {
    gh, api: {} as ServeGitHub, tmux, config: { agents: DEFAULT_AGENTS } as unknown as Config,
    root, host: 'box', ghHost: 'github.com', env: process.env, stateDir: root, trust: createTrust(gh),
    usage: async () => [], agentEnv: () => ({}), log: (s) => logs.push(s), now: () => new Date(), stopGraceMs: 0, resumeCheckMs: 0, agentReadyMs: 2000,
  };
  return { ctx, dir: won.dir, sent, argv, logs };
}

test('a fresh start puts no prompt on argv, then pastes the whole task once the input box is up and has settled', async () => {
  const { ctx, dir, sent, argv, logs } = await held({}, ['loading', CLAUDE_READY]);
  await startAgent(ctx, dir);
  assert.equal(argv[0]!.at(-1), 'auto', 'argv ends with the agent args');
  assert.ok(!argv[0]!.some((a) => a.includes('AIR_TASK')));
  assert.deepEqual(sent, [taskMessage(TASK)]);
  assert.equal(readState(dir).job!.taskPending, undefined);
  assert.ok(logs.includes(`#7: sent the agent its task (${taskMessage(TASK).length} characters)`));
});

test('codex: the same, once its composer is up', async () => {
  const { ctx, dir, sent, argv } = await held({ harness: 'codex', model: 'gpt-5' }, [CODEX_READY]);
  await startAgent(ctx, dir);
  assert.equal(argv[0]![0], 'codex');
  assert.equal(argv[0]!.at(-1), 'sandbox_workspace_write.network_access=true');
  assert.deepEqual(sent, [taskMessage(TASK)]);
});

test('a resume ends its argv with its instruction and pastes nothing', async () => {
  const { ctx, dir, sent, argv } = await held({ status: 'paused', starts: 1, sessionId: 's-1', pauseReason: 'operator' });
  await startAgent(ctx, dir);
  assert.deepEqual(argv[0]!.slice(1, 3), ['--resume', 's-1']);
  assert.equal(argv[0]!.at(-1), RESUME_INSTRUCTION);
  assert.deepEqual(sent, []);
  assert.equal(readState(dir).job!.taskPending, undefined);
});

test('a session that never got its task starts fresh instead of resuming, told the work was interrupted', async () => {
  const { ctx, dir, sent, argv } = await held({ status: 'paused', starts: 1, sessionId: 's-1', pauseReason: 'operator', taskPending: true });
  await startAgent(ctx, dir);
  assert.equal(argv[0]![1], '--session-id');
  assert.notEqual(argv[0]![2], 's-1');
  assert.deepEqual(sent, [taskMessage(TASK, { hasRepo: false })]);
});

test('an agent showing a dialog is not sent its task; a later look (as a tick does) sends it once the box is up', async () => {
  const screens = [TRUST];
  const { ctx, dir, sent, logs } = await held({}, screens);
  ctx.agentReadyMs = 300;
  await startAgent(ctx, dir);
  assert.deepEqual(sent, []);
  assert.equal(readState(dir).job!.taskPending, true);
  assert.ok(logs.includes("#7: the agent's screen is not ready for its task after 0.3 s; air sends it once it is"));
  assert.equal(await sendTask(ctx, dir, 0), false, 'still the dialog');
  // The box has just been drawn and is still changing on the tick's second look: not yet.
  const looks = [CLAUDE_READY, CLAUDE_READY.replace('auto mode on', 'auto mode on (shift+tab to cycle)')];
  ctx.tmux.screen = async () => (looks.length > 1 ? looks.shift()! : looks[0]!);
  assert.equal(await sendTask(ctx, dir, 0), false, 'a ready screen that is still changing');
  assert.deepEqual(sent, []);
  // The next tick sees it the same twice.
  assert.equal(await sendTask(ctx, dir, 0), true);
  assert.deepEqual(sent, [taskMessage(TASK)]);
  assert.equal(await sendTask(ctx, dir, 0), false, 'sent once');
  assert.equal(sent.length, 1);
});

test('the task stays pending when the paste fails, and is not sent to a job that was stopped or moved meanwhile', async () => {
  const { ctx, dir, sent } = await held({ status: 'running', starts: 1, taskPending: true, paneNonce: 'n0' });
  ctx.tmux.send = async () => false;
  assert.equal(await sendTask(ctx, dir, 0), false);
  assert.equal(readState(dir).job!.taskPending, true);
  ctx.tmux.send = async (_n, text) => { sent.push(text); return true; };
  const screen = ctx.tmux.screen;
  ctx.tmux.screen = async (n) => {
    updateState(dir, { job: { ...readState(dir).job!, paneNonce: 'other' } }, new Date());
    return screen(n);
  };
  assert.equal(await sendTask(ctx, dir, 0), false);
  assert.deepEqual(sent, []);
  assert.equal(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).job.taskPending, true);
});
