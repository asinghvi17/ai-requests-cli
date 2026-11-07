// Runs tsc --noEmit against tsconfig.json; exits with tsc's status.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
const r = spawnSync(process.execPath, [tsc, '--noEmit', '-p', 'tsconfig.json'], { stdio: 'inherit' });
process.exit(r.status ?? 1);
