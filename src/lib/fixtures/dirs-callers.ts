// Prints, as JSON, where each caller finds config.toml, subscriptions.json and the state dir in this process's
// environment. dirs.test.ts runs it in a fresh process: `bun test` runs every test file in one process, where
// other tests leave deps objects such as `jobDeps` stubbed.
import { airDir } from '../dirs.ts';
import { configPath, parseConfig } from '../../setup/config.ts';
import { firstRunDeps } from '../../setup/firstrun.ts';
import { configFile, stateDir } from '../../agents/usage/index.ts';
import { serveContext } from '../../server/context.ts';
import { doctorDeps } from '../../cli/doctor.ts';
import { jobDeps } from '../../cli/jobs.ts';
import { statusDeps } from '../../cli/status.ts';

const ctx = serveContext(parseConfig(''), 'o/requests');
process.stdout.write(JSON.stringify({
  config: airDir('config'),
  state: airDir('state'),
  configToml: {
    configPath: configPath(), firstRunDeps: firstRunDeps.configPath(), doctorDeps: doctorDeps.configPath(), serveContext: ctx.configFile,
  },
  subscriptionsJson: { configFile: configFile() },
  stateDir: { stateDir: stateDir(), jobDeps: jobDeps.stateDir(), statusDeps: statusDeps.stateDir(), serveContext: ctx.stateDir },
}));
