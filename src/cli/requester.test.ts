// `air status`, `air wait`, `air fetch` and `air retry` through the router: flags, output and exit codes.
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../config.ts';
import type { FakeGitHub } from '../gh/fake.ts';
import { lint } from '../spec/lint.ts';
import { formatResult, type AirResult } from '../spec/markers.ts';
import { buildZip } from '../workspace/zip-fixture.ts';
import { requestIssue, result } from '../requester/fixture.ts';
import { fetchDeps } from './fetch.ts';
import { main } from './main.ts';
import { deps } from './requests.ts';
import { waitDeps } from './wait.ts';

const dirs: string[] = [];
const saved = { ...deps };
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  Object.assign(deps, saved);
  for (const k of Object.keys(waitDeps)) delete waitDeps[k as keyof typeof waitDeps];
  for (const k of Object.keys(fetchDeps)) delete fetchDeps[k as keyof typeof fetchDeps];
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'air-req-cli-'));
  dirs.push(d);
  return d;
}

let gh: FakeGitHub;
beforeEach(() => {
  gh = requestIssue();
  deps.loadConfig = () => parseConfig('repo = "o/requests"\n');
  deps.repo = () => gh;
});

async function call(...argv: string[]) {
  let out = '';
  let err = '';
  const code = await main(argv, { out: (s) => { out += s; }, err: (s) => { err += s; } });
  return { code, out, err };
}

const final = (r: Partial<AirResult>, release = r.status !== 'done') =>
  gh.post(1, 'srv', 'OWNER', `Report.\n\n${release ? '<!-- air-release v0 host=box nonce=aaaaaaaa -->\n' : ''}${formatResult(result(r))}\n`);

test('air status prints the state, and --json the same as an object', async () => {
  gh.issues.get(1)!.labels.push('air:running');
  const r = await call('status', '1');
  assert.deepEqual(r, { code: 0, out: 'o/requests#1: A request\nstate:  air:running, held by box\nresult: none yet\n', err: '' });
  final({ status: 'failed' });
  const j = await call('status', '--json', '#1');
  assert.equal(j.code, 0);
  const s = JSON.parse(j.out);
  assert.equal(s.holder, null);
  assert.equal(s.result.status, 'failed');
  assert.equal(s.result.current, true);
  assert.deepEqual((await call('status', '7')), { code: 1, out: '', err: 'air status: Not Found (HTTP 404)\n' });
});

test('air wait exit codes: 0 done, 3 partial, 1 failed or released, 4 timeout, 2 usage', async () => {
  let t = 0;
  waitDeps.now = () => t;
  waitDeps.sleep = async (ms) => void (t += ms);
  waitDeps.intervalMs = 60_000;
  const timeout = await call('wait', '--timeout', '2m', '1');
  assert.equal(timeout.code, 4);
  assert.equal(t, 120_000);
  assert.match(timeout.out, /^result: none yet$/m);
  assert.equal(timeout.err, 'air wait: #1 has no current result after 2m\n');

  final({ status: 'partial' });
  assert.equal((await call('wait', '1')).code, 3);
  const codes: Record<string, number> = { done: 0, failed: 1, released: 1 };
  for (const [status, code] of Object.entries(codes)) {
    gh = requestIssue();
    final({ status: status as AirResult['status'] });
    const r = await call('wait', '--json', '1');
    assert.equal(r.code, code, status);
    assert.equal(JSON.parse(r.out).result.status, status);
  }
  assert.equal((await call('wait', '9')).code, 1);
  assert.match((await call('wait', '--timeout', '5s', '1')).err, /--timeout must be a duration like 90m/);
  assert.equal((await call('wait', '--timeout', '5s', '1')).code, 2);
  assert.equal((await call('wait', '--timeout', '0m', '1')).code, 2);
});

test('air fetch writes DIR, default ./air-ISSUE; failures exit 1', async () => {
  const zip = buildZip([{ name: 'a.txt', data: 'hi' }]);
  const url = 'https://github.com/o/requests/releases/download/air-artifacts/air-1-aaaaaaaa.zip';
  final({ deliver: 'artifact', artifact: { url, sha256: createHash('sha256').update(zip).digest('hex'), bytes: zip.length } });
  fetchDeps.download = async (u, dest) => writeFileSync(dest, u === url ? zip : Buffer.alloc(0));
  const dir = join(tmp(), 'got');
  const r = await call('fetch', '1', dir);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, `fetched the done result of o/requests#1 into ${dir}: REPORT.md, artifact/\n`);
  assert.equal(readFileSync(join(dir, 'artifact', 'a.txt'), 'utf8'), 'hi');
  const again = await call('fetch', '1', dir);
  assert.deepEqual(again, { code: 1, out: '', err: `air fetch: ${dir} is not empty\n` });

  const cwd = process.cwd();
  process.chdir(tmp());
  try {
    assert.equal((await call('fetch', '1')).code, 0);
    assert.equal(readFileSync(join('air-1', 'artifact', 'a.txt'), 'utf8'), 'hi');
  } finally {
    process.chdir(cwd);
  }
});

test('air retry edits the body and labels; --effort is checked; refusals exit 1', async () => {
  gh.issues.get(1)!.labels.push('air:failed');
  final({ status: 'failed' });
  const r = await call('retry', '--effort', 'L', '1');
  assert.deepEqual(r, { code: 0, out: 'offered o/requests#1 again (effort L); removed air:failed\n', err: '' });
  assert.equal(lint(gh.issues.get(1)!.body).request?.effort, 'L');
  assert.deepEqual(gh.issues.get(1)!.labels, ['ai-request']);

  const bad = await call('retry', '--effort', 'XXL', '1');
  assert.equal(bad.code, 2);
  assert.match(bad.err, /--effort must be one of XS, S, M, L, XL/);
  gh = requestIssue({ labels: ['air:running'] });
  assert.deepEqual(await call('retry', '1'), { code: 1, out: '', err: 'air retry: #1 is held by box; add `air:cancel` and wait for its release first\n' });
});
