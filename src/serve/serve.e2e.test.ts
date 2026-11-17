// End to end: the serve loop against an in-memory GitHub (behind the real gh argv layer), fake usage
// readings, a real tmux on a throwaway socket and a fake agent script in place of claude.
import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createTrust, markedComments } from '../claim/trust.ts';
import { main } from '../cli/main.ts';
import { jobDeps } from '../cli/jobs.ts';
import { deps as requestDeps } from '../cli/requests.ts';
import type { Config } from '../config.ts';
import { fakeGitHub, type FakeGitHub } from '../gh/fake.ts';
import { createGh, GhError } from '../gh/gh.ts';
import { releaseDownload } from '../workspace/context.ts';
import { requestsRepo } from '../gh/issues.ts';
import { currentClaim, formatMarker, parseResult } from '../spec/markers.ts';
import { createTmux, socketPath } from '../tmux/tmux.ts';
import { ledgerFile, loadLedger } from '../usage/index.ts';
import type { ManualConfig, Subscription } from '../usage/types.ts';
import { insteadOfAll, makeBareRepo, type BareRepo } from '../workspace/git-fixture.ts';
import { allWorkspaces, readState, updateState } from '../workspace/state.ts';
import { CANCEL_LABEL, claim, LABELS, STATE_LABELS } from '../claim/claim.ts';
import { extractZip } from '../workspace/zip.ts';
import type { ServeContext } from './context.ts';
import { COMMENT_LIMIT, TRUNCATED_LINE } from './deliver.ts';
import { fakeGh, type FakeGh } from './fake-gh.ts';
import { serveGitHub } from './github.ts';
import { PAUSE_LIMIT_MS } from './jobs.ts';
import { MAX_WAITING_COMMENTS, SETTLE_MS, STUCK_MS } from './prompts.ts';
import { CLAIM_RETRY_MS, createServer, ONCE_POLL_TRIES, type Server } from './server.ts';

const hasTmux = spawnSync('tmux', ['-V']).status === 0;
const socket = `air-serve-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const FAKE_AGENT = fileURLToPath(new URL('./fixtures/fake-agent.ts', import.meta.url));
const TARGET = 'https://github.com/o/target';
const SERVICE = 'https://github.com/o/service';
const GUIDE = 'https://github.com/o/guide';

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

let bare: BareRepo, service: BareRepo, guide: BareRepo;
const tmuxClient = createTmux({ repo: 'o/requests', socket });

function world(o: { manual?: boolean; timeoutMs?: number; budget?: ManualConfig['budget']; transcripts?: boolean } = {}): World {
  const store = fakeGitHub();
  // This server's account can push to the repos requests deliver to; each test grants the requester's access.
  for (const r of ['o/target', 'o/service', 'o/guide']) store.setPermission(r, 'bot', 'write');
  const fg = fakeGh(store);
  const gh = createGh(fg.run, { timeoutMs: o.timeoutMs ?? 5000 });
  const repo = requestsRepo('o/requests', gh);
  const root = tmp('air-serve-root-');
  const subs = [weekly(10)];
  const logs: string[] = [];
  const clock = { offset: 0 };
  const config: Config = {
    repo: 'o/requests', workspace_root: root, max_jobs: 2, tick_seconds: 60, subscriptions: { max: { harness: 'claude', window_usd: 1000, reserve: 0 } },
    models: { claude: { small: 'haiku', medium: 'sonnet', large: 'opus' } },
    agents: { claude: { command: [process.execPath, FAKE_AGENT], args: ['--permission-mode', 'acceptEdits'] } },
  };
  const ctx: ServeContext = {
    gh: repo, api: serveGitHub('o/requests', gh), tmux: tmuxClient, config, root, host: 'box', ghHost: 'github.com',
    env: insteadOfAll([[bare.bare, TARGET], [service.bare, SERVICE], [guide.bare, GUIDE]]), stateDir: tmp('air-serve-state-'), trust: createTrust(repo),
    usage: async () => structuredClone(subs), agentEnv: () => ({}), log: (s) => logs.push(s),
    now: () => new Date(Date.now() + clock.offset), stopGraceMs: 3000, resumeCheckMs: 400, claimWaitMs: 0,
    download: releaseDownload(gh, 'github.com'),
  };
  if (o.budget || o.transcripts) {
    // The fake agent leaves Claude Code transcripts in a config dir of its own; with `budget`, `max` is a manual budget.
    const claudeDir = tmp('air-serve-claude-');
    if (o.budget) ctx.manual = (name) => (name === 'max' ? { name, harness: 'manual', reset: { every: 'weekly', day: 0 }, budget: o.budget! } : undefined);
    ctx.agentEnv = () => ({ CLAUDE_CONFIG_DIR: claudeDir, FAKE_TRANSCRIPT: '1' });
  }
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
/** The `air-result` of #n's last comment (or the last one matching `which`), without host and nonce. */
const resultOf = (w: World, n: number, which: (c: string) => boolean = () => true) => {
  const r = parseResult(comments(w, n).filter(which).at(-1) ?? '');
  if (!r?.ok) return undefined;
  const { host: _h, nonce: _n, prs, ...rest } = r.result;
  return prs.length ? { ...rest, prs } : rest;
};
/** The `prs` of #n's last `air-result`. */
const prsOf = (w: World, n: number) => {
  const r = parseResult(comments(w, n).at(-1) ?? '');
  return r?.ok ? r.result.prs : undefined;
};
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');
async function unzip(data: Buffer): Promise<string> {
  const d = tmp('air-serve-unzip-');
  writeFileSync(join(d, 'a.zip'), data);
  await extractZip(join(d, 'a.zip'), join(d, 'x'), 1 << 20);
  return join(d, 'x');
}
/** Appends an API call on `model` to the transcript of #n's Claude Code session. */
function addCall(w: World, n: number, model: string, usage: object): void {
  const id = job(w, n)!.state.job!.sessionId!;
  const projects = join(w.ctx.agentEnv('max').CLAUDE_CONFIG_DIR!, 'projects');
  const file = readdirSync(projects).map((d) => join(projects, d, `${id}.jsonl`)).find((f) => existsSync(f))!;
  appendFileSync(file, `${JSON.stringify({ type: 'assistant', message: { id: `msg_${Math.random()}`, model, usage } })}\n`);
}
const holder = async (w: World, n: number) => currentClaim(await markedComments(await w.store.comments(n), createTrust(w.store)));

describe('air serve end to end', { skip: hasTmux ? false : 'tmux not installed' }, () => {
  before(() => {
    bare = makeBareRepo(tmp('air-serve-git-'));
    service = makeBareRepo(tmp('air-serve-service-'));
    guide = makeBareRepo(tmp('air-serve-guide-'));
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
    assert.match(final, /Cost at API prices: unknown, the agent left no usage record; effort XS expects \$1\.00\./);
    assert.match(final, /Usage of `max`'s window: 10% before, 10% after\./);
    assert.match(final, /<!-- air-usage \{"issue":"o\/requests#1","effort":"XS","expected":1,"usd":null\} -->/);
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

  test('a manual budget is charged what each job cost at API prices, from its transcripts', async () => {
    const w = world({ budget: { usd: 100 } });
    const spent = () => (loadLedger(ledgerFile(w.ctx.stateDir)).ledger?.subscriptions.max?.spent);
    const start = 0.500325 + 0.00003; // one start: a claude-sonnet-5-5 call and a claude-haiku-4-5 subagent call
    const near = (a: number | undefined, b: number) => assert.ok(a !== undefined && Math.abs(a - b) < 1e-9, `${a} != ${b}`);
    w.store.addIssue({ number: 80, body: body('comment Done.') });
    await until(w, 'delivered', () => status(w, 80) === 'done');
    near(spent(), start);
    assert.deepEqual(job(w, 80)!.state.job!.spend, { usd: start, charged: true });
    assert.match(comments(w, 80).at(-1)!, /Cost at API prices: \$0\.50; effort XS expects \$1\.00\.\nCharged \$0\.50 to manual budget `max`\./);
    assert.match(comments(w, 80).at(-1)!, /<!-- air-usage \{"issue":"o\/requests#80","effort":"XS","expected":1,"usd":0\.500355\} -->/);
    // A partial job is charged for both its starts: the fresh one and the resumed session.
    w.store.addIssue({ number: 81, body: body('quit 3') });
    await until(w, 'partial', () => status(w, 81) === 'partial');
    assert.equal(job(w, 81)!.state.job!.starts, 2);
    near(spent(), 3 * start);
    // A cancelled job too.
    w.store.addIssue({ number: 82, body: body('hang') });
    await running(w, 82);
    w.store.issues.get(82)!.labels.push('air:cancel');
    await until(w, 'cancelled', () => status(w, 82) === 'cancelled');
    near(spent(), 4 * start);
  });

  test('a server started inside a Claude Code session still gets a transcript and a cost from its Claude jobs', async () => {
    // What a Claude Code session exports to the commands it runs, `air serve` among them.
    const parent = { CLAUDECODE: '1', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_SESSION_ID: 'parent' };
    const saved = Object.fromEntries(Object.keys(parent).map((k) => [k, process.env[k]]));
    Object.assign(process.env, parent);
    try {
      const w = world({ budget: { usd: 100 } });
      w.store.addIssue({ number: 86, body: body('comment Done.') });
      await until(w, 'delivered', () => status(w, 86) === 'done');
      const projects = join(w.ctx.agentEnv('max').CLAUDE_CONFIG_DIR!, 'projects');
      assert.ok(readdirSync(projects).some((d) => existsSync(join(projects, d, `${job(w, 86)!.state.job!.sessionId}.jsonl`))), 'the session has a transcript');
      assert.deepEqual(job(w, 86)!.state.job!.spend, { usd: 0.500355, charged: true });
      assert.match(comments(w, 86).at(-1)!, /Cost at API prices: \$0\.50; effort XS expects \$1\.00\./);
    } finally {
      for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  test('a model the price table lacks is not charged, with a warning naming it', async () => {
    const w = world({ budget: { usd: 100 } });
    w.store.addIssue({ number: 84, body: body('progress') });
    await running(w, 84);
    addCall(w, 84, 'claude-future-9', { input_tokens: 1000, output_tokens: 1000 });
    w.store.issues.get(84)!.labels.push('air:cancel');
    await until(w, 'cancelled', () => status(w, 84) === 'cancelled');
    assert.deepEqual(job(w, 84)!.state.job!.spend, { usd: 0.500355, unpriced: ['claude-future-9'], charged: true });
    assert.ok(w.logs.some((l) => l === '#84: warning: no API price for claude-future-9; calls on it are not charged'), w.logs.join('\n'));
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
    assert.deepEqual(parseResult(final), {
      ok: true,
      result: {
        status: 'done', deliver: 'comment', prs: [], report: `https://github.com/o/requests/releases/download/air-artifacts/air-2-${nonce}-report.md`,
        usage: { harness: 'claude', tier: 'medium', before_pct: 10, after_pct: 10, attempts: 1 }, host: job(w, 2)!.state.host, nonce,
      },
    });
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
      { repo: 'o/target', title: 'air: Change it (#3)', head: 'air/3-2', base: 'main', body: 'Part of o/requests#3\n\nAdds CHANGE.\n' },
    ]);
    assert.match(comments(w, 3).at(-1)!, /^Opened a pull request:\n\n- `target`: https:\/\/github.com\/o\/target\/pull\/100 from branch `air\/3-2`\n\n/);
    const result = parseResult(comments(w, 3).at(-1)!);
    assert.deepEqual(result?.ok && result.result.prs, [{ repo: 'target', url: 'https://github.com/o/target/pull/100' }]);
    assert.deepEqual(stateLabels(w, 3), ['air:done']);
    assert.deepEqual(stateLabels(w, 4), ['air:failed']);
    assert.match(comments(w, 4).at(-1)!, /No changes were produced/);
    assert.equal(await holder(w, 4), undefined, 'a failure releases the claim');
  });

  test('pr: the report is the PR body; an over-long one is cut to fit and uploaded whole', async () => {
    const w = world();
    w.store.setPermission('o/target', 'alice', 'write');
    w.store.addIssue({ number: 5, title: 'Big', body: body('prbig 70000', PR, CONTEXT) });
    await until(w, 'delivered', () => status(w, 5) === 'done');
    const nonce = job(w, 5)!.state.nonce;
    const url = `https://github.com/o/requests/releases/download/air-artifacts/air-5-${nonce}-report.md`;
    const pr = w.fg.pulls.find((p) => p.title.endsWith('(#5)'))!;
    assert.ok(pr.body.length <= COMMENT_LIMIT, String(pr.body.length));
    assert.ok(pr.body.startsWith(`Part of o/requests#5\n\n**Truncated:** the full report is ${url}\n\n\`\`\`\nyyyy`));
    // the report's open fence is closed before the cut, so it can't swallow what follows
    assert.match(pr.body, /y\n```\n\n\[\.\.\. cut \.\.\.\]\n$/);
    const asset = w.fg.releases.find((r) => r.tag === 'air-artifacts')!.assets.find((a) => a.name === `air-5-${nonce}-report.md`)!;
    assert.equal(asset.data.toString(), `\`\`\`\n${'y'.repeat(70000)}`);
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
    assert.match(comments(w, 20).at(-1)!, /^Opened a pull request:\n\n- `target`: https:\/\/github.com\/o\/target\/pull\/\d+ from branch `air\/20`/);
  });

  test('two repos, one delivered and one read-only: one PR; the read-only repo is never pushed', async () => {
    const w = world();
    w.store.setPermission('o/service', 'alice', 'write');
    const fm = ['deliver: pr', 'repos:', `  - url: ${SERVICE}`, '    ref: main', `  - url: ${GUIDE}`, '    pr: 5', '    path: docs/guide', '    deliver: none'];
    w.store.addIssue({ number: 60, title: 'Two repos', body: body('pr', fm, CONTEXT) });
    await until(w, 'delivered', () => status(w, 60) === 'done');
    const ws = job(w, 60)!;
    assert.deepEqual(ws.state.repos, [{ path: 'service', sha: service.main }, { path: 'docs/guide', sha: guide.dangling }]);
    assert.match(comments(w, 60)[0]!, new RegExp(`- \`service\`: \`${service.main}\`\n- \`docs/guide\`: \`${guide.dangling}\``));
    // The agent committed in both checkouts; only the delivered one is pushed.
    const log = (dir: string) => execFileSync('git', ['-C', dir, 'log', '-1', '--format=%s'], { encoding: 'utf8' }).trim();
    assert.equal(log(join(ws.dir, 'repo', 'docs', 'guide')), 'the change');
    assert.equal(spawnSync('git', ['--git-dir', guide.bare, 'rev-parse', '--verify', '--quiet', 'refs/heads/air/60']).status, 1, 'read-only repo untouched');
    assert.equal(execFileSync('git', ['--git-dir', service.bare, 'log', '--format=%s', 'main..air/60'], { encoding: 'utf8' }), 'the change\n');
    assert.deepEqual(w.fg.pulls.filter((p) => p.title.endsWith('(#60)')).map(({ repo, head: h, base, body: b }) => ({ repo, head: h, base, body: b })), [
      { repo: 'o/service', head: 'air/60', base: 'main', body: 'Part of o/requests#60\n\nAdds CHANGE.\n' },
    ]);
    const url = w.fg.pulls.find((p) => p.head === 'air/60')!.url;
    assert.match(comments(w, 60).at(-1)!, new RegExp(`^Opened a pull request:\n\n- \`service\`: ${url} from branch \`air/60\`\n\n<sub>`));
    assert.deepEqual(prsOf(w, 60), [{ repo: 'service', url }]);
    assert.ok(!w.store.log.some((l) => l.startsWith('permission o/guide')), 'no permission check for a read-only repo');
  });

  test('two delivered repos: a PR each, linked to the issue and to each other; an unchanged repo gets none', async () => {
    const w = world();
    for (const r of ['o/service', 'o/target']) w.store.setPermission(r, 'alice', 'write');
    const fm = ['deliver: pr', 'repos:', `  - url: ${SERVICE}`, '    ref: main', `  - url: ${TARGET}`, '    ref: feature', '    path: libs/target'];
    w.store.addIssue({ number: 61, title: 'Both', body: body('pr', fm, CONTEXT) });
    w.store.addIssue({ number: 62, title: 'One', body: body('pr service', fm, CONTEXT) });
    await until(w, 'delivered', () => status(w, 61) === 'done' && status(w, 62) === 'done');
    const pulls = (n: number) => w.fg.pulls.filter((p) => p.title.endsWith(`(#${n})`));
    const [a, b] = pulls(61);
    assert.deepEqual([a!.repo, a!.base, b!.repo, b!.base], ['o/service', 'main', 'o/target', 'feature']);
    assert.equal(a!.body, `Part of o/requests#61\n\nAdds CHANGE.\n\n\nThe other pull requests for this request:\n\n- ${b!.url}\n`);
    assert.equal(b!.body, `Part of o/requests#61\n\nAdds CHANGE.\n\n\nThe other pull requests for this request:\n\n- ${a!.url}\n`);
    assert.equal(execFileSync('git', ['--git-dir', bare.bare, 'log', '--format=%s', 'feature..air/61'], { encoding: 'utf8' }), 'the change\n');
    assert.match(comments(w, 61).at(-1)!, new RegExp(`^Opened 2 pull requests:\n\n- \`service\`: ${a!.url} from branch \`air/61\`\n- \`libs/target\`: ${b!.url} from branch \`air/61\`\n\n<sub>`));
    assert.deepEqual(prsOf(w, 61), [{ repo: 'service', url: a!.url }, { repo: 'libs/target', url: b!.url }]);

    assert.deepEqual(pulls(62).map((p) => [p.repo, p.body]), [['o/service', 'Part of o/requests#62\n\nAdds CHANGE.\n']]);
    assert.match(comments(w, 62).at(-1)!, /No pull request for:\n\n- `libs\/target`: no commits beyond `[0-9a-f]{12}`\. Uncommitted changes are not delivered\./);
    assert.deepEqual(prsOf(w, 62)?.map((p) => p.repo), ['service']);
  });

  // Three repos pushed twice: past bun's default 5 s on a slow machine.
  test('two delivered repos: a checkpoint pushes a branch per repo, and the resumed request continues both', { timeout: 60_000 }, async () => {
    const w = world();
    for (const r of ['o/service', 'o/target']) w.store.setPermission(r, 'alice', 'write');
    const fm = ['deliver: pr', 'repos:', `  - url: ${SERVICE}`, '    ref: main', `  - url: ${TARGET}`, '    ref: main', `  - url: ${GUIDE}`, '    ref: main', '    deliver: none'];
    w.store.addIssue({ number: 63, title: 'Long', body: body('quit 3', fm, CONTEXT) });
    await until(w, 'partial', () => status(w, 63) === 'partial');
    const r = resultOf(w, 63)!;
    const sha = (b: BareRepo, ref: string) => execFileSync('git', ['--git-dir', b.bare, 'rev-parse', ref], { encoding: 'utf8' }).trim();
    assert.deepEqual(r.resume!.branches, [
      { repo: 'service', branch: 'air/63', sha: sha(service, 'air/63') },
      { repo: 'target', branch: 'air/63', sha: sha(bare, 'air/63') },
    ]);
    assert.equal(spawnSync('git', ['--git-dir', guide.bare, 'rev-parse', '--verify', '--quiet', 'refs/heads/air/63']).status, 1, 'read-only repo untouched');
    assert.equal(w.fg.pulls.filter((p) => p.title.endsWith('(#63)')).length, 0);

    const issue = w.store.issues.get(63)!;
    issue.body = body('pr', [...fm, 'resume:', '  branches:', ...r.resume!.branches.flatMap((b) => [`    - repo: ${b.repo}`, `      branch: ${b.branch}`, `      sha: "${b.sha}"`]),
      '  out:', `    url: ${r.resume!.out!.url}`, `    sha256: ${r.resume!.out!.sha256}`, `    bytes: ${r.resume!.out!.bytes}`], CONTEXT);
    issue.labels = issue.labels.filter((l) => !l.startsWith('air:'));
    await until(w, 'delivered', () => status(w, 63) === 'done');
    // Each repo's checkpoint branch moved on; no second branch is left behind.
    for (const [b, repo] of [[service, 'o/service'], [bare, 'o/target']] as const) {
      assert.equal(execFileSync('git', ['--git-dir', b.bare, 'log', '--format=%s', 'main..air/63'], { encoding: 'utf8' }), 'the change\nwip 2\nwip 1\n', repo);
      assert.equal(spawnSync('git', ['--git-dir', b.bare, 'rev-parse', '--verify', '--quiet', 'refs/heads/air/63-2']).status, 1, repo);
    }
    assert.deepEqual(w.fg.pulls.filter((p) => p.title.endsWith('(#63)')).map((p) => [p.repo, p.head]), [['o/service', 'air/63'], ['o/target', 'air/63']]);
    assert.equal(readFileSync(join(job(w, 63)!.dir, 'out', 'PROGRESS.md'), 'utf8'), 'start 1\nstart 2\n');
  });

  test('zero repos: no repo/, setup runs in the workspace, and an artifact is delivered', async () => {
    const w = world();
    w.store.addIssue({ number: 64, body: body('artifact', ['deliver: artifact', 'setup: ["pwd > where.txt"]']) });
    await until(w, 'delivered', () => status(w, 64) === 'done');
    const ws = job(w, 64)!;
    assert.deepEqual(ws.state.repos, []);
    assert.equal(existsSync(join(ws.dir, 'repo')), false);
    assert.equal(readFileSync(join(ws.dir, 'where.txt'), 'utf8').trim().replace(/^\/private/, ''), ws.dir);
    const task = readFileSync(join(ws.dir, 'AIR_TASK.md'), 'utf8');
    assert.doesNotMatch(task, /repo\//);
    assert.match(task, /If you are stopped early, air keeps only `out\/`/);
    assert.doesNotMatch(comments(w, 64)[0]!, /Repos/);
    assert.equal(resultOf(w, 64)?.status, 'done');
    assert.equal(resultOf(w, 64)?.deliver, 'artifact');
  });

  test('a request the author may not deliver to is not claimed; granting access lets the next tick claim it', async () => {
    const w = world();
    w.store.setPermission('o/service', 'alice', 'read');
    w.store.addIssue({ number: 65, body: body('pr', ['deliver: pr', 'repos:', `  - url: ${SERVICE}`, '    ref: main'], CONTEXT) });
    for (let i = 0; i < 3; i++) {
      await w.server.tick();
      await w.server.idle();
    }
    assert.equal(job(w, 65), undefined);
    assert.equal(comments(w, 65).length, 1);
    assert.match(comments(w, 65)[0]!, /@alice has read access to o\/service/);
    assert.equal(w.logs.filter((l) => /^#65: not claimed/.test(l)).length, 1, w.logs.join('\n'));
    w.store.setPermission('o/service', 'alice', 'write');
    await until(w, 'delivered', () => status(w, 65) === 'done');
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

  test('a claim cut off by a crash is released by the next server, and the request is served', async () => {
    const w = world();
    w.store.addIssue({ number: 23, body: body('comment x') });
    // The process dies during the claim wait: the claim comment is up, and nothing will ever finish it.
    void claim({ gh: w.ctx.gh, issue: 23, root: w.root, host: 'box', sleep: () => new Promise(() => {}) });
    while (job(w, 23)?.state.claimCommentId === undefined) await sleep(10);
    assert.equal(job(w, 23)!.state.phase, 'claiming');
    const cut = await holder(w, 23);
    assert.equal(cut?.host, 'box');
    // The next server's first tick is the restart: it releases that claim, then claims the issue anew.
    await until(w, 'delivered', () => status(w, 23) === 'done');
    assert.equal(w.logs[0], '#23: interrupted claim released');
    assert.match(comments(w, 23)[1]!, /^Released by `box`: its claim was cut off before work started\.[\s\S]*status: released/);
    assert.notEqual((await holder(w, 23))?.nonce, cut!.nonce);
    assert.deepEqual(allWorkspaces(w.root, 'o/requests').filter((x) => x.state.issue === 23).map((x) => x.state.phase).sort(), ['done', 'released']);
  });

  test('regression: an interrupted claim that a rival now holds is withdrawn, so the issue can be claimed once the rival lets go', async () => {
    const w = world();
    w.store.addIssue({ number: 26, body: body('comment x') });
    w.store.setPermission('o/requests', 'carol', 'write');
    // A rival claims (and self-assigns) between our pre-check and our claim; then we die in the claim wait.
    let once = false;
    w.store.onComments = () => {
      if (once) return;
      once = true;
      w.store.post(26, 'carol', 'OWNER', formatMarker({ kind: 'claim', version: 0, host: 'box-b', nonce: 'bbbbbbbbbbbb' }));
      w.store.issues.get(26)!.assignees.push('carol');
    };
    void claim({ gh: w.ctx.gh, issue: 26, root: w.root, host: 'box', sleep: () => new Promise(() => {}) });
    while (job(w, 26)?.state.claimCommentId === undefined) await sleep(10);
    const ours = job(w, 26)!.state.claimCommentId!;
    while (!w.store.issues.get(26)!.assignees.includes('bot')) await sleep(10);
    await w.server.tick();
    await w.server.idle();
    assert.equal(job(w, 26)!.state.phase, 'lost');
    assert.ok(!w.store.issues.get(26)!.comments.some((c) => c.id === ours), w.logs.join('\n'));
    assert.deepEqual(w.store.issues.get(26)!.assignees, ['carol']);
    // The rival gives it back: the next tick claims it and the request is served.
    w.store.post(26, 'carol', 'OWNER', formatMarker({ kind: 'release', version: 0, host: 'box-b', nonce: 'bbbbbbbbbbbb' }));
    w.store.issues.get(26)!.assignees = [];
    await until(w, 'delivered', () => status(w, 26) === 'done');
  });

  test('regression: an interrupted claim whose release fails on the restart tick is retried on the next tick', async () => {
    const w = world();
    w.store.addIssue({ number: 27, body: body('comment x') });
    void claim({ gh: w.ctx.gh, issue: 27, root: w.root, host: 'box', sleep: () => new Promise(() => {}) });
    while (job(w, 27)?.state.claimCommentId === undefined) await sleep(10);
    const read = w.store.comments;
    let failed = false;
    w.store.comments = async (n) => {
      if (!failed) {
        failed = true;
        throw new GhError('server', 'Server Error (HTTP 502)', 502);
      }
      return read(n);
    };
    await w.server.tick({ poll: false });
    await w.server.idle();
    assert.ok(failed);
    assert.equal(job(w, 27)!.state.phase, 'claiming');
    await w.server.tick({ poll: false });
    await w.server.idle();
    assert.equal(job(w, 27)!.state.phase, 'released', w.logs.join('\n'));
    assert.equal(await holder(w, 27), undefined);
  });

  test('a claim that throws is withdrawn and left alone for a while, not claimed again every tick', async () => {
    const w = world();
    w.store.addIssue({ number: 24, body: body('comment x') });
    const assign = w.store.assign;
    w.store.assign = async () => { throw new GhError('other', 'unsupported API write route/method'); };
    for (let i = 0; i < 3; i++) {
      await w.server.tick();
      await w.server.idle();
    }
    assert.equal(w.store.log.filter((l) => l === 'comment 24').length, 1, w.logs.join('\n'));
    assert.deepEqual(comments(w, 24), []);
    assert.equal(w.logs.filter((l) => /^#24: claim failed: .*unsupported API write route\/method.*; trying it again in 60 min$/.test(l)).length, 1, w.logs.join('\n'));
    w.store.assign = assign;
    w.clock.offset = CLAIM_RETRY_MS;
    await until(w, 'delivered', () => status(w, 24) === 'done');
  });

  test('regression: a claim that throws is tried again as soon as its body changes', async () => {
    const w = world();
    w.store.addIssue({ number: 28, body: body('comment x') });
    const assign = w.store.assign;
    w.store.assign = async () => { throw new GhError('other', 'unsupported API write route/method'); };
    await w.server.tick();
    await w.server.idle();
    assert.equal(w.logs.filter((l) => /^#28: claim failed/.test(l)).length, 1, w.logs.join('\n'));
    w.store.assign = assign;
    w.store.issues.get(28)!.body = body('comment y');
    await w.server.tick();
    await w.server.idle();
    assert.ok(job(w, 28)?.state.job, w.logs.join('\n'));
  });

  test('artifact: zips regular files of out/ but PROGRESS.md to a release asset; an out/ without one fails', async () => {
    const w = world();
    w.ctx.config.max_jobs = 3;
    w.store.addIssue({ number: 5, body: body('artifact', ['deliver: artifact']) });
    w.store.addIssue({ number: 6, body: body('empty', ['deliver: artifact']) });
    w.store.addIssue({ number: 9, body: body('notes', ['deliver: artifact']) });
    await until(w, 'all finished', () => status(w, 5) === 'done' && status(w, 6) === 'failed' && status(w, 9) === 'failed');
    const nonce = job(w, 5)!.state.nonce;
    const asset = w.fg.releases[0]!.assets.find((a) => a.name === `air-5-${nonce}.zip`)!;
    assert.equal(asset.contentType, 'application/zip');
    const final = comments(w, 5).at(-1)!;
    const result = parseResult(final);
    assert.deepEqual(result?.ok && result.result.artifact, {
      url: `https://github.com/o/requests/releases/download/air-artifacts/air-5-${nonce}.zip`, sha256: createHash('sha256').update(asset.data).digest('hex'), bytes: asset.data.length,
    });
    const d = tmp('air-serve-unzip-');
    const zip = join(d, 'a.zip');
    writeFileSync(zip, asset.data);
    await extractZip(zip, join(d, 'x'), 1 << 20);
    assert.equal(readFileSync(join(d, 'x', 'a.txt'), 'utf8'), 'alpha\n');
    assert.equal(readFileSync(join(d, 'x', 'sub', 'b.txt'), 'utf8'), 'beta\n');
    assert.equal(existsSync(join(d, 'x', 'link')), false);
    assert.equal(existsSync(join(d, 'x', 'PROGRESS.md')), false, 'a done artifact leaves out PROGRESS.md');
    assert.deepEqual(readdirSync(join(d, 'x')).sort(), ['a.txt', 'sub']);
    assert.match(comments(w, 6).at(-1)!, /no regular file in `out\/` besides `PROGRESS\.md`/);
    assert.deepEqual(stateLabels(w, 6), ['air:failed']);
    assert.match(comments(w, 9).at(-1)!, /no regular file in `out\/` besides `PROGRESS\.md`/);
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
    // no expires: the spec default (14 days after close) applies
    const result = parseResult(comments(w, 27).at(-1)!);
    assert.deepEqual(result?.ok && result.result.artifact, { url: asset.url, sha256: asset.sha256, bytes: asset.bytes });
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
    assert.match(starts[3]!.at(-1)!, /^Read AIR_TASK\.md .* interrupted: first read out\/PROGRESS\.md/);
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

  test('an agent at a prompt: logged with its fix, shown in tmux and air status, one issue comment, and it keeps running', async () => {
    const w = world();
    w.store.addIssue({ number: 40, body: body('prompt claude-trust') });
    await running(w, 40);
    await sleep(300);
    await w.server.tick();
    w.clock.offset = SETTLE_MS + 1000;
    await until(w, 'waiting', () => job(w, 40)!.state.job!.waiting?.prompt === 'claude-trust');
    const waiting = job(w, 40)!.state.job!.waiting!;
    assert.equal(waiting.what, 'Claude Code folder trust ("Quick safety check")');
    assert.match(waiting.fix, new RegExp(`^attach with \`air attach 40\` .* and answer it \\("Yes, I trust this folder"\\); if it recurs, run \`air doctor\`: jobs under workspace_root ${w.root} inherit its trust`));
    assert.equal(w.logs.filter((l) => l.startsWith('#40: claude is waiting on you: Claude Code folder trust ("Quick safety check"). Fix: attach with `air attach 40`')).length, 1);
    const bar = () => spawnSync('tmux', ['-L', socket, 'show-options', '-v', '-t', '=air:', 'status-right'], { encoding: 'utf8' }).stdout;
    assert.equal(bar().trim(), '##40 claude waits on you: Claude Code folder trust ("Quick safety check"); see air status 40');
    const st = await statusViaCli(w, 40);
    assert.match(st.out, /waiting: the claude agent here waits on you since \S+: Claude Code folder trust/);
    for (let i = 0; i < 3; i++) {
      await w.server.tick();
      await w.server.idle();
    }
    const told = () => comments(w, 40).filter((c) => /is waiting on the volunteer/.test(c));
    assert.equal(told().length, 1);
    assert.match(told()[0]!, /^The claude agent working on this request on `box` is waiting on the volunteer: Claude Code folder trust/);
    assert.equal(w.logs.filter((l) => l.startsWith('#40: claude is waiting on you')).length, 1);
    assert.equal(status(w, 40), 'running');
    writeFileSync(join(job(w, 40)!.dir, 'go'), '');
    await until(w, 'delivered', () => status(w, 40) === 'done');
    assert.equal(told().length, 1);
    await w.server.tick();
    assert.equal(bar(), '');
  });

  test('an agent whose screen stops changing for 15 min may be at a prompt: idle is local only, never posted', async () => {
    const w = world();
    w.store.addIssue({ number: 41, body: body('hang', ['deliver: comment', 'timeout: 1h']) });
    await running(w, 41);
    await w.server.tick();
    assert.equal(job(w, 41)!.state.job!.waiting, undefined);
    // A quiet build or download: 6 minutes without output is not yet idle.
    w.clock.offset = 6 * 60_000;
    await w.server.tick();
    assert.equal(job(w, 41)!.state.job!.waiting, undefined);
    w.clock.offset = STUCK_MS + 60_000;
    await until(w, 'idle', () => job(w, 41)!.state.job!.waiting?.prompt === 'idle');
    assert.match(job(w, 41)!.state.job!.waiting!.fix, /^attach with `air attach 41` \(`tmux -L \S+ attach -t @\d+`\) and answer it$/);
    assert.ok(w.logs.some((l) => l.startsWith('#41: claude is waiting on you: no screen change for 15 min')));
    assert.match((await statusViaCli(w, 41)).out, /waiting: the claude agent here waits on you since \S+: no screen change for 15 min/);
    assert.equal(comments(w, 41).filter((c) => /waiting on the volunteer/.test(c)).length, 0);
    assert.equal(status(w, 41), 'running');
  });

  test('output that mentions a prompt is not a prompt: no waiting, no comment', async () => {
    const w = world();
    w.store.addIssue({ number: 42, body: body('screen claude-output-mentions-prompt', ['deliver: comment', 'timeout: 2h']) });
    await running(w, 42);
    await sleep(300);
    for (const offset of [0, SETTLE_MS + 1000, 2 * SETTLE_MS]) {
      w.clock.offset = offset;
      await w.server.tick();
      await w.server.idle();
    }
    assert.equal(job(w, 42)!.state.job!.waiting, undefined);
    assert.equal(comments(w, 42).filter((c) => /waiting on the volunteer/.test(c)).length, 0);
  });

  test('a prompt counts only once it has stayed on screen for 60 s', async () => {
    const w = world();
    w.store.addIssue({ number: 43, body: body('screen claude-trust', ['deliver: comment', 'timeout: 2h']) });
    await running(w, 43);
    await sleep(300);
    await w.server.tick();
    assert.equal(job(w, 43)!.state.job!.waiting, undefined);
    w.clock.offset = SETTLE_MS + 1000;
    await w.server.tick();
    assert.equal(job(w, 43)!.state.job!.waiting?.prompt, 'claude-trust');
  });

  test('each waiting episode posts once, up to 3 comments per job', async () => {
    const w = world();
    w.store.addIssue({ number: 44, body: body('screen claude-trust', ['deliver: comment', 'timeout: 2h']) });
    await running(w, 44);
    const dir = job(w, 44)!.dir;
    const told = () => comments(w, 44).filter((c) => /waiting on the volunteer/.test(c)).length;
    let offset = 0;
    const tickAfter = async (ms: number) => {
      w.clock.offset = offset += ms;
      await w.server.tick();
      await w.server.idle();
    };
    const show = async (what: 'prompt' | 'work') => {
      writeFileSync(join(dir, 'screen'), what);
      await sleep(300);
    };
    await sleep(300);
    for (let episode = 1; episode <= 4; episode++) {
      await tickAfter(0);
      await tickAfter(SETTLE_MS + 1000);
      await tickAfter(10_000);
      assert.equal(job(w, 44)!.state.job!.waiting?.prompt, 'claude-trust', `episode ${episode}`);
      assert.equal(told(), Math.min(episode, MAX_WAITING_COMMENTS), `episode ${episode}`);
      await show('work');
      await tickAfter(1000);
      assert.equal(job(w, 44)!.state.job!.waiting, undefined, `episode ${episode} moved on`);
      await show('prompt');
    }
    assert.equal(status(w, 44), 'running');
  });

  test('after a restart, an idle job stays waiting until its screen changes', async () => {
    const w = world();
    w.store.addIssue({ number: 45, body: body('screen claude-auto-working', ['deliver: comment', 'timeout: 2h']) });
    await running(w, 45);
    await sleep(300);
    await w.server.tick();
    w.clock.offset = STUCK_MS + 60_000;
    await w.server.tick();
    assert.equal(job(w, 45)!.state.job!.waiting?.prompt, 'idle');
    const again = createServer(w.ctx);
    for (let i = 0; i < 3; i++) {
      await again.tick();
      await again.idle();
      assert.equal(job(w, 45)!.state.job!.waiting?.prompt, 'idle', `tick ${i + 1} after the restart`);
    }
    writeFileSync(join(job(w, 45)!.dir, 'screen'), 'work');
    await sleep(300);
    await again.tick();
    assert.equal(job(w, 45)!.state.job!.waiting, undefined);
  });

  test('a config without [agents.claude] starts Claude Code with the default unattended args', async () => {
    const bin = tmp('air-fake-bin-');
    writeFileSync(join(bin, 'claude'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_AGENT)} "$@"\n`, { mode: 0o755 });
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    try {
      const w = world();
      w.ctx.config.agents = {};
      w.store.addIssue({ number: 46, body: body('comment hi') });
      await until(w, 'delivered', () => status(w, 46) === 'done');
      assert.deepEqual(argvLog(job(w, 46)!.dir)[0]!.slice(-3), ['--permission-mode', 'auto', 'Read AIR_TASK.md in this directory and do the task it describes.']);
    } finally {
      process.env.PATH = path;
    }
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
    assert.deepEqual(resultOf(w, 10), { status: 'released', deliver: 'comment', usage: { harness: 'claude', tier: 'medium', before_pct: 10, after_pct: 10, attempts: 1 } });
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
    assert.equal(resultOf(w, 11, (c) => /paused this request 48 hours ago/.test(c))?.status, 'released');
    assert.deepEqual(stateLabels(w, 12), ['air:failed']);
    // A timeout whose checkpoint keeps nothing (no commits, empty out/) fails (spec §11 rule 5).
    assert.match(comments(w, 12).at(-1)!, /failed at the timeout[\s\S]*past the request's `timeout` of 1 min[\s\S]*There is no checkpoint/);
    assert.equal(resultOf(w, 12)?.status, 'failed');
    assert.equal(resultOf(w, 12)?.resume, undefined);
  });

  test('an agent that exits without AIR_DONE, whatever its status, is resumed once, then stopped early as partial', async () => {
    const w = world();
    w.store.addIssue({ number: 13, body: body('quit 0') });
    w.store.addIssue({ number: 30, body: body('quit 4') });
    await until(w, 'both partial', () => status(w, 13) === 'partial' && status(w, 30) === 'partial');
    for (const n of [13, 30]) {
      const ws = job(w, n)!;
      const starts = argvLog(ws.dir);
      assert.equal(starts.length, 2, `#${n}: one resume`);
      assert.deepEqual(starts[1]!.slice(0, 2), ['--resume', ws.state.job!.sessionId]);
      assert.match(starts[1]!.at(-1)!, /^Your session ended before the task was finished \(there is no AIR_DONE\)\. Read out\/PROGRESS\.md, then continue/);
      assert.deepEqual(stateLabels(w, n), ['air:partial']);
      assert.equal(await holder(w, n), undefined, 'a partial result releases the claim');
      assert.deepEqual(w.store.issues.get(n)!.assignees, []);
      assert.equal(ws.state.phase, 'released');
      const final = comments(w, n).at(-1)!;
      assert.match(final, /^air on `box` stopped this request early because the agent exited without finishing, again after being resumed once\. The agent exited/);
      assert.match(final, n === 13 ? /exited with status 0 without finishing/ : /exited with status 4 without finishing/);
      assert.match(final, new RegExp(`<!-- air-release v0 host=box nonce=${ws.state.nonce} -->\n<!-- air-result v0 -->`));
      const r = resultOf(w, n)!;
      const asset = w.fg.releases.find((x) => x.tag === 'air-artifacts')!.assets.find((a) => a.name === `air-${n}-${ws.state.nonce}-out.zip`)!;
      assert.deepEqual(r, {
        status: 'partial', deliver: 'comment', report: 'comment',
        resume: { branches: [], out: { url: `https://github.com/o/requests/releases/download/air-artifacts/air-${n}-${ws.state.nonce}-out.zip`, sha256: sha256(asset.data), bytes: asset.data.length } },
        usage: { harness: 'claude', tier: 'medium', before_pct: 10, after_pct: 10, attempts: 2 },
      });
      assert.equal(readFileSync(join(await unzip(asset.data), 'PROGRESS.md'), 'utf8'), 'start 1\nstart 2\n', 'a checkpoint keeps PROGRESS.md');
    }
  });

  test('pr: a partial result pushes a checkpoint branch, and a request resumed from it continues there', async () => {
    const w = world();
    w.store.setPermission('o/target', 'alice', 'write');
    w.store.addIssue({ number: 31, title: 'Long change', body: body('quit 3', PR, CONTEXT) });
    await until(w, 'partial', () => status(w, 31) === 'partial');
    const first = job(w, 31)!;
    const sha = execFileSync('git', ['--git-dir', bare.bare, 'rev-parse', 'refs/heads/air/31'], { encoding: 'utf8' }).trim();
    assert.equal(execFileSync('git', ['--git-dir', bare.bare, 'log', '--format=%s', `main..${sha}`], { encoding: 'utf8' }), 'wip 2\nwip 1\n');
    assert.equal(w.fg.pulls.length, 0, 'a checkpoint opens no pull request');
    const r = resultOf(w, 31)!;
    assert.deepEqual(r.resume!.branches, [{ repo: 'target', branch: 'air/31', sha }]);
    assert.match(r.resume!.out!.url, new RegExp(`/air-31-${first.state.nonce}-out\\.zip$`));
    assert.match(comments(w, 31).at(-1)!, /pushed to branch `air\/31` of https:\/\/github\.com\/o\/target/);

    // `air retry` writes the result's `resume` into the front matter and removes the air:* labels.
    const resume = [
      'resume:', '  branches:', '    - repo: target', '      branch: air/31', `      sha: "${sha}"`,
      '  out:', `    url: ${r.resume!.out!.url}`, `    sha256: ${r.resume!.out!.sha256}`, `    bytes: ${r.resume!.out!.bytes}`,
    ];
    const issue = w.store.issues.get(31)!;
    issue.body = body('pr', [...PR, ...resume], CONTEXT);
    issue.labels = issue.labels.filter((l) => !l.startsWith('air:'));
    const downloads = w.fg.calls.length;
    await until(w, 'delivered', () => status(w, 31) === 'done');
    const second = job(w, 31)!;
    assert.notEqual(second.state.nonce, first.state.nonce);
    assert.ok(w.fg.calls.slice(downloads).some((c) => /^api repos\/o\/requests\/releases\/assets\/\d+ -H Accept: application\/octet-stream --method GET$/.test(c)), 'the checkpoint zip came through gh');
    assert.equal(readFileSync(join(second.dir, 'out', 'PROGRESS.md'), 'utf8'), 'start 1\nstart 2\n');
    const task = readFileSync(join(second.dir, 'AIR_TASK.md'), 'utf8');
    assert.match(task, /## Continuing earlier work/);
    assert.match(task, new RegExp(`checked out at the earlier work's checkpoint, \`${sha}\` on branch \`air/31\``));
    assert.match(task, /Keep `out\/PROGRESS\.md` up to date/);
    // The PR carries the checkpoint's commits and the new one, on the checkpoint's own branch: nothing is left over.
    assert.equal(w.fg.pulls.length, 1);
    assert.equal(w.fg.pulls[0]!.head, 'air/31');
    const head = execFileSync('git', ['--git-dir', bare.bare, 'rev-parse', 'refs/heads/air/31'], { encoding: 'utf8' }).trim();
    assert.equal(execFileSync('git', ['--git-dir', bare.bare, 'log', '--format=%s', `main..${head}`], { encoding: 'utf8' }), 'the change\nwip 2\nwip 1\n');
    assert.equal(spawnSync('git', ['--git-dir', bare.bare, 'rev-parse', '--verify', '--quiet', 'refs/heads/air/31-2']).status, 1, 'no second branch');
    assert.equal(resultOf(w, 31)?.status, 'done');
  });

  test("pr: a resumed request never overwrites a checkpoint branch someone moved since", async () => {
    const w = world();
    w.store.setPermission('o/target', 'alice', 'write');
    w.store.addIssue({ number: 34, title: 'Long change', body: body('quit 3', PR, CONTEXT) });
    await until(w, 'partial', () => status(w, 34) === 'partial');
    const r = resultOf(w, 34)!;
    const git = (...a: string[]) => execFileSync('git', ['--git-dir', bare.bare, ...a], { encoding: 'utf8' }).trim();
    const checkpointSha = git('rev-parse', 'refs/heads/air/34');
    // Someone else pushes to the checkpoint branch before the request is resumed.
    const moved = git('-c', 'user.name=Someone', '-c', 'user.email=someone@example.com', 'commit-tree', `${checkpointSha}^{tree}`, '-p', checkpointSha, '-m', 'by hand');
    git('update-ref', 'refs/heads/air/34', moved);
    const issue = w.store.issues.get(34)!;
    issue.body = body('pr', [...PR, 'resume:', '  branches:', '    - repo: target', '      branch: air/34', `      sha: "${checkpointSha}"`,
      '  out:', `    url: ${r.resume!.out!.url}`, `    sha256: ${r.resume!.out!.sha256}`, `    bytes: ${r.resume!.out!.bytes}`], CONTEXT);
    issue.labels = issue.labels.filter((l) => !l.startsWith('air:'));
    await until(w, 'failed', () => status(w, 34) === 'failed');
    assert.equal(git('rev-parse', 'refs/heads/air/34'), moved, 'the moved branch is left as it is');
    assert.equal(w.fg.pulls.length, 0);
    assert.match(comments(w, 34).at(-1)!, /checkpoint branch `air\/34` moved since the checkpoint/);
  });

  test('a resume whose checkpoint zip is missing fails before setup runs', async () => {
    const w = world();
    const url = 'https://github.com/o/requests/releases/download/air-artifacts/air-33-gone-out.zip';
    w.store.addIssue({ number: 33, body: body('comment x', ['deliver: comment', 'setup: ["touch ran"]', 'resume:', '  out:', `    url: ${url}`, `    sha256: ${'a'.repeat(64)}`, '    bytes: 10']) });
    await until(w, 'failed', () => job(w, 33)?.state.phase === 'failed');
    assert.match(comments(w, 33).at(-1)!, /failed at the checkpoint download[\s\S]*was not found/);
    assert.equal(existsSync(join(job(w, 33)!.dir, 'ran')), false);
    assert.deepEqual(resultOf(w, 33), { status: 'failed', deliver: 'comment' });
  });

  test('timeout: the agent is stopped and its checkpoint posted as partial', async () => {
    const w = world();
    w.store.addIssue({ number: 34, body: body('progress', ['deliver: comment', 'timeout: 1m']) });
    await running(w, 34);
    await waitFor(async () => existsSync(join(job(w, 34)!.dir, 'out', 'PROGRESS.md')));
    w.clock.offset = 2 * 60_000;
    await until(w, 'partial', () => status(w, 34) === 'partial');
    assert.match(comments(w, 34).at(-1)!, /stopped this request early because the agent ran past the request's `timeout` of 1 min/);
    assert.equal(await tmuxClient.isAlive(34), false);
    const r = resultOf(w, 34)!;
    assert.equal(r.status, 'partial');
    assert.ok(r.resume?.out);
    assert.deepEqual(stateLabels(w, 34), ['air:partial']);
  });

  test('quota: a window that resets more than 24 h away stops the job early as partial', async () => {
    const w = world();
    w.store.addIssue({ number: 35, body: body('progress') });
    await running(w, 35);
    w.subs[0] = weekly(100, new Date(Date.now() + 3 * 86_400_000).toISOString());
    await until(w, 'partial', () => status(w, 35) === 'partial');
    assert.match(comments(w, 35).at(-1)!, /ran out of quota, and it only resets at .*, more than 24 hours away/);
    assert.deepEqual(resultOf(w, 35)?.usage, { harness: 'claude', tier: 'medium', before_pct: 10, after_pct: 100, attempts: 1 });
  });

  test('quota: a pause that does not end within 24 h becomes partial, never a 48 h release', async () => {
    const w = world();
    w.store.addIssue({ number: 36, body: body('progress') });
    await running(w, 36);
    w.subs[0] = weekly(100, new Date(Date.now() + 3600_000).toISOString());
    await until(w, 'paused', () => status(w, 36) === 'paused');
    assert.equal(job(w, 36)!.state.job!.pauseReason, 'quota');
    w.clock.offset = PAUSE_LIMIT_MS + 3600_000; // still out of quota, and paused for longer than 48 h
    await until(w, 'partial', () => status(w, 36) === 'partial');
    assert.match(comments(w, 36).at(-1)!, /ran out of quota and did not recover within 24 hours/);
    assert.ok(!comments(w, 36).some((c) => /paused this request 48 hours ago/.test(c)));
    assert.deepEqual(stateLabels(w, 36), ['air:partial']);
  });

  test('effort: a job that costs more than twice its effort is stopped early as partial', async () => {
    const w = world({ transcripts: true });
    w.store.addIssue({ number: 37, body: body('progress') });
    await running(w, 37); // $0.50 so far
    addCall(w, 37, 'claude-sonnet-5-5', { input_tokens: 0, output_tokens: 140_000 }); // + $1.40: XS is $1, the cap $2
    await w.server.tick();
    await w.server.idle();
    assert.equal(status(w, 37), 'running', 'twice the effort is still allowed');
    addCall(w, 37, 'claude-sonnet-5-5', { input_tokens: 0, output_tokens: 20_000 }); // + $0.20
    await until(w, 'partial', () => status(w, 37) === 'partial');
    assert.match(comments(w, 37).at(-1)!, /it has cost \$2\.10 at API prices, more than twice the \$1\.00 that effort XS stands for/);
    assert.deepEqual(resultOf(w, 37)?.usage, { harness: 'claude', tier: 'medium', before_pct: 10, after_pct: 10, attempts: 1 });
  });

  test('a hanging gh call times out; the loop logs it and carries on', async () => {
    const w = world({ timeoutMs: 300 });
    w.store.addIssue({ number: 14, body: body('comment hi') });
    w.fg.hang = (a) => a.includes('issues?state=open');
    const t0 = Date.now();
    await w.server.tick();
    assert.ok(Date.now() - t0 < 3000);
    assert.ok(w.logs.some((l) => /poll failed: gh api repos\/o\/requests\/issues\?state=open.* timed out/.test(l)), w.logs.join('\n'));
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
    w.ctx.tmux = createTmux({ repo: 'o/requests', socket, run: async (a) => (a[0] === '-V' ? { code: 0, stdout: 'tmux 2.9a\n', stderr: '' } : { code: 1, stdout: '', stderr: 'unexpected' }) });
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

  test('--once retries a poll that fails (a 5xx from gh), and fails after ONCE_POLL_TRIES', async () => {
    const w = world();
    w.store.addIssue({ number: 44, body: body('comment retried') });
    w.fg.failOnce = (a) => a.includes('/issues?state=open');
    await w.server.run({ once: true, onceWaitMs: 0, onceRetryMs: 50, watchMs: 100 });
    assert.equal(w.fg.failOnce, undefined, 'the first issue list did fail');
    assert.ok(w.logs.some((l) => /^poll failed: .*HTTP 502/.test(l)), w.logs.join('\n'));
    assert.ok(w.logs.includes('--once: the poll failed; trying again in 0.05 s (attempt 2 of 3)'), w.logs.join('\n'));
    assert.equal(status(w, 44), 'done', w.logs.join('\n'));

    const down = world();
    let lists = 0;
    down.ctx.api.openRequests = async () => {
      lists++;
      throw new GhError('server', 'Bad Gateway (HTTP 502)', 502);
    };
    const t0 = Date.now();
    await assert.rejects(down.server.run({ once: true, onceWaitMs: 0, onceRetryMs: 50 }), /^Error: --once: polling o\/requests for requests failed 3 times; giving up/);
    assert.equal(lists, ONCE_POLL_TRIES);
    assert.ok(Date.now() - t0 >= 50 + 100, 'backoff doubles: 50 ms, then 100 ms');
    assert.deepEqual(down.logs.filter((l) => l.startsWith('--once: the poll failed')), [
      '--once: the poll failed; trying again in 0.05 s (attempt 2 of 3)', '--once: the poll failed; trying again in 0.1 s (attempt 3 of 3)']);
  });

  test('serve creates every air label a fresh requests repo lacks, air:cancel included, once', async () => {
    const w = world();
    assert.deepEqual([...w.store.labels], ['ai-request']);
    await w.server.run({ once: true, onceWaitMs: 0 });
    assert.deepEqual([...w.store.labels].sort(), LABELS.map((l) => l.name).sort());
    for (const l of [...STATE_LABELS, CANCEL_LABEL]) assert.ok(w.store.labels.has(l), l);
    assert.ok(w.logs.includes('created labels air:claimed, air:running, air:paused, air:done, air:partial, air:failed, air:cancel on o/requests'), w.logs.join('\n'));
    const again = world();
    again.store.labels.add('air:cancel');
    await again.server.run({ once: true, onceWaitMs: 0 });
    assert.ok(again.logs.some((l) => /^created labels air:claimed, .*air:failed on o\/requests$/.test(l)), again.logs.join('\n'));
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

async function statusViaCli(w: World, n: number) {
  requestDeps.loadConfig = () => w.ctx.config;
  requestDeps.repo = () => w.ctx.gh;
  let out = '';
  const code = await main(['status', String(n)], { out: (s) => { out += s; }, err: () => {} });
  return { code, out };
}

async function stopViaCli(w: World, n: number) {
  jobDeps.loadConfig = () => w.ctx.config;
  jobDeps.context = () => w.ctx;
  assert.equal(await main(['stop', String(n)], { out: () => {}, err: () => {} }), 0);
  assert.equal(readState(job(w, n)!.dir).job!.status, 'paused');
}
