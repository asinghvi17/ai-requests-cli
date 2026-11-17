// Against a real tmux on a throwaway socket. Skipped when tmux is missing; the server is killed after the
// suite and on exit or interrupt, and any global environment the tests set is restored.
import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createTmux, defaultRunner, socketPath, TASK_FILE, TASK_INSTRUCTION } from './tmux.ts';
import { clientEnv } from './env.ts';
import { REAP_GRACE_SECONDS } from './launcher.ts';

const hasTmux = spawnSync('tmux', ['-V']).status === 0;
const socket = `air-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const raw = defaultRunner(socket);

/** Process groups of jobs a test started: KILLed after each test, whatever happened, so none outlive the suite. */
const groups = new Set<number>();
/**
 * Pids of `pgid`'s members that still run. Zombies don't count: tmux < 3.6 with utempter may never reap the dead
 * launcher shell (the bug the launcher works around), and a zombie runs nothing.
 */
function running(pgid: number): number[] {
  const ps = spawnSync('ps', ['-eo', 'pid=,pgid=,stat='], { encoding: 'utf8' });
  return ps.stdout.split('\n').map((l) => l.trim().split(/\s+/)).filter(([, g, st]) => Number(g) === pgid && st && !st.startsWith('Z')).map(([p]) => Number(p));
}
function killGroups() {
  for (const g of groups) {
    try {
      process.kill(-g, 'SIGKILL');
    } catch {
      // gone
    }
  }
  groups.clear();
}

function killTestServer() {
  killGroups();
  spawnSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' });
  rmSync(socketPath(socket), { force: true }); // tmux may be unable to unlink it in a sandbox
}
if (hasTmux) {
  process.on('exit', killTestServer);
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => { killTestServer(); process.exit(130); });
}

async function until(what: string, check: () => Promise<boolean> | boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

describe('tmux integration', { skip: hasTmux ? false : 'tmux not installed' }, () => {
  let t = createTmux({ repo: 'o/requests', socket });
  let dir = '';
  const saved = process.env.AIR_TEST_INHERITED;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'air-tmux-'));
    // The caller's environment reaches jobs whole (the tmux server itself gets an allowlisted one).
    process.env.AIR_TEST_INHERITED = 'from the volunteer';
    assert.equal(await t.ensureSession(), true);
    assert.equal(await t.ensureSession(), false);
  });
  afterEach(async () => {
    for (const job of await t.listJobs()) await t.stopJob(job.issue, { graceMs: 0 });
    killGroups();
  });
  after(() => {
    killTestServer();
    if (saved === undefined) delete process.env.AIR_TEST_INHERITED; else process.env.AIR_TEST_INHERITED = saved;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test('regression: a caller without a UTF-8 locale still sees its jobs (tmux sanitises tabs for non-UTF-8 clients)', async () => {
    // The live Mac smoke run: the shell had no UTF-8 LC_ALL/LC_CTYPE/LANG, tmux printed list-panes with every
    // tab as `_`, no row parsed, and a live agent's window "was closed".
    const noLocale = { ...process.env, LANG: 'C', LC_ALL: '', LC_CTYPE: '' };
    const format = '#{@air_job}\t#{@air_nonce}\t#{window_id}';
    const plain = spawnSync('tmux', ['-L', socket, 'list-panes', '-a', '-F', format], { env: clientEnv(noLocale), encoding: 'utf8' });
    assert.equal(plain.status, 0, plain.stderr);
    assert.ok(plain.stdout.trim() && !plain.stdout.includes('\t'), `without -u, tmux replaces the tabs: ${JSON.stringify(plain.stdout)}`);

    const c = createTmux({ repo: 'o/requests', socket, run: defaultRunner(socket, noLocale) });
    await c.startJob({ issue: 77, cwd: dir, argv: ['sleep', '60'] });
    const jobs = (await c.listJobs()).filter((j) => j.issue === 77);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]!.dead, false);
    assert.deepEqual((await t.listJobs()).find((j) => j.issue === 77)?.nonce, jobs[0]!.nonce);
  });

  test("a job runs interactively in its workspace with the caller's environment and a task file", async () => {
    const out = join(dir, 'env.txt');
    const script = `{ env; echo "pwd=$(pwd)"; echo "arg=$1"; [ -t 0 ] && echo stdin=tty; } > ${out}.tmp; mv ${out}.tmp ${out}`;
    const task = 'fix the bug\n'.repeat(200_000); // ~2.4 MB: would be E2BIG in argv
    const id = await t.startJob({ issue: 11, cwd: dir, argv: ['/bin/sh', '-c', script, 'sh'], env: { AIR_EXTRA: 'yes' }, task });
    assert.match(id, /^@\d+$/);
    await until('env file', () => existsSync(out));
    const env = readFileSync(out, 'utf8');
    assert.match(env, /^AIR_TEST_INHERITED=from the volunteer$/m);
    assert.match(env, new RegExp(`^PATH=${process.env.PATH!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
    assert.match(env, new RegExp(`^HOME=${process.env.HOME}$`, 'm'));
    assert.match(env, /^AIR_EXTRA=yes$/m);
    // tmux's own pane variables, not the caller's
    assert.match(env, new RegExp(`^TMUX=.*/${socket},\\d+,\\d+$`, 'm'));
    assert.match(env, /^TERM=/m);
    assert.match(env, new RegExp(`^pwd=${dir}$`, 'm'));
    assert.match(env, new RegExp(`^arg=${TASK_INSTRUCTION.replace(/\./g, '\\.')}$`, 'm'));
    assert.match(env, /^stdin=tty$/m);
    assert.equal(readFileSync(join(dir, TASK_FILE), 'utf8'), task);
  });

  test('regression: argv words that look like tmux separators are passed literally, never run', async () => {
    // Reviewer PoC: a word `;` or ending in `;` used to end the respawn-pane command, so the rest ran as tmux commands.
    const marker = join(dir, 'injected'), out = join(dir, 'literal.txt');
    const tail = [';', 'run-shell', `touch ${marker}`, 'x;', 'run-shell', `touch ${marker}`, 'a\\;', '{', '}'];
    await t.startJob({ issue: 30, cwd: `${dir}`, argv: ['/bin/sh', '-c', `printf '<%s>\\n' "$@" > ${out}.tmp; mv ${out}.tmp ${out}`, 'sh', ...tail],
      env: { AIR_X: `v; run-shell 'touch ${marker}'`, AIR_Y: 'ends;' } });
    await until('job output', () => existsSync(out));
    await sleep(200); // give an injected run-shell time to act, were there one
    assert.equal(existsSync(marker), false);
    assert.equal(readFileSync(out, 'utf8'), tail.map(w => `<${w}>`).join('\n') + '\n');
    const windows = (await raw(['list-windows', '-t', '=air', '-F', '#{window_name}'])).stdout.trim().split('\n');
    assert.deepEqual(windows, ['log', '#30']);
  });

  test('ensureSession window 0 argv goes through a launcher too', async () => {
    const other = `${socket}-s0`, marker = join(dir, 'injected0'), out = join(dir, 'w0.txt');
    const t0 = createTmux({ repo: 'o/requests', socket: other });
    try {
      assert.equal(await t0.ensureSession({ argv: ['/bin/sh', '-c', `printf '%s|%s' "$1" "$AIR_W0" > ${out}`, 'sh', 'x;'], cwd: dir,
        env: { AIR_W0: `y; run-shell 'touch ${marker}'` } }), true);
      await until('window 0 output', () => existsSync(out));
      assert.equal(readFileSync(out, 'utf8'), `x;|y; run-shell 'touch ${marker}'`);
      assert.equal(existsSync(marker), false);
    } finally {
      spawnSync('tmux', ['-L', other, 'kill-server'], { stdio: 'ignore' });
      rmSync(socketPath(other), { force: true });
    }
  });

  test('tags, listing, and windows that are not ours', async () => {
    const id = await t.startJob({ issue: 42, cwd: dir, argv: ['sleep', '60'] });
    // The volunteer's own window, even one named like a job, and a split of our job window are ignored.
    assert.equal((await raw(['new-window', '-d', '-t', '=air:', '-n', '#42', 'sleep', '60'])).code, 0);
    assert.equal((await raw(['split-window', '-d', '-t', id, 'sleep', '60'])).code, 0);
    try {
      const jobs = await t.listJobs();
      assert.equal(jobs.length, 1);
      const [job] = jobs;
      assert.equal(job!.issue, 42);
      assert.equal(job!.windowId, id);
      assert.equal(job!.windowName, '#42');
      assert.equal(job!.dead, false);
      assert.ok(job!.pid > 0);
      assert.equal(await t.isAlive(42), true);
      await assert.rejects(t.startJob({ issue: 42, cwd: dir, argv: ['true'] }), /already/);
      await t.stopJob(42, { graceMs: 2000 });
      assert.equal(await t.isAlive(42), false);
      const left = await raw(['list-windows', '-t', '=air', '-F', '#{window_name}']);
      assert.deepEqual(left.stdout.trim().split('\n'), ['log', '#42']); // only the volunteer's window remains
    } finally {
      await raw(['kill-window', '-t', '=air:=#42']);
    }
  });

  test('two requests repos on one socket: each server sees and stops only its own job of the same issue number', async () => {
    const other = createTmux({ repo: 'o/other', socket });
    const ours = await t.startJob({ issue: 21, cwd: dir, argv: ['sleep', '60'] });
    const theirs = await other.startJob({ issue: 21, cwd: dir, argv: ['sleep', '60'] });
    assert.deepEqual((await t.listJobs()).filter(j => j.issue === 21).map(j => [j.windowId, j.repo]), [[ours, 'o/requests']]);
    assert.deepEqual((await other.listJobs()).filter(j => j.issue === 21).map(j => [j.windowId, j.repo]), [[theirs, 'o/other']]);
    await t.stopJob(21, { graceMs: 0 });
    assert.equal(await t.isAlive(21), false);
    assert.equal(await other.isAlive(21), true, "our stop left the other repo's job alone");
    await other.stopJob(21, { graceMs: 0 });
  });

  test('concurrent starts of one issue yield one window', async () => {
    const results = await Promise.allSettled([1, 2, 3].map(() => t.startJob({ issue: 13, cwd: dir, argv: ['sleep', '60'] })));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal((await t.listJobs()).filter(j => j.issue === 13).length, 1);
  });

  test('duplicates keep the oldest pane; leftover starting panes are killed, not adopted', async () => {
    const id = await t.startJob({ issue: 14, cwd: dir, argv: ['sleep', '60'] });
    const tag = async (issue: string, nonce: string, state: string) => {
      const r = await raw(['new-window', '-d', '-P', '-F', '#{window_id}', '-t', '=air:', 'sleep', '60']);
      const w = r.stdout.trim();
      assert.equal((await raw(['set-option', '-p', '-t', w, '@air_repo', 'o/requests', ';', 'set-option', '-p', '-t', w, '@air_job', issue, ';', 'set-option', '-p', '-t', w, '@air_nonce', nonce,
        ';', 'set-option', '-p', '-t', w, '@air_state', state])).code, 0);
      return w;
    };
    const dup = await tag('14', 'dupnonce', 'running');
    const stale = await tag('15', 'stalenonce', 'starting');
    const jobs = await t.listJobs();
    assert.deepEqual(jobs.map(j => j.issue), [14, 14]); // the stale placeholder is not a job
    assert.equal(await t.isAlive(14), true); // findJob resolves the duplicate
    const windows = (await raw(['list-windows', '-t', '=air', '-F', '#{window_id}'])).stdout.trim().split('\n');
    assert.ok(windows.includes(id));
    assert.ok(!windows.includes(dup));
    assert.ok(!windows.includes(stale));
    assert.deepEqual((await t.listJobs()).map(j => j.windowId), [id]);
  });

  test('exit status is readable after the pane dies, and capture works', async () => {
    await t.startJob({ issue: 7, cwd: dir, argv: ['/bin/sh', '-c', 'echo hello-from-job; exit 3'] });
    await until('pane death', async () => (await t.listJobs()).some(j => j.issue === 7 && j.dead));
    const job = (await t.listJobs()).find(j => j.issue === 7)!;
    assert.equal(job.exitStatus, 3);
    assert.equal(await t.isAlive(7), false);
    // remain-on-exit's "Pane is dead" line sits on the screen's last row, below blank rows. tmux draws it only
    // once it has reaped the child, which tmux < 3.6 with utempter may never do (the status file covers that).
    assert.match((await t.capture(7, 200))!, /hello-from-job/);
    const last = (await t.capture(7, 1))!;
    assert.ok(/^Pane is dead \(status 3/.test(last) || last === 'hello-from-job', last);
    assert.deepEqual(await t.stopJob(7), { exitStatus: 3 });
    assert.deepEqual(await t.listJobs(), []);
    assert.equal(await t.capture(7), null);
  });

  test('stop sends the interrupt and waits for a graceful exit', async () => {
    const ready = join(dir, 'trap-ready'), trapped = join(dir, 'trapped');
    await t.startJob({ issue: 8, cwd: dir, argv: ['/bin/sh', '-c', `trap 'touch ${trapped}; exit 0' INT; touch ${ready}; while :; do sleep 0.1; done`] });
    await until('trap installed', () => existsSync(ready));
    const r = await t.stopJob(8, { graceMs: 3000, keys: ['C-c'] });
    assert.ok(existsSync(trapped));
    assert.deepEqual(r, { exitStatus: 0 });
    assert.deepEqual(await t.listJobs(), []);
  });

  test('stop kills a job that ignores the interrupt', async () => {
    const ready = join(dir, 'ignore-ready');
    await t.startJob({ issue: 9, cwd: dir, argv: ['/bin/sh', '-c', `trap '' INT; touch ${ready}; while :; do sleep 0.1; done`] });
    await until('trap installed', () => existsSync(ready));
    const start = Date.now();
    assert.deepEqual(await t.stopJob(9, { graceMs: 300 }), { exitStatus: null });
    assert.ok(Date.now() - start >= 300);
    assert.deepEqual(await t.listJobs(), []);
  });

  // A job that ignores C-c, TERM and HUP: only KILL ends it. Its own pid goes to `pidfile`.
  async function stubborn(issue: number) {
    const pidfile = join(dir, `stubborn-${issue}`);
    await t.startJob({ issue, cwd: dir, argv: ['/bin/sh', '-c', `trap '' INT TERM HUP; echo $$ > ${pidfile}.tmp; mv ${pidfile}.tmp ${pidfile}; while :; do sleep 0.1; done`] });
    await until('job started', () => existsSync(pidfile));
    const job = (await t.listJobs()).find((j) => j.issue === issue)!;
    groups.add(job.panePid);
    return { job, shell: Number(readFileSync(pidfile, 'utf8')) };
  }

  test('the job records the agent\'s pid; the pane\'s pid leads its process group', async () => {
    const { job, shell } = await stubborn(31);
    assert.equal(job.pid, shell, 'Job.pid is the agent, not the launcher shell');
    assert.notEqual(job.panePid, job.pid);
    const pgid = Number(spawnSync('ps', ['-o', 'pgid=', '-p', String(job.pid)], { encoding: 'utf8' }).stdout.trim());
    assert.equal(pgid, job.panePid, "the agent runs in the launcher's process group");
  });

  test('regression: no process of a job survives stopJob, even one that ignores INT, TERM and HUP', async () => {
    const { job, shell } = await stubborn(32);
    await t.stopJob(32, { graceMs: 200 });
    await until('the job group is gone', () => running(job.panePid).length === 0, 3000);
    assert.ok(!running(job.panePid).includes(shell));
    assert.deepEqual(await t.listJobs(), []);
  });

  test('regression: no process of a job survives a raw tmux kill-window (the launcher reaps its group)', async () => {
    const { job, shell } = await stubborn(33);
    assert.equal((await raw(['kill-window', '-t', job.windowId])).code, 0);
    // The hangup only reaches the launcher shell; its reaper sends the group TERM, then KILL after REAP_GRACE_SECONDS.
    await until('the job group is gone', () => running(job.panePid).length === 0, (REAP_GRACE_SECONDS + 4) * 1000);
    assert.ok(!running(job.panePid).includes(shell));
  });

  test('attach targets the job window; switch-client moves a client to it', async () => {
    const a = await t.startJob({ issue: 20, cwd: dir, argv: ['sleep', '60'] });
    const b = await t.startJob({ issue: 21, cwd: dir, argv: ['sleep', '60'] });
    const argv = await t.attachArgs(20, {});
    assert.deepEqual(argv, ['tmux', '-L', socket, 'attach-session', '-t', a]);
    // A control-mode client runs the same attach command headless (-C added after the socket).
    const client = spawn('tmux', ['-L', socket, '-C', ...argv.slice(3)], { env: clientEnv(), stdio: ['pipe', 'ignore', 'ignore'] });
    try {
      const clients = async () => (await raw(['list-clients', '-F', '#{client_name} #{window_id}'])).stdout.trim().split('\n').filter(Boolean);
      await until('client attached', async () => (await clients()).length === 1);
      const [name, win] = (await clients())[0]!.split(' ');
      assert.equal(win, a);
      // Inside our server the argv is switch-client; with no calling terminal here, name the client with -c.
      const sw = await t.attachArgs(21, { TMUX: `${socketPath(socket)},1,0` });
      assert.deepEqual(sw, ['tmux', '-L', socket, 'switch-client', '-t', b]);
      assert.equal((await raw([sw[3]!, '-c', name!, ...sw.slice(4)])).code, 0);
      await until('client switched', async () => (await clients())[0]!.split(' ')[1] === b);
    } finally {
      client.stdin.end();
      client.kill();
    }
  });

  test('restart: a new wrapper re-adopts live jobs; a new tmux server has none', async () => {
    const id = await t.startJob({ issue: 100, cwd: dir, argv: ['sleep', '60'] });
    // Server process restart: throw the wrapper (and its locks) away and build a fresh one.
    t = createTmux({ repo: 'o/requests', socket });
    const [job] = await t.listJobs();
    assert.equal(job?.issue, 100);
    assert.equal(job?.windowId, id);
    assert.equal(await t.isAlive(100), true);
    assert.match(job!.nonce, /^[0-9a-f]{24}$/);
    // tmux server restart: jobs are gone, and concurrent ensureSession calls race safely.
    assert.equal((await raw(['kill-server'])).code, 0);
    t = createTmux({ repo: 'o/requests', socket });
    assert.deepEqual(await t.listJobs(), []);
    assert.equal(await t.isAlive(100), false);
    assert.equal(await t.capture(100), null);
    assert.equal(await t.stopJob(100), undefined);
    const created = await Promise.all([t.ensureSession(), createTmux({ repo: 'o/requests', socket }).ensureSession()]);
    assert.equal(created.filter(Boolean).length, 1);
    assert.deepEqual(await t.listJobs(), []);
  });
});
