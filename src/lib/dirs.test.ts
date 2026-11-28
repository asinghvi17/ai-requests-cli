import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { airDir } from './dirs.ts';

const CALLERS = new URL('./fixtures/dirs-callers.ts', import.meta.url).pathname;

const HOME = '/home/u';

test('the config dir is $XDG_CONFIG_HOME/air, else ~/.config/air; an empty or relative value is ignored', () => {
  assert.equal(airDir('config', {}, HOME), '/home/u/.config/air');
  assert.equal(airDir('config', { XDG_CONFIG_HOME: '/x' }, HOME), '/x/air');
  assert.equal(airDir('config', { XDG_CONFIG_HOME: '' }, HOME), '/home/u/.config/air');
  assert.equal(airDir('config', { XDG_CONFIG_HOME: 'rel' }, HOME), '/home/u/.config/air');
  assert.equal(airDir('config', { XDG_STATE_HOME: '/s' }, HOME), '/home/u/.config/air');
});

test('the state dir is $XDG_STATE_HOME/air, else ~/.local/state/air; an empty or relative value is ignored', () => {
  assert.equal(airDir('state', {}, HOME), '/home/u/.local/state/air');
  assert.equal(airDir('state', { XDG_STATE_HOME: '/s' }, HOME), '/s/air');
  assert.equal(airDir('state', { XDG_STATE_HOME: '' }, HOME), '/home/u/.local/state/air');
  assert.equal(airDir('state', { XDG_STATE_HOME: 'rel' }, HOME), '/home/u/.local/state/air');
  assert.equal(airDir('state', { XDG_CONFIG_HOME: '/x' }, HOME), '/home/u/.local/state/air');
});

test('AIR_CONFIG_DIR and AIR_STATE_DIR are not read', () => {
  assert.equal(airDir('config', { AIR_CONFIG_DIR: '/a' }, HOME), '/home/u/.config/air');
  assert.equal(airDir('state', { AIR_STATE_DIR: '/a' }, HOME), '/home/u/.local/state/air');
});

test('every caller finds config.toml, subscriptions.json and the state dir where airDir says, XDG set or not', () => {
  // In a fresh process (fixtures/dirs-callers.ts), with HOME and cwd under tmp: serveContext creates the state dir.
  const tmp = mkdtempSync(join(tmpdir(), 'air-dirs-'));
  const home = join(tmp, 'home'), xdgConfig = join(tmp, 'config'), xdgState = join(tmp, 'state');
  const homeConfig = join(home, '.config', 'air'), homeState = join(home, '.local', 'state', 'air');
  const cases: [string | undefined, string | undefined, string, string][] = [
    [undefined, undefined, homeConfig, homeState],
    ['', '', homeConfig, homeState],
    ['relative/config', 'relative/state', homeConfig, homeState],
    [xdgConfig, xdgState, join(xdgConfig, 'air'), join(xdgState, 'air')],
    [xdgConfig, undefined, join(xdgConfig, 'air'), homeState],
    [undefined, xdgState, homeConfig, join(xdgState, 'air')],
  ];
  try {
    for (const [config, state, configDir, stateDir] of cases) {
      const env: Record<string, string | undefined> = {
        ...process.env, HOME: home, AIR_CONFIG_DIR: join(tmp, 'ignored-config'), AIR_STATE_DIR: join(tmp, 'ignored-state'),
        XDG_CONFIG_HOME: config, XDG_STATE_HOME: state,
      };
      for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
      const r = spawnSync(process.execPath, [CALLERS], { cwd: tmp, env, encoding: 'utf8' });
      const what = JSON.stringify({ config, state });
      assert.equal(r.status, 0, `${what}: ${r.stderr}`);
      const found = JSON.parse(r.stdout);
      assert.deepEqual(found, {
        config: configDir,
        state: stateDir,
        configToml: Object.fromEntries(['configPath', 'firstRunDeps', 'doctorDeps', 'serveContext'].map((k) => [k, join(configDir, 'config.toml')])),
        subscriptionsJson: { configFile: join(configDir, 'subscriptions.json') },
        stateDir: Object.fromEntries(['stateDir', 'jobDeps', 'statusDeps', 'serveContext'].map((k) => [k, stateDir])),
      }, what);
    }
    for (const unused of ['ignored-config', 'ignored-state', 'relative']) assert.ok(!existsSync(join(tmp, unused)), unused);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
