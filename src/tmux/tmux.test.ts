import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTmux, parseJobs, quoteTmux, socketPath, TASK_FILE, TASK_INSTRUCTION, type RunResult } from './tmux.ts';
import { clientEnv, jobArgv, jobEnv } from './env.ts';

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
  test('jobArgv starts from an empty environment', () => {
    assert.deepEqual(jobArgv(['claude', '--x'], { PATH: '/bin' }), ['env', '-i', 'PATH=/bin', 'claude', '--x']);
    assert.throws(() => jobArgv(['x'], { BASH_ENV: '/x' }), /refusing/);
    assert.throws(() => jobArgv(['A=b'], {}), /may not contain/);
    assert.throws(() => jobArgv([], {}), /empty/);
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
      { issue: 42, nonce: 'abc', windowId: '@1', paneId: '%1', windowName: '#42', pid: 11, dead: false, exitStatus: null },
      { issue: 7, nonce: 'def', windowId: '@2', paneId: '%2', windowName: '#7', pid: 12, dead: true, exitStatus: 3 },
    ]);
  });

  test('listJobs is empty without a server', async () => {
    const { run } = fake([[is('list-panes'), () => fail('no server running on /tmp/tmux-1/air')]]);
    assert.deepEqual(await createTmux({ run }).listJobs(), []);
  });

  test('ensureSession creates the session only when missing', async () => {
    const f = fake([[is('has-session'), () => fail("can't find session: air")]]);
    assert.equal(await createTmux({ run: f.run }).ensureSession({ argv: ['air', 'serve'] }), true);
    assert.deepEqual(f.calls[1], ['new-session', '-d', '-s', 'air', '-n', 'log', '--', 'air', 'serve']);
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
    assert.deepEqual(cmds, ['new-window', 'set-option', 'set-option', 'set-option', 'set-option', 'set-option', 'set-option',
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
    const respawn = chain.slice(chain.indexOf('respawn-pane'));
    const argv = respawn.slice(respawn.indexOf('--') + 1, respawn.indexOf(';'));
    assert.deepEqual(argv.slice(0, 2), ['env', '-i']);
    assert.ok(argv.includes('FOO=1') && argv.includes('TERM=tmux-256color'));
    assert.ok(!argv.some(a => a.startsWith('GH_TOKEN=')));
    assert.deepEqual(argv.slice(-2), ['claude', TASK_INSTRUCTION]);
    // The task lives in the workspace, not in argv.
    assert.equal(readFileSync(join(ws, TASK_FILE), 'utf8').length, 1_000_000);
    assert.ok(text.length < 10_000);
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
