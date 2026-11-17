import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTmux, parseJobs, quoteTmux, signalName, signalOf, tmuxVersionProblem, socketPath, TASK_FILE, TASK_INSTRUCTION, type RunResult } from './tmux.ts';
import { checkJob, clientEnv, jobEnv, SESSION_MARKERS } from './env.ts';
import { launcherPid, launcherStatus, shQuote, writeLauncher } from './launcher.ts';

const ws = mkdtempSync(join(tmpdir(), 'air-tmux-unit-'));
after(() => rmSync(ws, { recursive: true, force: true }));

const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });
const fail = (stderr: string): RunResult => ({ code: 1, stdout: '', stderr });

/** A scripted runner: each call is answered by the first matching handler. */
function fake(handlers: Array<[(args: string[]) => boolean, (args: string[]) => RunResult]>) {
  const calls: string[][] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    for (const [match, reply] of handlers) if (match(args)) return reply(args);
    return ok();
  };
  return { calls, run };
}
const is = (cmd: string) => (args: string[]) => args[0] === cmd;
const row = (...f: string[]) => f.join('\t');
const REPO = 'o/requests';
/** A list-panes row tagged `@air_repo` `repo` (the last column), the other columns as given. */
const tagged = (repo: string, ...f: string[]) => row(...f, ...Array<string>(11 - f.length).fill(''), repo);
const pane = (...f: string[]) => tagged(REPO, ...f);
/** Fake panes have made-up pids: signals go here, never to real process groups. Groups listed in `liveGroups` exist. */
const signals: Array<[number, NodeJS.Signals | 0]> = [];
const liveGroups = new Set<number>();
const noKill = (pid: number, sig: NodeJS.Signals | 0) => {
  signals.push([pid, sig]);
  if (!liveGroups.has(-pid)) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
  if (sig === 'SIGTERM') liveGroups.delete(-pid); // the group dies of it
};
/** A list-panes row for a running job pane. */
const jobRow = (issue: string, nonce: string, w: string, p: string, dead = '0', status = '') =>
  pane(issue, nonce, w, p, `#${issue}`, '1', dead, status, 'running');

describe('env', () => {
  test('jobEnv passes the whole environment through, with the extras on top', () => {
    const base = { PATH: '/bin', HOME: '/h', GH_TOKEN: 'x', HTTPS_PROXY: 'http://p', CODEX_HOME: '/c', AIR_OUT: '/old', TMUX: '/other,1,0', TMUX_PANE: '%9' };
    assert.deepEqual(jobEnv({ FOO: 'bar', AIR_OUT: '/w/out' }, base), { PATH: '/bin', HOME: '/h', GH_TOKEN: 'x', HTTPS_PROXY: 'http://p', CODEX_HOME: '/c', AIR_OUT: '/w/out', FOO: 'bar' });
    assert.throws(() => jobEnv({ 'A B': 'x' }, {}), /bad environment variable/);
  });

  test('jobEnv drops the markers of a parent Claude Code or Codex session, and only those', () => {
    const markers = Object.fromEntries(SESSION_MARKERS.map((n) => [n, '1']));
    const base = { ...markers, PATH: '/bin', CLAUDE_CONFIG_DIR: '/c', CLAUDE_CODE_USE_BEDROCK: '1', CODEX_HOME: '/x', ANTHROPIC_API_KEY: 'k' };
    assert.deepEqual(jobEnv({}, base), { PATH: '/bin', CLAUDE_CONFIG_DIR: '/c', CLAUDE_CODE_USE_BEDROCK: '1', CODEX_HOME: '/x', ANTHROPIC_API_KEY: 'k' });
    for (const n of ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_THREAD_ID', 'CODEX_SANDBOX']) assert.ok(SESSION_MARKERS.includes(n), n);
  });
  test('checkJob rejects bad argv', () => {
    checkJob(['claude', '--x']);
    assert.throws(() => checkJob(['A=b']), /may not contain/);
    assert.throws(() => checkJob([]), /empty/);
  });

  test('launcher runs exactly the given argv with the given env added to the inherited one, from cwd', () => {
    const weird = [`it's`, ';', 'x;', 'a\\;', '$(touch /nope)', '`id`', '{', '"q"', 'new\nline', ''];
    const l = writeLauncher({ argv: ['/bin/sh', '-c', 'pwd; env; printf "<%s>\\n" "$@"', 'sh', ...weird], env: { PATH: '/usr/bin:/bin', FOO: `b'ar;` }, cwd: ws });
    assert.equal(l.argv[0], '/bin/sh');
    assert.ok(!l.argv[1]!.endsWith(';'));
    const r = spawnSync(l.argv[0]!, l.argv.slice(1), { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', INHERITED: 'yes', FOO: 'old' } });
    const out = r.stdout.split('\n');
    assert.equal(realpathSync(out[0]!), realpathSync(ws)); // macOS: /var is /private/var
    assert.ok(out.includes(`FOO=b'ar;`));
    assert.ok(!out.includes('FOO=old'));
    assert.ok(out.includes('INHERITED=yes'));
    assert.ok(r.stdout.endsWith(weird.map(w => `<${w}>`).join('\n') + '\n'));
    assert.ok(!existsSync(l.argv[1]!), 'launcher deletes itself');
    assert.equal(shQuote(`a'b`), `'a'\\''b'`);
  });
  test('clientEnv drops secrets', () => {
    assert.deepEqual(clientEnv({ PATH: '/bin', GH_TOKEN: 'x', TMUX: '/s,1,0' }), { PATH: '/bin' });
  });
});

describe('tmux (fake runner)', () => {
  test('parseJobs keeps only tagged panes', () => {
    const jobs = parseJobs([
      row('', '', '@0', '%0', 'log', '10', '0', '', ''),
      pane('42', 'abc', '@1', '%1', '#42', '11', '0', '', 'running'),
      pane('7', 'def', '@2', '%2', '#7', '12', '1', '3', 'running'),
      pane('8', 'ghi', '@3', '%3', 'air-new-ghi', '13', '0', '', 'starting'),
    ].join('\n'));
    assert.deepEqual(jobs, [
      { repo: REPO, issue: 42, nonce: 'abc', windowId: '@1', paneId: '%1', windowName: '#42', pid: 11, panePid: 11, dead: false, exitStatus: null, exitSignal: null },
      { repo: REPO, issue: 7, nonce: 'def', windowId: '@2', paneId: '%2', windowName: '#7', pid: 12, panePid: 12, dead: true, exitStatus: 3, exitSignal: null },
    ]);
  });

  test('a status launcher records the exit status, also of a child killed by C-c', async () => {
    const l = writeLauncher({ argv: ['/bin/sh', '-c', 'exit 3'], cwd: ws, status: true });
    const r = spawnSync(l.argv[0]!, l.argv.slice(1), { encoding: 'utf8' });
    assert.equal(r.status, 3);
    assert.ok(!existsSync(l.argv[1]!), 'the script deletes itself');
    assert.equal(launcherStatus(l.dir), 3);
    l.cleanup();
    assert.equal(launcherStatus(l.dir), null);

    // C-c reaches the whole foreground process group: the agent dies of it, the launcher outlives it.
    const m = writeLauncher({ argv: ['sleep', '30'], env: { PATH: process.env.PATH ?? '/usr/bin:/bin' }, status: true });
    const child = spawn(m.argv[0]!, m.argv.slice(1), { detached: true, stdio: 'ignore' });
    const exited = new Promise<number | null>((res) => child.on('exit', (code) => res(code)));
    await sleep(300);
    process.kill(-child.pid!, 'SIGINT');
    assert.equal(await exited, 130);
    assert.equal(launcherStatus(m.dir), 130);
    const agent = launcherPid(m.dir);
    assert.ok(agent && agent !== child.pid, 'the pid file holds the agent, not the launcher');
    m.cleanup();

    assert.equal(launcherStatus('/etc'), null, 'only our own launcher dirs are read');
  });

  test('regression: a dead pane tmux never reaped (tmux < 3.6 with utempter) is dead with the launcher status', () => {
    const statusOf = (dir: string | undefined) => (dir === '/tmp/air-launch-x' ? 0 : null);
    const [reaped, unreaped, unknown] = parseJobs([
      row('7', 'a', '@2', '%2', '#7', '12', '1', '4', 'running', '/tmp/air-launch-x', ''),
      row('8', 'b', '@3', '%3', '#8', '13', '1', '', 'running', '/tmp/air-launch-x', ''),
      row('9', 'c', '@4', '%4', '#9', '14', '1', '', 'running', '/tmp/air-launch-y', ''),
    ].join('\n'), statusOf);
    assert.deepEqual([reaped!.dead, reaped!.exitStatus], [true, 4], "tmux's own status wins");
    assert.deepEqual([unreaped!.dead, unreaped!.exitStatus], [true, 0]);
    assert.deepEqual([unknown!.dead, unknown!.exitStatus], [false, null]);
  });

  test('tmux versions: 3.0 and newer are fine, older ones are refused with a clear message', async () => {
    for (const ok of ['tmux 3.0', 'tmux 3.0a', 'tmux 3.4', 'tmux 3.8', 'tmux 10.1', 'tmux next-3.6', 'tmux openbsd-7.5', 'tmux master'])
      assert.equal(tmuxVersionProblem(ok), undefined, ok);
    for (const old of ['tmux 2.9a', 'tmux 2.6', 'tmux 1.8'])
      assert.match(tmuxVersionProblem(old)!, new RegExp(`^${old} is too old: air needs tmux 3\\.0 or newer`));
    const old = createTmux({ repo: REPO, kill: noKill, run: async (a) => (a[0] === '-V' ? ok('tmux 2.9a\n') : fail('unexpected')) });
    await assert.rejects(old.checkVersion(), /tmux 2\.9a is too old/);
    const missing = createTmux({ repo: REPO, kill: noKill, run: async () => { throw Object.assign(new Error('spawn tmux ENOENT'), { code: 'ENOENT' }); } });
    await assert.rejects(missing.checkVersion(), /tmux is not usable: spawn tmux ENOENT\. air needs tmux 3\.0 or newer/);
    assert.equal(await createTmux({ repo: REPO, kill: noKill, run: async () => ok('tmux 3.4\n') }).checkVersion(), 'tmux 3.4');
  });

  test('Job.pid is the agent from the pid file; panePid stays the pane', () => {
    const [a, b] = parseJobs([row('1', 'n', '@1', '%1', '#1', '500', '0', '', 'running', '/tmp/air-launch-p'), row('2', 'm', '@2', '%2', '#2', '600', '0', '', 'running', '')].join('\n'),
      () => null, (dir) => (dir === '/tmp/air-launch-p' ? 501 : null));
    assert.deepEqual([a!.pid, a!.panePid, b!.pid, b!.panePid], [501, 500, 600, 600]);
  });

  test('signalOf reads sh\'s 128 + N convention', () => {
    assert.deepEqual([signalOf(130), signalOf(137), signalOf(143), signalOf(128), signalOf(3), signalOf(null), signalOf(200)], [2, 9, 15, null, null, null, null]);
    assert.equal(signalName(2), 'SIGINT');
  });

  test('pane_dead_signal may be a name (macOS, BSDs) or a number (Linux)', () => {
    const jobs = parseJobs(['int', 'KILL', 'SIGTERM', '9', 'bogus'].map((sig, i) => row(String(i + 1), 'n', '@1', `%${i}`, '#1', '1', '1', '', 'running', '', sig)).join('\n'), () => null);
    assert.deepEqual(jobs.map((j) => [j.dead, j.exitSignal]), [[true, 2], [true, 9], [true, 15], [true, 9], [false, null]]);
  });

  test('regression: a pane whose pty closed before tmux reaped it is not dead yet', () => {
    // tmux sets pane_dead when the pty closes, but pane_dead_status/_signal only once it has reaped the child.
    // Reading "dead, no status" as an exit gave flaky null exit statuses (seen on CI under bun).
    const [exiting, signalled] = parseJobs([
      row('7', 'def', '@2', '%2', '#7', '12', '1', '', 'running', '', ''),
      row('8', 'ghi', '@3', '%3', '#8', '13', '1', '', 'running', '', '9'),
    ].join('\n'));
    assert.equal(exiting!.dead, false);
    assert.equal(exiting!.exitStatus, null);
    assert.deepEqual([signalled!.dead, signalled!.exitStatus, signalled!.exitSignal], [true, null, 9]);
  });

  test('regression: sanitised list-panes output (tabs as `_`) is an error, not "no jobs"', async () => {
    assert.throws(() => parseJobs('42_abc_@1_%1_#42_11_0__running__\n'), /unparseable row .*is the tmux client UTF-8/);
    const { run } = fake([[is('list-panes'), () => ok('__@0_%0_log_10_0____\n42_abc_@1_%1_#42_11_0__running__\n')]]);
    await assert.rejects(createTmux({ repo: REPO, kill: noKill, run }).listJobs(), /unparseable row/);
  });

  test('a socket air cannot connect to for another reason is an error, not "no server"', async () => {
    const { run } = fake([[is('list-panes'), () => fail('error connecting to /very/long/path/tmux-501/air (File name too long)')]]);
    await assert.rejects(createTmux({ repo: REPO, kill: noKill, run }).listJobs(), /File name too long/);
    const gone = fake([[is('list-panes'), () => fail('error connecting to /tmp/tmux-501/air (No such file or directory)')]]);
    assert.deepEqual(await createTmux({ repo: REPO, kill: noKill, run: gone.run }).listJobs(), []);
  });

  test('listJobs is empty without a server', async () => {
    const { run } = fake([[is('list-panes'), () => fail('no server running on /tmp/tmux-1/air')]]);
    assert.deepEqual(await createTmux({ repo: REPO, kill: noKill, run }).listJobs(), []);
  });

  test('ensureSession creates the session only when missing', async () => {
    const f = fake([[is('has-session'), () => fail("can't find session: air")]]);
    assert.equal(await createTmux({ repo: REPO, kill: noKill, run: f.run }).ensureSession({ argv: ['air', 'serve'] }), true);
    const ns = f.calls[1]!;
    assert.deepEqual(ns.slice(0, 8), ['new-session', '-d', '-s', 'air', '-n', 'log', '--', '/bin/sh']);
    assert.equal(ns.length, 9); // `air serve` runs through a launcher, not on the tmux command line
    const script = readFileSync(ns[8]!, 'utf8');
    rmSync(join(ns[8]!, '..'), { recursive: true });
    assert.match(script, /exec 'env' 'air' 'serve'/);
    const g = fake([]);
    assert.equal(await createTmux({ repo: REPO, kill: noKill, run: g.run }).ensureSession(), false);
    assert.equal(g.calls.length, 1);
  });

  test('ensureSession treats a lost creation race as success', async () => {
    const f = fake([[is('has-session'), () => fail("can't find session: air")], [is('new-session'), () => fail('duplicate session: air')]]);
    assert.equal(await createTmux({ repo: REPO, kill: noKill, run: f.run }).ensureSession(), false);
    const g = fake([[is('has-session'), () => fail("can't find session: air")], [is('new-session'), () => fail('boom')]]);
    await assert.rejects(createTmux({ repo: REPO, kill: noKill, run: g.run }).ensureSession(), /boom/);
  });

  test('regression: a server still exiting after kill-server means no jobs, and a new session waits for it', async () => {
    // Seen on CI: the client connected to a server that kill-server had told to exit.
    const gone = fail('server exited unexpectedly');
    assert.deepEqual(await createTmux({ repo: REPO, kill: noKill, run: fake([[is('list-panes'), () => gone]]).run }).listJobs(), []);
    let tries = 0;
    const f = fake([[is('has-session'), () => gone], [is('new-session'), () => (++tries < 3 ? gone : ok())]]);
    assert.equal(await createTmux({ repo: REPO, kill: noKill, run: f.run }).ensureSession(), true);
    assert.equal(tries, 3);
  });

  test('listJobs kills panes left in starting and never adopts them', async () => {
    const f = fake([
      [is('list-panes'), () => ok([jobRow('1', 'a', '@1', '%1'), pane('2', 'b', '@2', '%2', 'air-new-b', '5', '0', '', 'starting')].join('\n'))],
      [is('if-shell'), () => ok('air-ok\n')],
    ]);
    const jobs = await createTmux({ repo: REPO, kill: noKill, run: f.run }).listJobs();
    assert.deepEqual(jobs.map(j => j.issue), [1]);
    const kills = f.calls.filter(c => c[0] === 'if-shell' && /kill-window/.test(c[5]!));
    assert.equal(kills.length, 1);
    assert.deepEqual(kills[0]!.slice(3, 5), ['%2', '#{==:#{@air_nonce},b}']);
    assert.match(kills[0]![5]!, /'kill-window' '-t' '@2'/);
  });

  test('@air_repo: a server sees, adopts and stops only its own repo\'s jobs on a shared socket', async () => {
    // Issue 5 of o/requests (ours), issue 5 of o/other, and an untagged job pane: only ours counts.
    const f = fake([
      [is('list-panes'), () => ok([
        tagged('o/other', '5', 'theirs', '@1', '%1', '#5', '11', '0', '', 'running'),
        tagged('', '5', 'untagged', '@2', '%2', '#5', '12', '0', '', 'running'),
        pane('5', 'ours', '@3', '%3', '#5', '13', '0', '', 'running'),
        tagged('o/other', '6', 'theirs-starting', '@4', '%4', 'air-new-x', '14', '0', '', 'starting'),
      ].join('\n'))],
      [is('if-shell'), () => ok('air-ok\n')],
    ]);
    const t = createTmux({ repo: REPO, kill: noKill, run: f.run });
    assert.deepEqual((await t.listJobs()).map(j => j.nonce), ['ours']);
    // findJob keeps the oldest of an issue's panes and kills the rest: never another repo's (or an untagged) one.
    assert.equal(await t.isAlive(5), true);
    assert.deepEqual((await t.attachArgs(5, {})).at(-1), '@3');
    await t.stopJob(5, { graceMs: 0, keys: [] });
    const touched = f.calls.filter(c => c[0] === 'if-shell').map(c => c[3]);
    assert.ok(touched.length > 0 && touched.every(p => p === '%3'), touched.join(' '));
    // The other repo's server sees its own job for the same issue number, not ours.
    const other = createTmux({ repo: 'o/other', kill: noKill, run: f.run });
    assert.deepEqual((await other.listJobs()).map(j => j.nonce), ['theirs']);
    assert.throws(() => createTmux({ repo: 'o/x; kill-server', kill: noKill, run: f.run }), /bad repo/);
  });

  test('duplicate panes for an issue: keep the oldest, kill the rest', async () => {
    const f = fake([
      [is('list-panes'), () => ok([jobRow('5', 'new', '@9', '%10'), jobRow('5', 'old', '@3', '%3')].join('\n'))],
      [is('if-shell'), () => ok('air-ok\n')],
    ]);
    assert.equal(await createTmux({ repo: REPO, kill: noKill, run: f.run }).isAlive(5), true);
    const kills = f.calls.filter(c => c[0] === 'if-shell' && /kill-window/.test(c[5]!));
    assert.equal(kills.length, 1);
    assert.equal(kills[0]![3], '%10');
  });

  test('capture returns exactly the last lines, with a default for bad counts', async () => {
    const screen = ['h1', 'h2', 'a', 'b', 'c', '', '', ''].join('\n') + '\n';
    const f = fake([[is('list-panes'), () => ok(jobRow('5', 'n', '@3', '%3'))], [is('capture-pane'), () => ok(screen)]]);
    const t = createTmux({ repo: REPO, kill: noKill, run: f.run });
    assert.equal(await t.capture(5, 2), 'b\nc');
    assert.equal(await t.capture(5, 2.7), 'b\nc');
    for (const bad of [0, -3, NaN, Infinity, 0.5]) {
      assert.equal(await t.capture(5, bad), 'h1\nh2\na\nb\nc');
      assert.equal(f.calls.at(-1)!.at(-1), '-50');
    }
  });

  test('capture returns null when the pane vanishes after lookup', async () => {
    const f = fake([[is('list-panes'), () => ok(jobRow('5', 'n', '@3', '%3'))], [is('capture-pane'), () => fail("can't find pane: %3")]]);
    assert.equal(await createTmux({ repo: REPO, kill: noKill, run: f.run }).capture(5), null);
    const g = fake([[is('list-panes'), () => ok(jobRow('5', 'n', '@3', '%3'))], [is('capture-pane'), () => fail('no server running on /tmp/x')]]);
    assert.equal(await createTmux({ repo: REPO, kill: noKill, run: g.run }).capture(5), null);
  });

  test('stopJob tolerates the pane vanishing mid-stop', async () => {
    let lists = 0;
    const f = fake([
      [is('list-panes'), () => ++lists === 1 ? ok(jobRow('5', 'n', '@3', '%3')) : fail('no server running on /tmp/x')],
      [is('if-shell'), () => fail("can't find pane: %3")],
    ]);
    assert.deepEqual(await createTmux({ repo: REPO, kill: noKill, run: f.run }).stopJob(5, { graceMs: 10 }), { exitStatus: null });
  });

  test('startJob tags and respawns in one tmux invocation', async () => {
    const f = fake([
      [is('list-panes'), () => ok('')],
      [is('show-options'), () => ok('tmux-256color\n')],
      [is('new-window'), () => ok('@3 %5\n')],
    ]);
    const id = await createTmux({ repo: REPO, kill: noKill, run: f.run }).startJob({ issue: 42, cwd: ws, argv: ['claude'], env: { FOO: '1' }, task: 'x'.repeat(1_000_000) });
    assert.equal(id, '@3');
    assert.deepEqual(f.calls.map(c => c[0]), ['list-panes', 'has-session', 'show-options', 'new-window']);
    const chain = f.calls[3]!;
    const cmds = chain.join(' ').split(' ; ').map(c => c.split(' ').slice(0, 1)[0]);
    assert.deepEqual(cmds, ['new-window', 'set-option', 'set-option', 'set-option', 'set-option', 'set-option', 'set-option', 'set-option', 'set-option',
      'respawn-pane', 'set-option', 'rename-window']);
    const text = chain.join(' ');
    const tmp = chain[chain.indexOf('-n') + 1]!;
    assert.match(tmp, /^air-new-[0-9a-f]{24}$/);
    // Every command after new-window targets the new window by its exact temporary name, never the current pane.
    for (const part of text.split(' ; ').slice(1)) assert.ok(part.includes(`-t =air:=${tmp}`), part);
    assert.ok(text.indexOf('@air_state starting') < text.indexOf('respawn-pane'));
    assert.ok(text.indexOf('respawn-pane') < text.indexOf('@air_state running'));
    assert.match(text, /@air_job 42/);
    assert.match(text, /@air_repo o\/requests ;/);
    assert.ok(text.indexOf('@air_repo') < text.indexOf('@air_state starting'), 'tagged with its repo before anyone can see it');
    assert.match(text, /remain-on-exit on/);
    assert.ok(chain.includes('#42'));
    // tmux runs only the fixed launcher; argv, env and cwd are inside it, never on the tmux command line.
    const respawn = chain.slice(chain.indexOf('respawn-pane'));
    const argv = respawn.slice(respawn.indexOf('--') + 1, respawn.indexOf(';'));
    assert.equal(argv.length, 2);
    assert.equal(argv[0], '/bin/sh');
    assert.ok(!chain.includes('claude') && !chain.includes(ws) && !chain.some(w => w.startsWith('FOO=')));
    const script = readFileSync(argv[1]!, 'utf8');
    rmSync(join(argv[1]!, '..'), { recursive: true });
    // Run as a child (in the foreground), behind a tiny sh that records its pid, so the launcher can record its exit status.
    // The script holds the caller's whole environment: check it without printing it.
    const has = (re: RegExp, what: string) => assert.ok(re.test(script), `the launcher has ${what}`);
    has(/^'\/bin\/sh' '-c' 'printf "%s\\n" "\$\$" > "\$1"; shift; exec "\$@"' 'air-agent' '[^']+\/pid' 'env' '(?!-i')[^\n]* 'claude' '[^']+' 9>&-$/m, 'the agent line');
    has(/^trap : INT QUIT TERM$/m, 'the trap'); // not HUP: a hangup must kill the launcher, so its reaper runs
    has(/^air_exit "\$\?"$/m, 'air_exit');
    assert.ok(script.includes(`'FOO=1'`) && script.includes(`'TERM=tmux-256color'`) && script.includes(`'HOME=${process.env.HOME}'`), 'the launcher sets the env');
    assert.ok(script.includes(`cd -- '${ws}'`));
    assert.ok(script.includes(`'claude' '${TASK_INSTRUCTION}'`));
    // The task lives in the workspace, not in argv.
    assert.equal(readFileSync(join(ws, TASK_FILE), 'utf8').length, 1_000_000);
    assert.ok(text.length < 10_000);
  });

  test('startJob: separator-like argv words never reach the tmux command line', async () => {
    const f = fake([[is('list-panes'), () => ok('')], [is('new-window'), () => ok('@3 %5\n')]]);
    await createTmux({ repo: REPO, kill: noKill, run: f.run }).startJob({ issue: 3, cwd: ws, argv: ['sh', '-c', 'true', ';', 'run-shell', 'touch /x', 'y;', '{', '}'], env: { A: 'b;' } });
    const chain = f.calls.find(c => c[0] === 'new-window')!;
    // Every separator is one of ours: exactly one between each command, and no other word ends in `;`.
    assert.equal(chain.filter(w => w === ';').length, 11);
    assert.ok(!chain.some(w => w !== ';' && w.endsWith(';')));
    assert.ok(!chain.includes('run-shell'));
    const script = chain[chain.indexOf('/bin/sh') + 1]!;
    rmSync(join(script, '..'), { recursive: true });
  });

  test('startJob refuses a second window for the same issue', async () => {
    const { run } = fake([[is('list-panes'), () => ok(jobRow('42', 'n', '@1', '%1'))]]);
    await assert.rejects(createTmux({ repo: REPO, kill: noKill, run }).startJob({ issue: 42, cwd: ws, argv: ['x'] }), /already has a window/);
  });

  test('startJob refuses a missing workspace', async () => {
    const { run } = fake([]);
    await assert.rejects(createTmux({ repo: REPO, kill: noKill, run }).startJob({ issue: 1, cwd: join(ws, 'nope'), argv: ['x'] }), /not a directory/);
  });

  test('startJob kills its window when the chain fails part way', async () => {
    const f = fake([
      [is('list-panes'), () => ok('')],
      [is('new-window'), () => ({ code: 1, stdout: '@3 %5\n', stderr: 'boom' })],
    ]);
    await assert.rejects(createTmux({ repo: REPO, kill: noKill, run: f.run }).startJob({ issue: 1, cwd: ws, argv: ['x'] }), /boom/);
    const last = f.calls.at(-1)!;
    assert.equal(last[0], 'if-shell');
    assert.match(last[5]!, /'kill-window' '-t' '@3'/);
  });

  test('concurrent starts of one issue are serialized', async () => {
    let created = false, active = 0, maxActive = 0;
    const f = fake([
      [is('list-panes'), () => ok(created ? jobRow('42', 'n', '@3', '%5') : '')],
      [is('new-window'), () => { created = true; return ok('@3 %5\n'); }],
    ]);
    const run = async (args: string[]) => {
      active++; maxActive = Math.max(maxActive, active);
      await new Promise(r => setTimeout(r, 5));
      try { return await f.run(args); } finally { active--; }
    };
    const t = createTmux({ repo: REPO, kill: noKill, run });
    const results = await Promise.allSettled([1, 2, 3].map(() => t.startJob({ issue: 42, cwd: ws, argv: ['x'] })));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(results.filter(r => r.status === 'rejected').length, 2);
    assert.equal(f.calls.filter(c => c[0] === 'new-window').length, 1);
    assert.equal(maxActive, 1);
    const chain = f.calls.find(c => c[0] === 'new-window')!;
    rmSync(join(chain[chain.indexOf('/bin/sh') + 1]!, '..'), { recursive: true }); // the launcher never ran
  });

  test('stopJob guards every write with the nonce, and signals the job group before it kills the window', async () => {
    const order: string[] = [];
    const f = fake([
      [is('list-panes'), () => ok(pane('42', 'n0nce', '@1', '%1', '#42', '4242', '0', '', 'running'))],
      [is('if-shell'), (a) => { if (/kill-window/.test(a[5]!)) order.push('kill-window'); return ok('air-ok\n'); }],
    ]);
    liveGroups.add(4242);
    const r = await createTmux({ repo: REPO, kill: (pid, sig) => { if (sig) order.push(`${sig} ${pid}`); noKill(pid, sig); }, run: f.run }).stopJob(42, { graceMs: 50, keys: ['C-c'] });
    assert.deepEqual(r, { exitStatus: null });
    const guards = f.calls.filter(c => c[0] === 'if-shell');
    assert.equal(guards.length, 3);
    for (const g of guards) assert.deepEqual(g.slice(0, 5), ['if-shell', '-F', '-t', '%1', '#{==:#{@air_nonce},n0nce}']);
    assert.match(guards[0]![5]!, /send-keys/);
    assert.match(guards[1]![5]!, /'display-message' '-p' ''/); // ownership, before any signal
    assert.match(guards[2]![5]!, /'kill-window' '-t' '@1'/);
    assert.deepEqual(order, ['SIGTERM -4242', 'SIGKILL -4242', 'kill-window']);
  });

  test('no signal for a pane that is not ours any more', async () => {
    const f = fake([[is('list-panes'), () => ok(pane('42', 'n', '@1', '%1', '#42', '4243', '1', '0', 'running'))], [is('if-shell'), () => ok('')]]);
    liveGroups.add(4243);
    signals.length = 0;
    await createTmux({ repo: REPO, kill: noKill, run: f.run }).stopJob(42);
    assert.deepEqual(signals, [], 'the nonce check failed: no signal, no kill');
    liveGroups.delete(4243);
  });

  test('stopJob of an unknown job is undefined', async () => {
    const { run } = fake([[is('list-panes'), () => ok('')]]);
    assert.equal(await createTmux({ repo: REPO, kill: noKill, run }).stopJob(9), undefined);
  });

  test('attachArgs targets the window itself and checks the full socket path', async () => {
    const { run } = fake([[is('list-panes'), () => ok(jobRow('42', 'n', '@4', '%4'))]]);
    const t = createTmux({ repo: REPO, kill: noKill, run });
    const ours = socketPath('air', { TMUX_TMPDIR: '/tt' });
    assert.equal(ours, `/tt/tmux-${process.getuid!()}/air`);
    assert.deepEqual(await t.attachArgs(undefined, {}), ['tmux', '-L', 'air', 'attach-session', '-t', '=air']);
    assert.deepEqual(await t.attachArgs(42, {}), ['tmux', '-L', 'air', 'attach-session', '-t', '@4']);
    assert.deepEqual(await t.attachArgs(42, { TMUX_TMPDIR: '/tt', TMUX: `${ours},123,0` }), ['tmux', '-L', 'air', 'switch-client', '-t', '@4']);
    // Same basename on another tmux directory is a different server.
    assert.deepEqual(await t.attachArgs(42, { TMUX_TMPDIR: '/tt', TMUX: '/other/tmux-1/air,123,0' }),
      ['env', '-u', 'TMUX', 'tmux', '-L', 'air', 'attach-session', '-t', '@4']);
    assert.deepEqual((await t.attachArgs(42, { TMUX: '/tmp/tmux-1/default,123,0' })).slice(0, 4), ['env', '-u', 'TMUX', 'tmux']);
    await assert.rejects(t.attachArgs(7, {}), /no window/);
  });

  test('quoteTmux escapes single quotes', () => {
    assert.equal(quoteTmux(`a'b`), `'a'\\''b'`);
  });
});
