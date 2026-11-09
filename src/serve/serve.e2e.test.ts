// End to end: the serve loop against an in-memory GitHub (behind the real gh argv layer), fake usage
// readings, a real tmux on a throwaway socket and a fake agent script in place of claude.
import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createTrust, markedComments } from '../claim/trust.ts';
import { main } from '../cli/main.ts';
import { jobDeps } from '../cli/jobs.ts';
import type { Config } from '../config.ts';
import { fakeGitHub, type FakeGitHub } from '../gh/fake.ts';
import { createGh } from '../gh/gh.ts';
import { requestsRepo } from '../gh/issues.ts';
import { currentClaim, formatMarker } from '../spec/markers.ts';
import { createTmux, socketPath } from '../tmux/tmux.ts';
import type { Subscription } from '../usage/types.ts';
import { insteadOf, makeBareRepo, type BareRepo } from '../workspace/git-fixture.ts';
import { allWorkspaces, readState, updateState } from '../workspace/state.ts';
import { claim } from '../claim/claim.ts';
import { extractZip } from '../workspace/zip.ts';
import type { ServeContext } from './context.ts';
import { COMMENT_LIMIT, TRUNCATED_LINE } from './deliver.ts';
import { fakeGh, type FakeGh } from './fake-gh.ts';
import { serveGitHub } from './github.ts';
import { PAUSE_LIMIT_MS } from './jobs.ts';
import { createServer, type Server } from './server.ts';

const hasTmux = spawnSync('tmux', ['-V']).status === 0;
const socket = `air-serve-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const FAKE_AGENT = fileURLToPath(new URL('./fixtures/fake-agent.ts', import.meta.url));
const TARGET = 'https://github.com/o/target';

function killTmux() {
  spawnSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' });
  rmSync(socketPath(socket), { force: true });
}
if (hasTmux) process.on('exit', killTmux);

const dirs: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};

function body(mode: string, fm: string[] = ['deliver: comment'], extra = ''): string {
  return `---\nair: 0\neffort: XS\n${fm.join('\n')}\n---\n\n## Task\n\nFAKE: ${mode}\n\n## Done when\n\n- it is done\n${extra}`;
}
const PR = ['deliver: pr', 'repos:', `  - url: ${TARGET}`, '    ref: main'];
const CONTEXT = '\n## Context\n\nThe repo.\n';

function weekly(usedPct: number, resetsAt = new Date(Date.now() + 3 * 86_400_000).toISOString()): Subscription {
  return { name: 'max', harness: 'claude', readAt: new Date().toISOString(), stale: false, windows: [{ name: 'seven_day', kind: 'weekly', usedPct, resetsAt }] };
}

interface World {
  store: FakeGitHub;
  fg: FakeGh;
  ctx: ServeContext;
  server: Server;
  subs: Subscription[];
  logs: string[];
  clock: { offset: number };
  root: string;
}

let bare: BareRepo;
const tmuxClient = createTmux({ socket });

function world(o: { manual?: boolean; timeoutMs?: number } = {}): World {
  const store = fakeGitHub();
  const fg = fakeGh(store);
  const gh = createGh(fg.run, { timeoutMs: o.timeoutMs ?? 5000 });
  const repo = requestsRepo('o/requests', gh);
  const root = tmp('air-serve-root-');
  const subs = [weekly(10)];
  const logs: string[] = [];
  const clock = { offset: 0 };
  const config: Config = {
    repo: 'o/requests', workspace_root: root, max_jobs: 2, tick_seconds: 60, subscriptions: { max: { harness: 'claude', scale: 1, reserve: 0 } },
    models: { claude: { small: 'haiku', medium: 'sonnet', large: 'opus' } },
    agents: { claude: { command: [process.execPath, FAKE_AGENT], args: ['--permission-mode', 'acceptEdits'] } },
  };
  const ctx: ServeContext = {
    gh: repo, api: serveGitHub('o/requests', gh), tmux: tmuxClient, config, root, host: 'box', ghHost: 'github.com',
    env: insteadOf(bare.bare, TARGET), stateDir: tmp('air-serve-state-'), trust: createTrust(repo),
    usage: async () => structuredClone(subs), agentEnv: () => ({}), log: (s) => logs.push(s),
    now: () => new Date(Date.now() + clock.offset), stopGraceMs: 3000, resumeCheckMs: 400, claimWaitMs: 0,
  };
  return { store, fg, ctx, server: createServer(ctx, { manual: o.manual }), subs, logs, clock, root };
}

/** Ticks (waiting for each tick's work) until `check` holds. */
async function until(w: World, what: string, check: () => boolean, ms = 20_000, server = w.server): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    await server.tick();
    await server.idle();
    if (check()) return;
    if (Date.now() > end) {
      const panes = await Promise.all((await tmuxClient.listJobs()).map(async (j) => `#${j.issue} dead=${j.dead}:\n${await tmuxClient.capture(j.issue)}`));
      const argvs = allWorkspaces(w.root, "o/requests").map((x) => { try { return readFileSync(join(x.dir, "agent-argv.log"), "utf8"); } catch { return "-"; } });
      throw new Error(`timed out waiting for ${what}\nargv: ${argvs.join("\n")}\nlog:\n${w.logs.join('\n')}\npanes:\n${panes.join('\n')}`);
    }
    await sleep(100);
  }
}

const job = (w: World, n: number) => allWorkspaces(w.root, 'o/requests').filter((x) => x.state.issue === n).at(-1);
const status = (w: World, n: number) => job(w, n)?.state.job?.status;
const stateLabels = (w: World, n: number) => w.store.issues.get(n)!.labels.filter((l) => l.startsWith('air:')).sort();
const comments = (w: World, n: number) => w.store.issues.get(n)!.comments.map((c) => c.body);
const argvLog = (dir: string) => {
  try {
    return readFileSync(join(dir, 'agent-argv.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[]);
  } catch {
    return [];
  }
};
/** Ticks until #n is running and its agent has started `starts` times (so an interrupt reaches a live agent). */
const running = (w: World, n: number, starts = 1) =>
  until(w, `#${n} running`, () => status(w, n) === 'running' && argvLog(job(w, n)!.dir).length >= starts && readFileSync(join(job(w, n)!.dir, 'agent-argv.log'), 'utf8').endsWith('\n'));
const holder = async (w: World, n: number) => currentClaim(await markedComments(await w.store.comments(n), createTrust(w.store)));

describe('air serve end to end', { skip: hasTmux ? false : 'tmux not installed' }, () => {
  before(() => {
    bare = makeBareRepo(tmp('air-serve-git-'));
  });
  afterEach(async () => {
    for (const j of await tmuxClient.listJobs()) await tmuxClient.stopJob(j.issue, { graceMs: 0 });
  });
  after(() => {
    killTmux();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  test('comment: claim, setup, run, deliver with the usage record', async () => {
    const w = world();
    w.store.addIssue({ number: 1, body: body('comment hello') });
    await until(w, 'running', () => status(w, 1) === 'running' || status(w, 1) === 'done');
    await until(w, 'delivered', () => status(w, 1) === 'done');
    const ws = job(w, 1)!;
    assert.equal(ws.state.phase, 'done');
    assert.deepEqual(stateLabels(w, 1), ['air:done']);
    assert.deepEqual(w.store.issues.get(1)!.assignees, []);
    const final = comments(w, 1).at(-1)!;
    assert.match(final, /^hello\n\n<sub>air on `box`: subscription `max`, claude `sonnet`/);
    assert.match(final, /Usage: 10% before, 10% after: 0 points; effort XS expects 1/);
    assert.match(final, /<!-- air-usage \{"issue":"o\/requests#1","effort":"XS","expected":1,"delta":0,"share":0\} -->/);
    const [argv] = argvLog(ws.dir);
    assert.equal(argv![0], '--session-id');
    assert.equal(argv![1], ws.state.job!.sessionId);
    assert.deepEqual(argv!.slice(2), ['--model', 'sonnet', '--permission-mode', 'acceptEdits', 'Read AIR_TASK.md in this directory and do the task it describes.']);
    assert.equal(await tmuxClient.isAlive(1), false);
    assert.match(readFileSync(join(ws.dir, 'AIR_TASK.md'), 'utf8'), /create the empty file `AIR_DONE`/);
    // Labels moved claimed -> running -> done, each added before the previous one was removed.
    const order = w.store.log.filter((l) => /^(addLabels|removeLabel) 1 /.test(l));
    assert.deepEqual(order, ['addLabels 1 air:claimed', 'addLabels 1 air:running', 'removeLabel 1 air:claimed', 'addLabels 1 air:done', 'removeLabel 1 air:running']);
  });

  test('comment: an over-long report is truncated and the full text uploaded', async () => {
    const w = world();
    w.store.addIssue({ number: 2, body: body('big 70000') });
    await until(w, 'delivered', () => status(w, 2) === 'done');
    const final = comments(w, 2).at(-1)!;
    assert.ok(final.length <= COMMENT_LIMIT, String(final.length));
    assert.ok(final.startsWith(`${TRUNCATED_LINE}\n\nxxxx`));
    const nonce = job(w, 2)!.state.nonce;
    const asset = w.fg.releases.find((r) => r.tag === 'air-artifacts')!.assets.find((a) => a.name === `air-2-${nonce}-report.md`)!;
    assert.equal(asset.data.toString(), 'x'.repeat(70000));
    assert.match(final, new RegExp(`\`\`\`air-artifact\\nurl: https://github.com/o/requests/releases/download/air-artifacts/air-2-${nonce}-report.md\\nsha256: ${createHash('sha256').update(asset.data).digest('hex')}\\nbytes: 70000\\n\`\`\``));
  });

  test('pr: pushes the next free air/<N> branch and opens the PR; no commits fails', async () => {
    const w = world();
    w.store.setPermission('o/target', 'alice', 'write');
    execFileSync('git', ['--git-dir', bare.bare, 'branch', 'air/3', 'main']);
    w.store.addIssue({ number: 3, title: 'Change it', body: body('pr', PR, CONTEXT) });
    w.store.addIssue({ number: 4, body: body('nopr', PR, CONTEXT) });
    await until(w, 'both finished', () => status(w, 3) === 'done' && status(w, 4) === 'failed');
    const head = execFileSync('git', ['--git-dir', bare.bare, 'rev-parse', 'refs/heads/air/3-2'], { encoding: 'utf8' }).trim();
    assert.equal(execFileSync('git', ['--git-dir', bare.bare, 'log', '-1', '--format=%s', head], { encoding: 'utf8' }).trim(), 'the change');
    assert.deepEqual(w.fg.pulls.map(({ repo, title, head: h, base, body: b }) => ({ repo, title, head: h, base, body: b })), [
      { repo: 'o/target', title: 'air: Change it (#3)', head: 'air/3-2', base: 'main', body: 'Closes o/requests#3\n\nAdds CHANGE.\n' },
    ]);
    assert.match(comments(w, 3).at(-1)!, /^Opened https:\/\/github.com\/o\/target\/pull\/100 from branch `air\/3-2`\./);
    assert.deepEqual(stateLabels(w, 3), ['air:done']);
    assert.deepEqual(stateLabels(w, 4), ['air:failed']);
    assert.match(comments(w, 4).at(-1)!, /No changes were produced/);
    assert.equal(await holder(w, 4), undefined, 'a failure releases the claim');
  });

  test("pr: the agent's repo config can't run code or redirect the push; a PR whose response was lost is found", async () => {
    const w = world();
    w.store.setPermission('o/target', 'alice', 'write');
    const elsewhere = makeBareRepo(tmp('air-serve-elsewhere-')).bare;
    w.fg.failNextPull = true;
    w.store.addIssue({ number: 20, title: 'Hostile', body: body(`prhostile ${elsewhere}`, PR, CONTEXT) });
    await until(w, 'delivered', () => status(w, 20) === 'done');
    const dir = job(w, 20)!.dir;
    assert.equal(existsSync(join(dir, 'hook-ran')), false);
    assert.equal(existsSync(join(dir, 'fsmonitor-ran')), false);
    assert.equal(spawnSync('git', ['--git-dir', elsewhere, 'rev-parse', '--verify', '--quiet', 'refs/heads/air/20']).status, 1, 'nothing pushed elsewhere');
    assert.equal(spawnSync('git', ['--git-dir', bare.bare, 'rev-parse', '--verify', '--quiet', 'refs/heads/air/20']).status, 0);
    assert.equal(w.fg.pulls.filter((p) => p.head === 'air/20').length, 1);
    assert.match(comments(w, 20).at(-1)!, /^Opened https:\/\/github.com\/o\/target\/pull\/\d+ from branch `air\/20`/);
  });

  test('a delivery that keeps failing fails the request after a few attempts', async () => {
    const w = world({ timeoutMs: 200 });
    w.fg.hang = (a) => a.includes('releases/tags/air-artifacts');
    w.store.addIssue({ number: 21, body: body('artifact', ['deliver: artifact']) });
    await until(w, 'failed', () => status(w, 21) === 'failed');
    assert.equal(job(w, 21)!.state.job!.deliveryAttempts, 5);
    assert.match(comments(w, 21).at(-1)!, /failed at delivery[\s\S]*Delivery failed 5 times[\s\S]*timed out/);
    assert.deepEqual(stateLabels(w, 21), ['air:failed']);
  });

  test('a setup cut off by a restart is released as failed', async () => {
    const w = world();
    w.store.addIssue({ number: 22, body: body('comment x') });
    const r = await claim({ gh: w.ctx.gh, issue: 22, root: w.root, host: 'box', waitMs: 0 });
    assert.equal(r.status, 'won');
    updateState((r as { dir: string }).dir, { phase: 'setting-up' });
    await w.server.tick();
    await w.server.idle();
    assert.equal(job(w, 22)!.state.phase, 'failed');
    assert.deepEqual(stateLabels(w, 22), ['air:failed']);
    assert.equal(await holder(w, 22), undefined);
  });

  test('artifact: zips regular files of out/ to a release asset; an empty out/ fails', async () => {
    const w = world();
    w.store.addIssue({ number: 5, body: body('artifact', ['deliver: artifact']) });
    w.store.addIssue({ number: 6, body: body('empty', ['deliver: artifact']) });
    await until(w, 'both finished', () => status(w, 5) === 'done' && status(w, 6) === 'failed');
    const nonce = job(w, 5)!.state.nonce;
    const asset = w.fg.releases[0]!.assets.find((a) => a.name === `air-5-${nonce}.zip`)!;
    assert.equal(asset.contentType, 'application/zip');
    const final = comments(w, 5).at(-1)!;
    assert.match(final, new RegExp(`url: https://github.com/o/requests/releases/download/air-artifacts/air-5-${nonce}.zip\\nsha256: ${createHash('sha256').update(asset.data).digest('hex')}\\nbytes: ${asset.data.length}\\n`));
    const d = tmp('air-serve-unzip-');
    const zip = join(d, 'a.zip');
    writeFileSync(zip, asset.data);
    await extractZip(zip, join(d, 'x'), 1 << 20);
    assert.equal(readFileSync(join(d, 'x', 'a.txt'), 'utf8'), 'alpha\n');
    assert.equal(readFileSync(join(d, 'x', 'sub', 'b.txt'), 'utf8'), 'beta\n');
    assert.equal(existsSync(join(d, 'x', 'link')), false);
    assert.match(comments(w, 6).at(-1)!, /no regular file in `out\/`/);
    assert.deepEqual(stateLabels(w, 6), ['air:failed']);
  });

  test('restart: a new server re-adopts a live job and resumes one whose window is gone', async () => {
    const w = world();
    w.store.addIssue({ number: 7, body: body('wait') });
    await running(w, 7);
    const pane = (await tmuxClient.listJobs()).find((j) => j.issue === 7)!;

    const second = createServer(w.ctx);
    await second.tick();
    await second.idle();
    assert.equal(status(w, 7), 'running');
    assert.deepEqual((await tmuxClient.listJobs()).filter((j) => j.issue === 7).map((j) => j.paneId), [pane.paneId]);
    assert.ok(w.logs.some((l) => /#7: re-adopted/.test(l)));

    killTmux(); // a reboot: every window is gone
    const third = createServer(w.ctx);
    await until(w, 'resumed', () => argvLog(job(w, 7)!.dir).length === 2, 10_000, third);
    const ws = job(w, 7)!;
    assert.equal(ws.state.job!.status, 'running');
    assert.deepEqual(argvLog(ws.dir)[1]!.slice(0, 2), ['--resume', ws.state.job!.sessionId]);
    assert.deepEqual(stateLabels(w, 7), ['air:running']);
    writeFileSync(join(ws.dir, 'go'), '');
    await until(w, 'delivered', () => status(w, 7) === 'done', 20_000, third);
    assert.equal(comments(w, 7).at(-1)!.split('\n')[0], 'resumed');
  });

  test('regression: a restart never resumes a job whose claim another server now holds', async () => {
    const w = world();
    w.store.addIssue({ number: 23, body: body('wait') });
    await running(w, 23);
    const ws = job(w, 23)!;
    killTmux(); // the window is gone, and meanwhile our claim was released and a rival claimed the issue
    await takeOver(w, 23, ws.state.nonce);
    const before = w.store.log.length;
    const restarted = createServer(w.ctx);
    await restarted.tick();
    await restarted.idle();
    assert.equal(readState(ws.dir).phase, 'lost');
    assert.equal(argvLog(ws.dir).length, 1, 'not resumed');
    assert.deepEqual(stateLabels(w, 23), ['air:claimed'], "the rival's label is untouched");
    assert.deepEqual(w.store.log.slice(before).filter((l) => /^(addLabels|removeLabel|comment|assign|unassign) /.test(l)), []);
  });

  test('regression: a paused job whose claim was lost never rewrites labels', async () => {
    for (const reason of ['quota', 'restart'] as const) {
      const w = world();
      const n = reason === 'quota' ? 24 : 25;
      w.store.addIssue({ number: n, body: body('wait') });
      await running(w, n);
      const ws = job(w, n)!;
      await stopViaCli(w, n);
      updateState(ws.dir, { job: { ...readState(ws.dir).job!, pauseReason: reason, resumeAfter: new Date(Date.now() - 1000).toISOString() } });
      w.subs[0] = weekly(5);
      await takeOver(w, n, ws.state.nonce);
      const before = w.store.log.length;
      for (let i = 0; i < 3; i++) {
        await w.server.tick();
        await w.server.idle();
      }
      assert.equal(readState(ws.dir).phase, 'lost', reason);
      assert.equal(argvLog(ws.dir).length, 1, `${reason}: not restarted`);
      assert.deepEqual(stateLabels(w, n), ['air:claimed'], reason);
      assert.deepEqual(w.store.log.slice(before).filter((l) => /^(addLabels|removeLabel|comment|assign|unassign) /.test(l)), [], reason);
    }
  });

  test('regression: air run refuses a set-up job whose claim was lost', async () => {
    const w = world({ manual: true });
    jobDeps.loadConfig = () => w.ctx.config;
    jobDeps.context = () => w.ctx;
    let err = '';
    w.store.addIssue({ number: 26, body: body('comment x') });
    await until(w, 'set up', () => status(w, 26) === 'ready' && job(w, 26)!.state.phase === 'ready');
    await takeOver(w, 26, job(w, 26)!.state.nonce);
    assert.equal(await main(['run', '26'], { out: () => {}, err: (s) => { err += s; } }), 1);
    assert.match(err, /no longer held by this machine's claim/);
    assert.equal(argvLog(job(w, 26)!.dir).length, 0);
    assert.deepEqual(stateLabels(w, 26), ['air:claimed']);
  });

  test('regression: a comment that fails after the upload reuses the asset on retry', async () => {
    const w = world();
    w.store.addIssue({ number: 27, body: body('artifact', ['deliver: artifact']) });
    w.fg.failOnce = (a) => a.startsWith('api repos/o/requests/issues/27/comments --method POST') && w.fg.releases.some((r) => r.assets.length > 0);
    await until(w, 'delivered', () => status(w, 27) === 'done');
    assert.equal(w.fg.failOnce, undefined, 'the comment did fail once');
    const nonce = job(w, 27)!.state.nonce;
    assert.equal(w.fg.calls.filter((c) => c.includes(`assets?name=air-27-${nonce}.zip`)).length, 1, 'uploaded once');
    assert.equal(w.fg.calls.filter((c) => /releases\/assets\/\d+ --method DELETE/.test(c)).length, 0, 'never deleted');
    const asset = job(w, 27)!.state.job!.delivery!.asset!;
    assert.match(comments(w, 27).at(-1)!, new RegExp(`url: ${asset.url.replace(/[.]/g, '\\.')}\nsha256: ${asset.sha256}\nbytes: ${asset.bytes}\n\`\`\``));
    assert.doesNotMatch(comments(w, 27).at(-1)!, /^expires:/m, 'no expires: the spec default (14 days after close) applies');
  });

  test('air stop / air start: pause keeps the claim; start resumes, or starts fresh when resume fails', async () => {
    const w = world();
    jobDeps.loadConfig = () => w.ctx.config;
    jobDeps.context = () => w.ctx;
    const io = { out: () => {}, err: () => {} };
    w.store.addIssue({ number: 8, body: body('wait') });
    await running(w, 8);
    const sessionId = job(w, 8)!.state.job!.sessionId;

    assert.equal(await main(['stop', '8'], io), 0);
    let ws = job(w, 8)!;
    assert.equal(ws.state.job!.status, 'paused');
    assert.equal(ws.state.job!.pauseReason, 'operator');
    assert.equal(ws.state.job!.sessionId, sessionId);
    assert.equal(ws.state.phase, 'ready');
    assert.deepEqual(stateLabels(w, 8), ['air:paused']);
    assert.equal((await tmuxClient.listJobs()).some((j) => j.issue === 8), false);
    assert.equal((await holder(w, 8))?.nonce, ws.state.nonce);
    await w.server.tick();
    await w.server.idle();
    assert.equal(status(w, 8), 'paused', 'the server leaves an operator pause alone');

    assert.equal(await main(['start', '8'], io), 0);
    await running(w, 8, 2);
    assert.deepEqual(argvLog(ws.dir)[1]!.slice(0, 2), ['--resume', sessionId]);
    assert.deepEqual(stateLabels(w, 8), ['air:running']);

    assert.equal(await main(['stop', '8'], io), 0);
    writeFileSync(join(ws.dir, 'resume-fails'), '');
    assert.equal(await main(['start', '8'], io), 0);
    await running(w, 8, 4);
    const starts = argvLog(ws.dir);
    assert.deepEqual(starts[2]!.slice(0, 2), ['--resume', sessionId]);
    assert.equal(starts[3]![0], '--session-id');
    assert.notEqual(starts[3]![1], sessionId);
    assert.match(starts[3]!.at(-1)!, /^Read AIR_TASK\.md .* interrupted: first look at what is already in out\//);
    ws = job(w, 8)!;
    assert.equal(ws.state.job!.status, 'running');
    assert.equal(ws.state.job!.sessionId, starts[3]![1]);
    writeFileSync(join(ws.dir, 'go'), '');
    await until(w, 'delivered', () => status(w, 8) === 'done');
  });

  test('quota: an exhausted subscription stops the job; it restarts after the reset', async () => {
    const w = world();
    w.store.addIssue({ number: 9, body: body('wait') });
    await running(w, 9);
    const reset = new Date(Date.now() + 60_000).toISOString();
    w.subs[0] = weekly(100, reset);
    await until(w, 'paused', () => status(w, 9) === 'paused');
    assert.equal(job(w, 9)!.state.job!.pauseReason, 'quota');
    assert.equal(job(w, 9)!.state.job!.resumeAfter, reset);
    assert.deepEqual(stateLabels(w, 9), ['air:paused']);
    w.subs[0] = weekly(2);
    await w.server.tick();
    await w.server.idle();
    assert.equal(status(w, 9), 'paused', 'not before the reset');
    w.clock.offset = 61_000;
    await until(w, 'restarted', () => status(w, 9) === 'running');
    assert.equal(argvLog(job(w, 9)!.dir)[1]![0], '--resume');
    assert.deepEqual(stateLabels(w, 9), ['air:running']);
  });

  test('cancel: air:cancel stops the agent, comments and releases', async () => {
    const w = world();
    w.store.addIssue({ number: 10, body: body('wait') });
    await running(w, 10);
    w.store.issues.get(10)!.labels.push('air:cancel');
    await until(w, 'cancelled', () => status(w, 10) === 'cancelled');
    assert.deepEqual(stateLabels(w, 10), ['air:cancel']);
    assert.equal(await tmuxClient.isAlive(10), false);
    assert.match(comments(w, 10).at(-1)!, /stopped work on this request because the requester added `air:cancel`, and released it/);
    assert.equal(await holder(w, 10), undefined);
    assert.deepEqual(w.store.issues.get(10)!.assignees, []);
  });

  test('a job paused for 48 hours is released; a timeout fails the job', async () => {
    const w = world();
    w.store.addIssue({ number: 11, body: body('wait') });
    w.store.addIssue({ number: 12, body: body('hang', ['deliver: comment', 'timeout: 1m']) });
    await running(w, 11);
    await running(w, 12);
    await stopViaCli(w, 11);
    w.clock.offset = PAUSE_LIMIT_MS + 60_000;
    const first = job(w, 11)!.dir;
    // Once released, #11 is free again, and this server may claim it anew.
    await until(w, 'both over', () => readState(first).job!.status === 'cancelled' && status(w, 12) === 'failed');
    assert.ok(w.store.issues.get(11)!.comments.some((c) => /paused this request 48 hours ago/.test(c.body)));
    assert.notEqual((await holder(w, 11))?.nonce, readState(first).nonce);
    assert.deepEqual(stateLabels(w, 12), ['air:failed']);
    assert.match(comments(w, 12).at(-1)!, /failed at the timeout[\s\S]*past the request's `timeout` of 1 min/);
  });

  test('an agent that exits non-zero fails the request with the end of its window', async () => {
    const w = world();
    w.store.addIssue({ number: 13, body: body('exit 4') });
    await until(w, 'failed', () => status(w, 13) === 'failed');
    assert.match(comments(w, 13).at(-1)!, /The agent exited with status 4[\s\S]*fake agent: exit 4/);
  });

  test('a hanging gh call times out; the loop logs it and carries on', async () => {
    const w = world({ timeoutMs: 300 });
    w.store.addIssue({ number: 14, body: body('comment hi') });
    w.fg.hang = (a) => a.includes('issues?state=open');
    const t0 = Date.now();
    await w.server.tick();
    assert.ok(Date.now() - t0 < 3000);
    assert.ok(w.logs.some((l) => /tick failed: gh api repos\/o\/requests\/issues\?state=open.* timed out/.test(l)), w.logs.join('\n'));
    assert.equal(job(w, 14), undefined);
    w.fg.hang = undefined;
    await until(w, 'delivered', () => status(w, 14) === 'done');
  });

  test('--manual waits for air run; air pause stops claiming', async () => {
    const w = world({ manual: true });
    jobDeps.loadConfig = () => w.ctx.config;
    jobDeps.context = () => w.ctx;
    jobDeps.stateDir = () => w.ctx.stateDir;
    const io = { out: () => {}, err: () => {} };
    w.store.addIssue({ number: 15, body: body('comment manual') });
    await until(w, 'set up', () => status(w, 15) === 'ready' && job(w, 15)!.state.phase === 'ready');
    await w.server.tick();
    assert.equal(status(w, 15), 'ready');
    assert.deepEqual(stateLabels(w, 15), ['air:claimed']);
    assert.equal(await main(['run', '15'], io), 0);
    await until(w, 'delivered', () => status(w, 15) === 'done');

    assert.equal(await main(['pause'], io), 0);
    w.store.addIssue({ number: 16, body: body('comment later') });
    await w.server.tick();
    await w.server.idle();
    assert.equal(job(w, 16), undefined);
    assert.equal(await main(['resume'], io), 0);
    await until(w, 'claimed', () => job(w, 16) !== undefined);
  });

  test('invalid and unsupported requests get one comment each and are never claimed', async () => {
    const w = world();
    w.store.addIssue({ number: 17, body: '---\nair: 0\neffort: huge\ndeliver: comment\n---\n## Task\n\nx\n\n## Done when\n\n- y\n' });
    w.store.addIssue({ number: 18, body: body('comment x').replace('air: 0', 'air: 9') });
    w.store.addIssue({ number: 19, body: body('comment x'), author: 'mallory', authorAssociation: 'NONE' });
    for (let i = 0; i < 3; i++) {
      await w.server.tick();
      await w.server.idle();
    }
    assert.equal(comments(w, 17).length, 1);
    assert.match(comments(w, 17)[0]!, /can't act on this request/);
    assert.equal(comments(w, 18).length, 1);
    assert.match(comments(w, 18)[0]!, /air-unsupported v0 host=box air=9/);
    assert.equal(comments(w, 19).length, 0);
    assert.equal(allWorkspaces(w.root, 'o/requests').length, 0);
  });

  test('regression: an agent that exits right after AIR_DONE, closing its window, is delivered, not paused', async () => {
    const w = world();
    w.store.addIssue({ number: 40, body: body('exitdone') });
    await running(w, 40);
    const dir = job(w, 40)!.dir;
    // One tick sees the window already closed, and AIR_DONE appears (the agent writes it and exits) only after
    // that tick checked for it: the order of the live Mac run.
    let step = 0;
    w.ctx.tmux = {
      ...tmuxClient,
      listJobs: async () => {
        if (step === 1) {
          step = 2;
          return (await tmuxClient.listJobs()).filter((j) => j.issue !== 40);
        }
        if (step === 2) {
          step = 0;
          writeFileSync(join(dir, 'go'), '');
          await waitFor(async () => existsSync(join(dir, 'AIR_DONE')) && !!(await tmuxClient.listJobs()).find((j) => j.issue === 40)?.dead);
          await tmuxClient.stopJob(40, { graceMs: 0 });
        }
        return tmuxClient.listJobs();
      },
    };
    step = 1;
    await w.server.tick();
    await w.server.idle();
    assert.equal(step, 0, 'the tick looked for the window twice');
    assert.equal(status(w, 40), 'done', w.logs.join('\n'));
    assert.ok(w.logs.some((l) => /#40: its window is gone and AIR_DONE is there; delivering/.test(l)));
    assert.ok(!w.logs.some((l) => /#40: its window was closed; paused/.test(l)));
    assert.deepEqual(stateLabels(w, 40), ['air:done']);
    assert.equal(comments(w, 40).at(-1)!.split('\n')[0], 'finished');
  });

  test('regression: air start delivers a paused job whose agent already created AIR_DONE', async () => {
    const w = world();
    jobDeps.loadConfig = () => w.ctx.config;
    jobDeps.context = () => w.ctx;
    let out = '';
    const io = { out: (s: string) => { out += s; }, err: () => {} };
    w.store.addIssue({ number: 41, body: body('exitdone') });
    await running(w, 41);
    const dir = job(w, 41)!.dir;
    writeFileSync(join(dir, 'go'), '');
    await waitFor(async () => existsSync(join(dir, 'AIR_DONE')) && !!(await tmuxClient.listJobs()).find((j) => j.issue === 41)?.dead);
    // The state the closed-window bug left behind: paused by "the operator", window gone, AIR_DONE and the report there.
    await tmuxClient.stopJob(41, { graceMs: 0 });
    const j = readState(dir).job!;
    updateState(dir, { job: { ...j, status: 'paused', startedAt: undefined, pausedAt: new Date().toISOString(), pauseReason: 'operator' } }, new Date());
    const i = w.store.issues.get(41)!;
    i.labels = [...i.labels.filter((l) => !l.startsWith('air:')), 'air:paused'];
    assert.ok(existsSync(join(dir, 'out', 'REPORT.md')));
    assert.equal((await holder(w, 41))?.nonce, readState(dir).nonce);

    assert.equal(await main(['start', '41'], io), 0);
    assert.match(out, /#41 had already finished \(AIR_DONE\); delivered it/);
    assert.equal(status(w, 41), 'done');
    assert.equal(job(w, 41)!.state.phase, 'done');
    assert.deepEqual(stateLabels(w, 41), ['air:done']);
    assert.equal(comments(w, 41).at(-1)!.split('\n')[0], 'finished');
    assert.equal(argvLog(dir).length, 1, 'the agent was not started again');
    assert.equal((await tmuxClient.listJobs()).some((x) => x.issue === 41), false);
  });

  test('regression: air run delivers a set-up job whose AIR_DONE already exists', async () => {
    const w = world({ manual: true });
    jobDeps.loadConfig = () => w.ctx.config;
    jobDeps.context = () => w.ctx;
    let out = '';
    const io = { out: (s: string) => { out += s; }, err: () => {} };
    w.store.addIssue({ number: 42, body: body('exitdone') });
    await until(w, 'set up', () => status(w, 42) === 'ready' && job(w, 42)!.state.phase === 'ready');
    const dir = job(w, 42)!.dir;
    writeFileSync(join(dir, 'out', 'REPORT.md'), 'by hand');
    writeFileSync(join(dir, 'AIR_DONE'), '');
    assert.equal(await main(['run', '42'], io), 0);
    assert.match(out, /#42 had already finished \(AIR_DONE\); delivered it/);
    assert.equal(status(w, 42), 'done');
    assert.equal(comments(w, 42).at(-1)!.split('\n')[0], 'by hand');
    assert.equal(argvLog(dir).length, 0, 'no agent was started');
  });

  test('regression: one tick that cannot see a live window never pauses the job; two in a row do', async () => {
    const w = world();
    w.store.addIssue({ number: 44, body: body('hang') });
    await running(w, 44);
    let hide = false;
    w.ctx.tmux = { ...tmuxClient, listJobs: async () => (await tmuxClient.listJobs()).filter((j) => !hide || j.issue !== 44) };
    const tick = async () => {
      await w.server.tick();
      await w.server.idle();
    };
    hide = true;
    await tick();
    assert.equal(status(w, 44), 'running', w.logs.join('\n'));
    assert.ok(w.logs.some((l) => /#44: its window \(pane \w+\) was not found; checking again next tick/.test(l)));
    hide = false;
    await tick(); // seen again: the miss is forgotten
    hide = true;
    await tick();
    assert.equal(status(w, 44), 'running', 'misses must be consecutive');
    await tick();
    assert.equal(status(w, 44), 'paused');
    assert.ok(w.logs.some((l) => /#44: its window was closed; paused/.test(l)));
    assert.deepEqual(stateLabels(w, 44), ['air:paused']);
  });

  test('a running job with no recorded pane adopts its window; air debug panes shows both sides', async () => {
    const w = world();
    jobDeps.loadConfig = () => w.ctx.config;
    jobDeps.context = () => w.ctx;
    w.store.addIssue({ number: 45, body: body('hang') });
    await running(w, 45);
    const dir = job(w, 45)!.dir;
    const pane = (await tmuxClient.listJobs()).find((j) => j.issue === 45)!;
    const { paneNonce: _, ...rest } = readState(dir).job!;
    updateState(dir, { job: rest }, new Date()); // as the locale bug left it: no nonce read back at start

    let out = '';
    assert.equal(await main(['debug', 'panes'], { out: (s) => { out += s; }, err: () => {} }), 0);
    assert.match(out, /^tmux: tmux \d/m);
    assert.match(out, new RegExp(`^  "45\\\\t${pane.nonce}\\\\t${pane.windowId}\\\\t`, 'm'));
    assert.match(out, new RegExp(`^  #45 nonce ${pane.nonce} window ${pane.windowId} pane ${pane.paneId} agent pid ${pane.pid} \\(group ${pane.panePid}\\) alive$`, 'm'));
    assert.match(out, /^  #45 ready\/running paneNonce \(none\): NO MATCHING PANE/m);

    await w.server.tick();
    await w.server.idle();
    assert.equal(status(w, 45), 'running');
    assert.equal(readState(dir).job!.paneNonce, pane.nonce);
    assert.ok(w.logs.some((l) => new RegExp(`#45: adopted its window ${pane.windowId}`).test(l)));
    out = '';
    await main(['debug', 'panes'], { out: (s) => { out += s; }, err: () => {} });
    assert.match(out, new RegExp(`^  #45 ready/running paneNonce ${pane.nonce}: window ${pane.windowId}`, 'm'));
  });

  test('air serve, run and start refuse a tmux older than 3.0', async () => {
    const w = world();
    jobDeps.loadConfig = () => w.ctx.config;
    jobDeps.context = () => w.ctx;
    w.ctx.tmux = createTmux({ socket, run: async (a) => (a[0] === '-V' ? { code: 0, stdout: 'tmux 2.9a\n', stderr: '' } : { code: 1, stdout: '', stderr: 'unexpected' }) });
    for (const argv of [['serve', '--once'], ['run', '1'], ['start', '1']]) {
      let err = '';
      assert.equal(await main(argv, { out: () => {}, err: (s) => { err += s; } }), 1, argv.join(' '));
      assert.match(err, /^air: tmux 2\.9a is too old: air needs tmux 3\.0 or newer/, argv.join(' '));
    }
    assert.deepEqual(w.store.log, [], 'nothing touched GitHub');
  });

  test('--once polls again when the issue list is still empty, then exits', async () => {
    const w = world();
    // GitHub's list lags a request filed seconds ago: it shows up only after the first poll.
    const late = setTimeout(() => w.store.addIssue({ number: 43, body: body('comment late') }), 500);
    try {
      await w.server.run({ once: true, onceWaitMs: 15_000, oncePollMs: 200, watchMs: 100 });
    } finally {
      clearTimeout(late);
    }
    assert.equal(status(w, 43), 'done', w.logs.join('\n'));
    assert.ok(w.logs.some((l) => /^--once: no open requests to claim yet; polling again in 0\.2 s/.test(l)), w.logs.join('\n'));

    const idle = world();
    const t0 = Date.now();
    await idle.server.run({ once: true, onceWaitMs: 600, oncePollMs: 200 });
    assert.ok(Date.now() - t0 >= 600);
    assert.ok(idle.logs.filter((l) => /^--once: no open requests to claim yet/.test(l)).length >= 2, idle.logs.join('\n'));
    assert.match(idle.logs.at(-1)!, /^--once: no open requests to claim after waiting 0\.6 s; exiting$/);
  });
});

/** Our claim on #n is released and a rival server claims the issue and labels it, as another server would. */
async function takeOver(w: World, n: number, nonce: string) {
  w.store.post(n, 'bot', 'OWNER', formatMarker({ kind: 'release', version: 0, host: 'box', nonce }));
  w.store.post(n, 'rival', 'OWNER', formatMarker({ kind: 'claim', version: 0, host: 'rival-box', nonce: 'rivalnonce1234' }));
  const i = w.store.issues.get(n)!;
  i.labels = [...i.labels.filter((l) => !l.startsWith('air:')), 'air:claimed'];
  i.assignees = ['rival'];
  assert.equal((await holder(w, n))?.host, 'rival-box');
}

async function waitFor(check: () => Promise<boolean>, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out');
    await sleep(50);
  }
}

async function stopViaCli(w: World, n: number) {
  jobDeps.loadConfig = () => w.ctx.config;
  jobDeps.context = () => w.ctx;
  assert.equal(await main(['stop', String(n)], { out: () => {}, err: () => {} }), 0);
  assert.equal(readState(job(w, n)!.dir).job!.status, 'paused');
}
