// npm run build [-- --target linux-x64|linux-arm64|darwin-arm64|darwin-x64 ...]
// Compiles src/cli/main.ts into single executables with `bun build --compile` (bun is a dev dependency):
// dist/air-<target>, every target by default. Bun cross-compiles from any host and ad-hoc signs macOS
// binaries. Dev and tests stay on Node; only the shipped binaries run on Bun. Each binary has its version
// stamped (scripts/version.ts).
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { parseArgs } from '../src/cli/args.ts';
import { buildVersion, versionDefine } from './version.ts';

export const TARGETS = ['linux-x64', 'linux-arm64', 'darwin-arm64', 'darwin-x64'] as const;

const root = join(import.meta.dirname, '..');
const dist = join(root, 'dist');
const { flags } = parseArgs(process.argv.slice(2), { target: { type: 'string', multiple: true } });
const targets = (flags.target as string[] | undefined) ?? [...TARGETS];
for (const t of targets) if (!(TARGETS as readonly string[]).includes(t)) throw new Error(`unsupported target ${t}`);

const local = join(root, 'node_modules', '.bin', 'bun');
const bun = existsSync(local) ? local : 'bun';
mkdirSync(dist, { recursive: true });
const define = versionDefine(root);
console.log(`air ${buildVersion(root)}`);
for (const t of targets) {
  const out = join(dist, `air-${t}`);
  const r = spawnSync(bun, ['build', '--compile', '--minify', ...define, `--target=bun-${t}`, join(root, 'src', 'cli', 'main.ts'), '--outfile', out], { stdio: 'inherit' });
  if (r.error) throw r.error;
  if (r.status !== 0) process.exit(r.status ?? 1);
  console.log(`${out} (${(statSync(out).size / 1e6).toFixed(1)} MB)`);
}
