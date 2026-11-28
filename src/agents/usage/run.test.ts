import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { run } from './run.ts';

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('a timeout kills the whole process group, grandchildren included', async () => {
  const pidFile = join(mkdtempSync(join(tmpdir(), 'air-run-')), 'pid');
  await assert.rejects(run(join(import.meta.dirname, 'fixtures', 'fake-hang.ts'), [pidFile], { env: { PATH: process.env.PATH }, timeoutMs: 1000 }), /timeout/);
  const grandchild = Number(readFileSync(pidFile, 'utf8'));
  for (let i = 0; i < 100 && alive(grandchild); i++) await sleep(30);
  assert.equal(alive(grandchild), false);
});

test('run returns stdout and rejects a non-zero exit', async () => {
  const env = { PATH: process.env.PATH };
  assert.equal(await run(process.execPath, ['-e', 'console.log("hi")'], { env }), 'hi\n');
  await assert.rejects(run(process.execPath, ['-e', 'process.exit(4)'], { env }), /exit 4/);
});
