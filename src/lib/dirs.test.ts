import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { airDir } from './dirs.ts';
import { configPath, parseConfig } from '../setup/config.ts';
import { firstRunDeps } from '../setup/firstrun.ts';
import { configFile as subscriptionsFile, stateDir } from '../agents/usage/index.ts';
import { serveContext } from '../server/context.ts';
import { doctorDeps } from '../cli/doctor.ts';
import { jobDeps } from '../cli/jobs.ts';
import { statusDeps } from '../cli/status.ts';

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

/** Runs `f` with process.env's XDG and AIR_ dir variables set to `vars` (undefined: unset). */
function withEnv(vars: Record<string, string | undefined>, f: () => void) {
  const keys = ['XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'AIR_CONFIG_DIR', 'AIR_STATE_DIR'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const set = (v: Record<string, string | undefined>) => {
    for (const k of keys) {
      if (v[k] === undefined) delete process.env[k];
      else process.env[k] = v[k];
    }
  };
  set(vars);
  try { f(); } finally { set(saved); }
}

test('every caller finds config.toml, subscriptions.json and the state dir where airDir says, XDG set or not', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'air-dirs-'));
  const values = (name: string) => [undefined, '', `relative/${name}`, join(tmp, name)];
  const expected = (v: string | undefined, fallback: string) => join(v && isAbsolute(v) ? v : join(homedir(), fallback), 'air');
  try {
    for (const config of values('config')) {
      for (const state of values('state')) {
        withEnv({ XDG_CONFIG_HOME: config, XDG_STATE_HOME: state, AIR_CONFIG_DIR: join(tmp, 'ignored-config'), AIR_STATE_DIR: join(tmp, 'ignored-state') }, () => {
          const what = JSON.stringify({ config, state });
          const configDir = expected(config, '.config'), stateDirPath = expected(state, join('.local', 'state'));
          assert.equal(airDir('config'), configDir, what);
          assert.equal(airDir('state'), stateDirPath, what);
          const paths = [configPath(), firstRunDeps.configPath(), doctorDeps.configPath()];
          const states = [stateDir(), jobDeps.stateDir(), statusDeps.stateDir()];
          // serveContext creates the state dir, so it runs only when that is under tmp.
          if (state && isAbsolute(state)) {
            const ctx = serveContext(parseConfig(''), 'o/requests');
            paths.push(ctx.configFile!);
            states.push(ctx.stateDir);
          }
          for (const path of paths) assert.equal(path, join(configDir, 'config.toml'), what);
          assert.equal(dirname(subscriptionsFile()), configDir, what);
          for (const dir of states) assert.equal(dir, stateDirPath, what);
        });
      }
    }
    assert.ok(!existsSync(join(tmp, 'ignored-config')) && !existsSync(join(tmp, 'ignored-state')));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
