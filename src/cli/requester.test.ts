// `air status`, `air wait`, `air fetch`, `air retry` and `air cancel` through the router: flags, output and exit codes.
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../config.ts';
import type { FakeGitHub } from '../gh/fake.ts';
import { lint } from '../spec/lint.ts';
import { formatResult, type AirResult } from '../spec/markers.ts';
import { buildZip } from '../workspace/zip-fixture.ts';
import { insteadOf, makeBareRepo } from '../workspace/git-fixture.ts';
import { yamlScalar } from '../spec/frontmatter.ts';
import { requestBody, requestIssue, result } from '../requester/fixture.ts';
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
  assert.deepEqual(await call('retry', '1'), { code: 1, out: '', err: 'air retry: #1 is held by box; run `air cancel 1` and wait for its release first\n' });
});

test('air cancel adds air:cancel, creating the label on a fresh repo; author or write access only', async () => {
  gh = requestIssue({ labels: ['air:running'] });
  assert.ok(!gh.labels.has('air:cancel'), 'a fresh repo has no air:cancel label');
  assert.deepEqual(await call('cancel', '1'), { code: 0, out: 'cancelled o/requests#1: the server holding it stops its agent and releases it on its next tick; `air retry 1` offers it again\n', err: '' });
  assert.deepEqual(gh.issues.get(1)!.labels, ['ai-request', 'air:running', 'air:cancel']);
  assert.deepEqual(gh.log.filter((l) => /ensureLabels|addLabels/.test(l)), ['alice: ensureLabels air:cancel', 'alice: addLabels 1 air:cancel']);
  assert.deepEqual(await call('cancel', '1'), { code: 0, out: 'o/requests#1 already has `air:cancel`\n', err: '' });

  gh = requestIssue();
  gh.issues.get(1)!.author = 'bob';
  gh.setPermission('o/requests', 'alice', 'read'); // GitHub won't show a reader its role (403): none
  assert.deepEqual(await call('cancel', '1'), { code: 1, out: '', err: "air cancel: only the issue's author (bob) or someone with write access to o/requests can cancel #1; alice has none\n" });
  gh.setPermission('o/requests', 'alice', 'write');
  assert.equal((await call('cancel', '1')).code, 0);
  gh.issues.get(1)!.state = 'closed';
  gh.issues.get(1)!.labels = ['ai-request'];
  assert.deepEqual(await call('cancel', '1'), { code: 1, out: '', err: 'air cancel: #1 is closed, which cancels it already\n' });
  gh.issues.get(1)!.labels = [];
  assert.match((await call('cancel', '1')).err, /not a request/);
});

test("air cancel by an author who may not label issues says so, whichever of GitHub's 403s it meets", async () => {
  const denied = "air cancel: alice lacks permission to label issues in o/requests, so it can't add `air:cancel` to #1; ask someone with write access to o/requests to run it (or to give alice triage or write access)\n";
  // A reader: GitHub refuses creating the missing label.
  gh = requestIssue({ labels: ['air:running'] });
  gh.setPermission('o/requests', 'alice', 'read');
  assert.deepEqual(await call('cancel', '1'), { code: 1, out: '', err: denied });
  // The label exists (a server created it): GitHub refuses adding it.
  gh.labels.add('air:cancel');
  assert.deepEqual(await call('cancel', '1'), { code: 1, out: '', err: denied });
  assert.deepEqual(gh.issues.get(1)!.labels, ['ai-request', 'air:running']);
  // Triage may label an existing label, but not create one.
  gh = requestIssue({ labels: ['air:running'] });
  gh.setPermission('o/requests', 'alice', 'triage');
  assert.deepEqual(await call('cancel', '1'), { code: 1, out: '', err: denied });
  gh.labels.add('air:cancel');
  assert.equal((await call('cancel', '1')).code, 0);
  assert.deepEqual(gh.issues.get(1)!.labels, ['ai-request', 'air:running', 'air:cancel']);
});

test("air retry by an author who may not remove labels says so, and that the body is already edited", async () => {
  gh = requestIssue({ labels: ['air:failed'], claimed: false });
  gh.setPermission('o/requests', 'alice', 'read');
  final({ status: 'failed' });
  const r = await call('retry', '--effort', 'L', '1');
  assert.deepEqual(r, { code: 1, out: '', err: "air retry: alice lacks permission to label issues in o/requests, so it can't remove the `air:*` labels from #1; ask someone with write access to o/requests to run it (or to give alice triage or write access). The body is already edited, so their `air retry 1` only removes the labels\n" });
  assert.equal(lint(gh.issues.get(1)!.body).request?.effort, 'L', 'an author may edit their own body');
  assert.deepEqual(gh.issues.get(1)!.labels, ['ai-request', 'air:failed'], 'the labels keep servers off');
});

test('air fetch: hostile repo paths never leave DIR', async () => {
  const bare = makeBareRepo(tmp());
  const SERVICE = 'https://github.com/acme/service.git';
  fetchDeps.env = insteadOf(bare.bare, SERVICE);
  fetchDeps.ghHost = 'github.com';
  const body = (path: string) => requestBody().replace('    ref: main\n', `    ref: main\n    path: ${yamlScalar(path)}\n`);
  const partial = (repo: string) => result({ status: 'partial', resume: { branches: [{ repo, branch: 'air/1', sha: bare.first }] } });
  /** Runs `air fetch` into a fresh DIR inside an empty parent; returns what the parent holds afterwards. */
  const fetchInto = async () => {
    const parent = tmp();
    const r = await call('fetch', '1', join(parent, 'd'));
    return { ...r, parentPath: parent, parent: readdirSync(parent), dir: existsSync(join(parent, 'd')) ? readdirSync(join(parent, 'd')).sort() : [] };
  };
  for (const hostile of ['..', '../x', '/abs', 'a/../../b', '']) {
    // In a result's `prs` or checkpoint `resume.branches`, the block doesn't parse, so nothing counts.
    // formatResult won't write such a block, so a valid one is forged into it.
    for (const r of [result({ prs: [{ repo: 'placeholder', url: 'https://github.com/acme/service/pull/7' }] }), partial('placeholder')]) {
      gh = requestIssue();
      gh.post(1, 'srv', 'OWNER', `Report.\n\n${formatResult(r).replace('repo: placeholder', `repo: ${yamlScalar(hostile)}`)}\n`);
      const got = await fetchInto();
      assert.equal(got.code, 1, hostile);
      assert.equal(got.err, 'air fetch: #1 has no result yet\n', hostile);
      assert.deepEqual(got.parent, [], hostile);
    }
    // In the body's `repos[].path`, the body fails lint, so no checkpoint branch is cloned.
    gh = requestIssue({ body: body(hostile), results: [{ result: partial('service'), release: true }] });
    const got = await fetchInto();
    assert.equal(got.code, 1, hostile);
    assert.match(got.err, /body no longer passes lint/, hostile);
    assert.deepEqual(got.parent, ['d'], hostile);
    assert.deepEqual(got.dir, ['REPORT.md'], hostile);
  }
  // `out` is a valid path: it goes to repo/out, never over the checkpoint's out/.
  gh = requestIssue({ body: body('out'), results: [{ result: partial('out'), release: true }] });
  const got = await fetchInto();
  assert.equal(got.code, 0, got.err);
  assert.deepEqual(got.dir, ['REPORT.md', 'repo']);
  assert.equal(execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: join(got.parentPath, 'd', 'repo', 'out'), encoding: 'utf8' }).trim(), 'air/1');
});
