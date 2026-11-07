// spawnGh against real processes: fake `gh` scripts put first on PATH.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GhError, createGh, spawnGh } from './gh.ts';

const dirs: string[] = [];
let savedPath: string | undefined;
before(() => { savedPath = process.env.PATH; });
after(() => {
  process.env.PATH = savedPath;
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function fakeGh(script: string): void {
  const dir = mkdtempSync(join(tmpdir(), 'air-fake-gh-'));
  dirs.push(dir);
  const bin = join(dir, 'gh');
  writeFileSync(bin, `#!/bin/sh\n${script}\n`);
  chmodSync(bin, 0o755);
  process.env.PATH = `${dir}:${savedPath}`;
}

const big = { body: 'x'.repeat(4 << 20) }; // larger than any pipe buffer, so writing it hits EPIPE

test('prints JSON: args reach gh and the output is parsed', async () => {
  fakeGh(`cat >/dev/null; printf '{"args":"%s","prompt":"%s"}' "$*" "$GH_PROMPT_DISABLED"`);
  assert.deepEqual(await createGh(spawnGh).api('repos/o/r', { method: 'POST', body: { a: 1 } }), {
    args: 'api repos/o/r --method POST --input -',
    prompt: '1',
  });
});

test('gh failing without reading stdin rejects with its own error', async () => {
  fakeGh(`echo 'gh: Not Found (HTTP 404)' >&2; exit 1`);
  await assert.rejects(createGh(spawnGh).api('x', { method: 'POST', body: big }), (e: unknown) => e instanceof GhError && e.kind === 'not_found');
});

test('gh exiting 0 without reading stdin rejects cleanly', async () => {
  fakeGh('exit 0');
  await assert.rejects(spawnGh(['api', 'x'], JSON.stringify(big)), (e: unknown) => e instanceof GhError && /exited without reading its input \(EPIPE\)/.test(e.message));
});

test('missing gh is a missing_gh error', async () => {
  process.env.PATH = mkdtempSync(join(tmpdir(), 'air-empty-'));
  dirs.push(process.env.PATH);
  await assert.rejects(spawnGh(['api', 'x']), (e: unknown) => e instanceof GhError && e.kind === 'missing_gh');
});
