import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTmux, parseJobs, quoteTmux, socketPath, TASK_FILE, TASK_INSTRUCTION, type RunResult } from './tmux.ts';
import { checkJob, clientEnv, jobEnv } from './env.ts';
import { shQuote, writeLauncher } from './launcher.ts';

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
/** A list-panes row for a running job pane. */
const jobRow = (issue: string, nonce: string, w: string, p: string, dead = '0', status = '') =>
  row(issue, nonce, w, p, `#${issue}`, '1', dead, status, 'running');

describe('env', () => {
  test('jobEnv keeps only the allowlist and refuses secrets', () => {
    const env = jobEnv({ FOO: 'bar' }, { PATH: '/bin', HOME: '/h', GH_TOKEN: 'x', AWS_SECRET_ACCESS_KEY: 'y', SSH_AUTH_SOCK: 's', CODEX_HOME: '/c' });
    assert.deepEqual(env, { PATH: '/bin', HOME: '/h', CODEX_HOME: '/c', FOO: 'bar' });
    assert.throws(() => jobEnv({ GH_TOKEN: 'x' }, {}), /refusing to pass GH_TOKEN/);
    assert.throws(() => jobEnv({ GITHUB_TOKEN: 'x' }, {}), /refusing/);
    assert.throws(() => jobEnv({ 'A B': 'x' }, {}), /bad environment variable/);
    assert.throws(() => jobEnv({ BASH_ENV: '/x' }, {}), /refusing/);
    assert.throws(() => jobEnv({ ENV: '/x' }, {}), /refusing/);
    assert.deepEqual(jobEnv({}, { HOME: '/h', BASH_ENV: '/x', ENV: '/y' }), { HOME: '/h' });
  });
  test('checkJob rejects bad argv and denied variables', () => {
    checkJob(['claude', '--x'], { PATH: '/bin' });
    assert.throws(() => checkJob(['x'], { BASH_ENV: '/x' }), /refusing/);
    assert.throws(() => checkJob(['A=b'], {}), /may not contain/);
    assert.throws(() => checkJob([], {}), /empty/);
  });

  test('launcher runs exactly the given argv with exactly the given env, from cwd', () => {
    const weird = [`it's`, ';', 'x;', 'a\\;', '$(touch /nope)', '`id`', '{', '"q"', 'new\nline', ''];
    const l = writeLauncher({ argv: ['/bin/sh', '-c', 'pwd; env; printf "<%s>\\n" "$@"', 'sh', ...weird], env: { PATH: '/usr/bin:/bin', FOO: `b'ar;` }, cwd: ws, clearEnv: true });
    assert.equal(l.argv[0], '/bin/sh');
    assert.ok(!l.argv[1]!.endsWith(';'));
    const r = spawnSync(l.argv[0]!, l.argv.slice(1), { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', GH_TOKEN: 'leak' } });
    const out = r.stdout.split('\n');
    assert.equal(out[0], ws);
    assert.ok(out.includes(`FOO=b'ar;`));
    assert.ok(!r.stdout.includes('GH_TOKEN'));
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
      row('42', 'abc', '@1', '%1', '#42', '11', '0', '', 'running'),
      row('7', 'def', '@2', '%2', '#7', '12', '1', '3', 'running'),
      row('8', 'ghi', '@3', '%3', 'air-new-ghi', '13', '0', '', 'starting'),
    ].join('\n'));
    assert.deepEqual(jobs, [
      { issue: 42, nonce: 'abc', windowId: '@1', paneId: '%1', windowName: '#42', pid: 11, dead: false, exitStatus: null, exitSignal: null },
      { issue: 7, nonce: 'def', windowId: '@2', paneId: '%2', windowName: '#7', pid: 12, dead: true, exitStatus: 3, exitSignal: null },
    ]);
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

  test('listJobs is empty without a server', async () => {
    const { run } = fake([[is('list-panes'), () => fail('no server running on /tmp/tmux-1/air')]]);
    assert.deepEqual(await createTmux({ run }).listJobs(), []);
  });

  test('ensureSession creates the session only when missing', async () => {
    const f = fake([[is('has-session'), () => fail("can't find session: air")]]);
    assert.equal(await createTmux({ run: f.run }).ensureSession({ argv: ['air', 'serve'] }), true);
    const ns = f.calls[1]!;
    assert.deepEqual(ns.slice(0, 8), ['new-session', '-d', '-s', 'air', '-n', 'log', '--', '/bin/sh']);
    assert.equal(ns.length, 9); // `air serve` runs through a launcher, not on the tmux command line
    const script = readFileSync(ns[8]!, 'utf8');
    rmSync(join(ns[8]!, '..'), { recursive: true });
    assert.match(script, /exec 'env' 'air' 'serve'/);
    const g = fake([]);
    assert.equal(await createTmux({ run: g.run }).ensureSession(), false);
    assert.equal(g.calls.length, 1);
  });

  test('ensureSession treats a lost creation race as success', async () => {
    const f = fake([[is('has-session'), () => fail("can't find session: air")], [is('new-session'), () => fail('duplicate session: air')]]);
    assert.equal(await createTmux({ run: f.run }).ensureSession(), false);
    const g = fake([[is('has-session'), () => fail("can't find session: air")], [is('new-session'), () => fail('boom')]]);
    await assert.rejects(createTmux({ run: g.run }).ensureSession(), /boom/);
  });

  test('regression: a server still exiting after kill-server means no jobs, and a new session waits for it', async () => {
    // Seen on CI: the client connected to a server that kill-server had told to exit.
    const gone = fail('server exited unexpectedly');
    assert.deepEqual(await createTmux({ run: fake([[is('list-panes'), () => gone]]).run }).listJobs(), []);
    let tries = 0;
    const f = fake([[is('has-session'), () => gone], [is('new-session'), () => (++tries < 3 ? gone : ok())]]);
    assert.equal(await createTmux({ run: f.run }).ensureSession(), true);
    assert.equal(tries, 3);
  });

  test('listJobs kills panes left in starting and never adopts them', async () => {
    const f = fake([
      [is('list-panes'), () => ok([jobRow('1', 'a', '@1', '%1'), row('2', 'b', '@2', '%2', 'air-new-b', '5', '0', '', 'starting')].join('\n'))],
      [is('if-shell'), () => ok('air-ok\n')],
    ]);
    const jobs = await createTmux({ run: f.run }).listJobs();
    assert.deepEqual(jobs.map(j => j.issue), [1]);
    const kills = f.calls.filter(c => c[0] === 'if-shell');
    assert.equal(kills.length, 1);
    assert.deepEqual(kills[0]!.slice(3, 5), ['%2', '#{==:#{@air_nonce},b}']);
    assert.match(kills[0]![5]!, /'kill-window' '-t' '@2'/);
  });

  test('duplicate panes for an issue: keep the oldest, kill the rest', async () => {
    const f = fake([
      [is('list-panes'), () => ok([jobRow('5', 'new', '@9', '%10'), jobRow('5', 'old', '@3', '%3')].join('\n'))],
      [is('if-shell'), () => ok('air-ok\n')],
    ]);
    assert.equal(await createTmux({ run: f.run }).isAlive(5), true);
    const kills = f.calls.filter(c => c[0] === 'if-shell');
    assert.equal(kills.length, 1);
    assert.equal(kills[0]![3], '%10');
  });

  test('capture returns exactly the last lines, with a default for bad counts', async () => {
    const screen = ['h1', 'h2', 'a', 'b', 'c', '', '', ''].join('\n') + '\n';
    const f = fake([[is('list-panes'), () => ok(jobRow('5', 'n', '@3', '%3'))], [is('capture-pane'), () => ok(screen)]]);
    const t = createTmux({ run: f.run });
    assert.equal(await t.capture(5, 2), 'b\nc');
    assert.equal(await t.capture(5, 2.7), 'b\nc');
    for (const bad of [0, -3, NaN, Infinity, 0.5]) {
      assert.equal(await t.capture(5, bad), 'h1\nh2\na\nb\nc');
      assert.equal(f.calls.at(-1)!.at(-1), '-50');
    }
  });

  test('capture returns null when the pane vanishes after lookup', async () => {
    const f = fake([[is('list-panes'), () => ok(jobRow('5', 'n', '@3', '%3'))], [is('capture-pane'), () => fail("can't find pane: %3")]]);
    assert.equal(await createTmux({ run: f.run }).capture(5), null);
    const g = fake([[is('list-panes'), () => ok(jobRow('5', 'n', '@3', '%3'))], [is('capture-pane'), () => fail('no server running on /tmp/x')]]);
    assert.equal(await createTmux({ run: g.run }).capture(5), null);
  });

  test('stopJob tolerates the pane vanishing mid-stop', async () => {
    let lists = 0;
    const f = fake([
      [is('list-panes'), () => ++lists === 1 ? ok(jobRow('5', 'n', '@3', '%3')) : fail('no server running on /tmp/x')],
      [is('if-shell'), () => fail("can't find pane: %3")],
    ]);
    assert.deepEqual(await createTmux({ run: f.run }).stopJob(5, { graceMs: 10 }), { exitStatus: null });
  });

  test('startJob tags and respawns in one tmux invocation', async () => {
    const f = fake([
      [is('list-panes'), () => ok('')],
      [is('show-options'), () => ok('tmux-256color\n')],
      [is('new-window'), () => ok('@3 %5\n')],
    ]);
    const id = await createTmux({ run: f.run }).startJob({ issue: 42, cwd: ws, argv: ['claude'], env: { FOO: '1' }, task: 'x'.repeat(1_000_000) });
    assert.equal(id, '@3');
    assert.deepEqual(f.calls.map(c => c[0]), ['list-panes', 'has-session', 'show-options', 'new-window']);
    const chain = f.calls[3]!;
    const cmds = chain.join(' ').split(' ; ').map(c => c.split(' ').slice(0, 1)[0]);
    assert.deepEqual(cmds, ['new-window', 'set-option', 'set-option', 'set-option', 'set-option', 'set-option', 'set-option', 'set-option',
      'respawn-pane', 'set-option', 'rename-window']);
    const text = chain.join(' ');
    const tmp = chain[chain.indexOf('-n') + 1]!;
    assert.match(tmp, /^air-new-[0-9a-f]{24}$/);
    // Every command after new-window targets the new window by its exact temporary name, never the current pane.
    for (const part of text.split(' ; ').slice(1)) assert.ok(part.includes(`-t =air:=${tmp}`), part);
    assert.ok(text.indexOf('@air_state starting') < text.indexOf('respawn-pane'));
    assert.ok(text.indexOf('respawn-pane') < text.indexOf('@air_state running'));
    assert.match(text, /@air_job 42/);
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
    assert.match(script, /exec 'env' '-i' /);
    assert.ok(script.includes(`'FOO=1'`) && script.includes(`'TERM=tmux-256color'`) && !script.includes('GH_TOKEN'));
    assert.ok(script.includes(`cd -- '${ws}'`));
    assert.ok(script.includes(`'claude' '${TASK_INSTRUCTION}'`));
    // The task lives in the workspace, not in argv.
    assert.equal(readFileSync(join(ws, TASK_FILE), 'utf8').length, 1_000_000);
    assert.ok(text.length < 10_000);
  });

  test('startJob: separator-like argv words never reach the tmux command line', async () => {
    const f = fake([[is('list-panes'), () => ok('')], [is('new-window'), () => ok('@3 %5\n')]]);
    await createTmux({ run: f.run }).startJob({ issue: 3, cwd: ws, argv: ['sh', '-c', 'true', ';', 'run-shell', 'touch /x', 'y;', '{', '}'], env: { A: 'b;' } });
    const chain = f.calls.find(c => c[0] === 'new-window')!;
    // Every separator is one of ours: exactly one between each command, and no other word ends in `;`.
    assert.equal(chain.filter(w => w === ';').length, 10);
    assert.ok(!chain.some(w => w !== ';' && w.endsWith(';')));
    assert.ok(!chain.includes('run-shell'));
    const script = chain[chain.indexOf('/bin/sh') + 1]!;
    rmSync(join(script, '..'), { recursive: true });
  });

  test('startJob refuses a second window for the same issue', async () => {
    const { run } = fake([[is('list-panes'), () => ok(jobRow('42', 'n', '@1', '%1'))]]);
    await assert.rejects(createTmux({ run }).startJob({ issue: 42, cwd: ws, argv: ['x'] }), /already has a window/);
  });

  test('startJob refuses a missing workspace', async () => {
    const { run } = fake([]);
    await assert.rejects(createTmux({ run }).startJob({ issue: 1, cwd: join(ws, 'nope'), argv: ['x'] }), /not a directory/);
  });

  test('startJob kills its window when the chain fails part way', async () => {
    const f = fake([
      [is('list-panes'), () => ok('')],
      [is('new-window'), () => ({ code: 1, stdout: '@3 %5\n', stderr: 'boom' })],
    ]);
    await assert.rejects(createTmux({ run: f.run }).startJob({ issue: 1, cwd: ws, argv: ['x'] }), /boom/);
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
    const t = createTmux({ run });
    const results = await Promise.allSettled([1, 2, 3].map(() => t.startJob({ issue: 42, cwd: ws, argv: ['x'] })));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(results.filter(r => r.status === 'rejected').length, 2);
    assert.equal(f.calls.filter(c => c[0] === 'new-window').length, 1);
    assert.equal(maxActive, 1);
    const chain = f.calls.find(c => c[0] === 'new-window')!;
    rmSync(join(chain[chain.indexOf('/bin/sh') + 1]!, '..'), { recursive: true }); // the launcher never ran
  });

  test('stopJob guards every write with the nonce and kills after the grace period', async () => {
    const f = fake([
      [is('list-panes'), () => ok(jobRow('42', 'n0nce', '@1', '%1'))],
      [is('if-shell'), () => ok('air-ok\n')],
    ]);
    const r = await createTmux({ run: f.run }).stopJob(42, { graceMs: 50, keys: ['C-c'] });
    assert.deepEqual(r, { exitStatus: null });
    const guards = f.calls.filter(c => c[0] === 'if-shell');
    assert.equal(guards.length, 2);
    for (const g of guards) assert.deepEqual(g.slice(0, 5), ['if-shell', '-F', '-t', '%1', '#{==:#{@air_nonce},n0nce}']);
    assert.match(guards[0]![5]!, /send-keys/);
    assert.match(guards[1]![5]!, /'kill-window' '-t' '@1'/);
  });

  test('stopJob of an unknown job is undefined', async () => {
    const { run } = fake([[is('list-panes'), () => ok('')]]);
    assert.equal(await createTmux({ run }).stopJob(9), undefined);
  });

  test('attachArgs targets the window itself and checks the full socket path', async () => {
    const { run } = fake([[is('list-panes'), () => ok(jobRow('42', 'n', '@4', '%4'))]]);
    const t = createTmux({ run });
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
