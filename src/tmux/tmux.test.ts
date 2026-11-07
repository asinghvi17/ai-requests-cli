import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createTmux, parseJobs, quoteTmux, type RunResult } from './tmux.ts';
import { clientEnv, jobArgv, jobEnv } from './env.ts';

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

describe('env', () => {
  test('jobEnv keeps only the allowlist and refuses secrets', () => {
    const env = jobEnv({ FOO: 'bar' }, { PATH: '/bin', HOME: '/h', GH_TOKEN: 'x', AWS_SECRET_ACCESS_KEY: 'y', SSH_AUTH_SOCK: 's', CODEX_HOME: '/c' });
    assert.deepEqual(env, { PATH: '/bin', HOME: '/h', CODEX_HOME: '/c', FOO: 'bar' });
    assert.throws(() => jobEnv({ GH_TOKEN: 'x' }, {}), /refusing to pass GH_TOKEN/);
    assert.throws(() => jobEnv({ GITHUB_TOKEN: 'x' }, {}), /refusing/);
    assert.throws(() => jobEnv({ 'A B': 'x' }, {}), /bad environment variable/);
  });
  test('jobArgv starts from an empty environment', () => {
    assert.deepEqual(jobArgv(['claude', '--x'], { PATH: '/bin' }), ['env', '-i', 'PATH=/bin', 'claude', '--x']);
    const withPrompt = jobArgv(['codex'], {}, '/w/prompt.md');
    assert.deepEqual(withPrompt.slice(0, 3), ['env', '-i', '/bin/sh']);
    assert.deepEqual(withPrompt.slice(-2), ['/w/prompt.md', 'codex']);
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
      row('', '', '@0', '%0', 'log', '10', '0', ''),
      row('42', 'abc', '@1', '%1', '#42', '11', '0', ''),
      row('7', 'def', '@2', '%2', '#7', '12', '1', '3'),
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

  test('startJob tags the pane before respawning the real command', async () => {
    const f = fake([
      [is('list-panes'), () => ok('')],
      [is('show-options'), () => ok('tmux-256color\n')],
      [is('new-window'), () => ok('@3 %5\n')],
    ]);
    const id = await createTmux({ run: f.run }).startJob({ issue: 42, cwd: '/w', argv: ['claude'], env: { FOO: '1' } });
    assert.equal(id, '@3');
    const names = f.calls.map(c => c[0]);
    assert.deepEqual(names, ['list-panes', 'has-session', 'show-options', 'new-window', 'set-option', 'respawn-pane']);
    const nw = f.calls[3]!;
    assert.ok(nw.includes('#42') && nw.includes('/w'));
    const opts = f.calls[4]!.join(' ');
    assert.match(opts, /remain-on-exit on/);
    assert.match(opts, /-p -t %5 @air_job 42/);
    assert.match(opts, /-p -t %5 @air_nonce [0-9a-f]{24}/);
    const respawn = f.calls[5]!;
    const argv = respawn.slice(respawn.indexOf('--') + 1);
    assert.deepEqual(argv.slice(0, 2), ['env', '-i']);
    assert.ok(argv.includes('FOO=1') && argv.includes('TERM=tmux-256color'));
    assert.ok(!argv.some(a => a.startsWith('GH_TOKEN=')));
    assert.equal(argv.at(-1), 'claude');
  });

  test('startJob refuses a second window for the same issue', async () => {
    const { run } = fake([[is('list-panes'), () => ok(row('42', 'n', '@1', '%1', '#42', '1', '0', ''))]]);
    await assert.rejects(createTmux({ run }).startJob({ issue: 42, cwd: '/w', argv: ['x'] }), /already has a window/);
  });

  test('startJob cleans up its window when setup fails', async () => {
    const f = fake([
      [is('list-panes'), () => ok('')],
      [is('new-window'), () => ok('@3 %5\n')],
      [is('respawn-pane'), () => fail('boom')],
    ]);
    await assert.rejects(createTmux({ run: f.run }).startJob({ issue: 1, cwd: '/w', argv: ['x'] }), /boom/);
    assert.deepEqual(f.calls.at(-1), ['kill-window', '-t', '@3']);
  });

  test('stopJob guards every write with the nonce and kills after the grace period', async () => {
    const f = fake([
      [is('list-panes'), () => ok(row('42', 'n0nce', '@1', '%1', '#42', '1', '0', ''))],
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

  test('attachArgs attaches, switches inside our server, and un-nests from another', async () => {
    const { run } = fake([[is('list-panes'), () => ok(row('42', 'n', '@4', '%4', '#42', '1', '0', ''))]]);
    const t = createTmux({ run });
    assert.deepEqual(await t.attachArgs(undefined, {}), ['tmux', '-L', 'air', 'attach-session', '-t', '=air']);
    assert.deepEqual(await t.attachArgs(42, { TMUX: '/tmp/tmux-1/air,123,0' }),
      ['tmux', '-L', 'air', 'switch-client', '-t', '=air', ';', 'select-window', '-t', '@4']);
    assert.deepEqual((await t.attachArgs(42, { TMUX: '/tmp/tmux-1/default,123,0' })).slice(0, 4), ['env', '-u', 'TMUX', 'tmux']);
    await assert.rejects(t.attachArgs(7, {}), /no window/);
  });

  test('quoteTmux escapes single quotes', () => {
    assert.equal(quoteTmux(`a'b`), `'a'\\''b'`);
  });
});
