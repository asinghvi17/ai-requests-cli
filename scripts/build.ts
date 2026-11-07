// npm run build [-- --target linux-x64|linux-arm64|darwin-arm64|darwin-x64]
// Bundles src/cli/main.ts with esbuild (dev dependency) and wraps it in a Node single executable
// (node --build-sea) at dist/air-<target>. For a non-host target, the official Node binary of the same
// version is downloaded into dist/cache and checked against nodejs.org's SHASUMS256.txt. macOS outputs are
// unsigned: run `codesign --sign - dist/air-darwin-*` on a Mac (or rcodesign) before they will run there.
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { parseArgs } from '../src/cli/args.ts';

const root = join(import.meta.dirname, '..');
const dist = join(root, 'dist');
const host = `${process.platform}-${process.arch}`;
const { flags } = parseArgs(process.argv.slice(2), { target: { type: 'string' } });
const target = typeof flags.target === 'string' ? flags.target : host;
if (!/^(linux|darwin)-(x64|arm64)$/.test(target)) throw new Error(`unsupported target ${target}`);

function sh(cmd: string, args: string[]): void {
  const r = spawnSync(cmd, args, { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed`);
}

async function nodeFor(t: string): Promise<string> {
  if (t === host) return process.execPath;
  const name = `node-${process.version}-${t}`;
  const cache = join(dist, 'cache');
  const bin = join(cache, name, 'bin', 'node');
  if (existsSync(bin)) return bin;
  mkdirSync(cache, { recursive: true });
  const base = `https://nodejs.org/dist/${process.version}`;
  const fetchOk = async (url: string) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return res;
  };
  const sums = await (await fetchOk(`${base}/SHASUMS256.txt`)).text();
  const want = sums.split('\n').find((l) => l.endsWith(`  ${name}.tar.xz`))?.split(' ')[0];
  if (!want) throw new Error(`no checksum for ${name}.tar.xz`);
  const tarball = Buffer.from(await (await fetchOk(`${base}/${name}.tar.xz`)).arrayBuffer());
  if (createHash('sha256').update(tarball).digest('hex') !== want) throw new Error(`${name}.tar.xz: checksum mismatch`);
  const archive = join(cache, `${name}.tar.xz`);
  writeFileSync(archive, tarball);
  sh('tar', ['-xf', archive, '-C', cache, `${name}/bin/node`]);
  return bin;
}

mkdirSync(dist, { recursive: true });
const bundle = join(dist, 'air.cjs');
await build({
  stdin: { contents: "import { run } from './src/cli/main.ts'; run();", resolveDir: root, loader: 'ts', sourcefile: 'entry.ts' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: `node${process.versions.node.split('.')[0]}`,
  define: { 'import.meta.main': 'false' },
  outfile: bundle,
  logLevel: 'warning',
});
const output = join(dist, `air-${target}`);
const seaConfig = join(dist, `sea-${target}.json`);
writeFileSync(seaConfig, JSON.stringify({
  main: bundle,
  output,
  executable: await nodeFor(target),
  disableExperimentalSEAWarning: true,
  useCodeCache: target === host, // the code cache is only valid for the building node
  useSnapshot: false,
}));
sh(process.execPath, ['--build-sea', seaConfig]);
console.log(`${output} (${(readFileSync(output).length / 1e6).toFixed(1)} MB)`);
