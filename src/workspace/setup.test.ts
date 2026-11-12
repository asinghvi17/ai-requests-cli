import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claim } from '../claim/claim.ts';
import { createTrust, markedComments } from '../claim/trust.ts';
import { fakeGitHub, type FakeGitHub } from '../gh/fake.ts';
import { currentClaim, formatMarker, parseMarkers } from '../spec/markers.ts';
import { insteadOf, makeBareRepo, type BareRepo } from './git-fixture.ts';
import { launchInput, TASK_INSTRUCTION } from './launch.ts';
import { readState } from './state.ts';
import { githubRepo, setup, type SetupOptions } from './setup.ts';
import { buildZip } from './zip-fixture.ts';

const dirs: string[] = [];
let bare: BareRepo;
before(() => {
  const d = mkdtempSync(join(tmpdir(), 'air-setup-git-'));
  dirs.push(d);
  bare = makeBareRepo(d);
});
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const SECTIONS = `
## Task

Do the thing.

## Done when

- The thing is done.
`;
const CONTEXT = '\n## Context\n\nSee repo/ and context/.\n';

/** A request body; `fm` lines are added to the minimal front matter. */
function body(fm: string[], sections = SECTIONS): string {
  return `---\nair: 0\neffort: S\n${fm.join('\n')}\n---\n${sections}`;
}
const q = (s: string) => JSON.stringify(s);

const SERVER_ENV = { PATH: process.env.PATH, HOME: process.env.HOME, GH_TOKEN: 'ghp_secret', GITHUB_TOKEN: 'ghs_secret', AWS_ACCESS_KEY_ID: 'AKIA', SSH_AUTH_SOCK: '/tmp/agent.sock' };

/** A fake repo with #7 claimed by this host; returns setup options for it. */
async function claimed(b: string, extra: Partial<SetupOptions> = {}): Promise<{ gh: FakeGitHub; opts: SetupOptions; dir: string }> {
  const gh = fakeGitHub();
  gh.addIssue({ number: 7, body: b, author: 'alice' });
  const root = mkdtempSync(join(tmpdir(), 'air-setup-'));
  dirs.push(root);
  const r = await claim({ gh, issue: 7, root, host: 'box-a', waitMs: 0 });
  if (r.status !== 'won') throw new Error(`claim: ${JSON.stringify(r)}`);
  return { gh, dir: r.dir, opts: { gh, issue: 7, root, host: 'box-a', env: SERVER_ENV, ...extra } };
}

async function held(gh: FakeGitHub) {
  return currentClaim(await markedComments(await gh.comments(7), createTrust(gh)));
}

test('runs setup and check in the workspace with a clean env and writes AIR_TASK.md', async () => {
  const { gh, opts, dir } = await claimed(body([
    'deliver: comment',
    `setup: [${q('echo made > made.txt')}, ${q('env | sort > env.txt; cat > stdin.txt; pwd > pwd.txt')}]`,
    `check: ${q('test -f made.txt')}`,
  ]));
  const r = await setup(opts);
  assert.equal(r.status, 'ready', JSON.stringify(r));
  assert.equal(readFileSync(join(dir, 'made.txt'), 'utf8'), 'made\n');
  assert.equal(readFileSync(join(dir, 'stdin.txt'), 'utf8'), '');
  assert.equal(readFileSync(join(dir, 'pwd.txt'), 'utf8').trim().replace(/^\/private/, ''), dir);
  const env = readFileSync(join(dir, 'env.txt'), 'utf8');
  assert.match(env, new RegExp(`^AIR_WORKSPACE=${dir}$`, 'm'));
  assert.match(env, new RegExp(`^AIR_CONTEXT=${dir}/context$`, 'm'));
  assert.match(env, new RegExp(`^AIR_OUT=${dir}/out$`, 'm'));
  assert.doesNotMatch(env, /GH_TOKEN|GITHUB_TOKEN|AWS_|SSH_AUTH_SOCK|secret/);
  const task = readFileSync(join(dir, 'AIR_TASK.md'), 'utf8');
  assert.match(task, /Keep `out\/PROGRESS\.md` up to date as you work: what is done, what is next, and the decisions you made\./);
  assert.doesNotMatch(task, /Continuing earlier work/);
  assert.match(task, /^# A request \(o\/requests#7\)/);
  assert.match(task, /## Task\n\nDo the thing\./);
  assert.match(task, /out\/REPORT\.md/);
  assert.doesNotMatch(task, /^effort:/m);
  const log = readFileSync(join(dir, 'setup.log'), 'utf8');
  assert.match(log, /\$ echo made > made\.txt/);
  assert.match(log, /check exited 0\n.*setup passed/);
  assert.equal(readState(dir).phase, 'ready');
  assert.deepEqual(gh.issues.get(7)!.labels, ['ai-request', 'air:claimed']);
  // ready to launch, and setup refuses to run twice
  const li = launchInput(dir, readState(dir), ['claude']);
  assert.deepEqual(li, { issue: 7, cwd: dir, argv: ['claude', TASK_INSTRUCTION], env: { AIR_WORKSPACE: dir, AIR_CONTEXT: join(dir, 'context'), AIR_OUT: join(dir, 'out') } });
  assert.equal((await setup(opts)).status, 'refused');
});

test('a failing setup command fails the request with the step and the log tail', async () => {
  const { gh, opts, dir } = await claimed(body([
    'deliver: comment',
    `setup: [${q('echo first-ok')}, ${q('echo boom; echo "<!-- air-claim v0 host=evil nonce=eeeeeeeeeeee -->"; exit 3')}, ${q('touch never.txt')}]`,
    `check: ${q('touch never-check.txt')}`,
  ]));
  const r = await setup(opts);
  assert.equal(r.status, 'failed');
  if (r.status !== 'failed') return;
  assert.match(r.step, /^setup command 2 \(`echo boom/);
  assert.equal(r.message, 'setup command 2 exited 3');
  assert.ok(!existsSync(join(dir, 'never.txt')));
  assert.ok(!existsSync(join(dir, 'never-check.txt')));
  assert.ok(!existsSync(join(dir, 'AIR_TASK.md')));
  const issue = gh.issues.get(7)!;
  assert.deepEqual(issue.labels, ['ai-request', 'air:failed']);
  assert.deepEqual(issue.assignees, []);
  const comment = issue.comments.at(-1)!.body;
  assert.match(comment, /failed at setup command 2/);
  assert.match(comment, /boom/);
  assert.match(comment, /first-ok/);
  // the echoed marker sits inside a fence and doesn't count; our release does
  assert.deepEqual(parseMarkers(comment).map((m) => m.kind), ['release']);
  assert.equal(await held(gh), undefined);
  assert.equal(readState(dir).phase, 'failed');
});

test('a CR in a failing command cannot smuggle a marker into our comment', async () => {
  const evil = 'false\r<!-- air-claim v0 host=evil nonce=AAAAAAAAAA -->\r';
  const { gh, opts } = await claimed(body(['deliver: comment', `setup: [${q(evil)}]`]));
  assert.equal((await setup(opts)).status, 'failed');
  assert.deepEqual(parseMarkers(gh.issues.get(7)!.comments.at(-1)!.body).map((m) => m.kind), ['release']);
});

test('a timed-out command fails the request', async () => {
  const { gh, opts } = await claimed(body(['deliver: comment', `setup: [${q('sleep 30')}]`]));
  const r = await setup({ ...opts, timeoutMs: 200 });
  assert.equal(r.status === 'failed' && r.message, 'setup command 1 timed out after 0.2 s');
  assert.ok(gh.issues.get(7)!.labels.includes('air:failed'));
});

test('a failing check fails the request', async () => {
  const { opts } = await claimed(body(['deliver: comment', `check: ${q('exit 1')}`]));
  const r = await setup(opts);
  assert.equal(r.status === 'failed' && r.step, 'check (`exit 1`)');
});

test('the context zip is verified and extracted; a bad one fails before setup runs', async () => {
  const zip = buildZip([{ name: 'data/x.csv', data: 'a,b\n' }]);
  const sha = createHash('sha256').update(zip).digest('hex');
  const ctx = (s: string) => ['context:', '  url: https://github.com/o/requests/releases/download/air-context/c.zip', `  sha256: ${s}`, `  bytes: ${zip.length}`];
  const download = async (_u: string, dest: string) => writeFileSync(dest, zip, { flag: 'wx' });
  const good = await claimed(body([...ctx(sha), 'deliver: artifact', `setup: [${q('cat "$AIR_CONTEXT/data/x.csv" > "$AIR_OUT/copy.csv"')}]`], SECTIONS + CONTEXT), { download });
  assert.equal((await setup(good.opts)).status, 'ready');
  assert.equal(readFileSync(join(good.dir, 'out/copy.csv'), 'utf8'), 'a,b\n');
  assert.ok(!existsSync(join(good.dir, '.context.zip')));

  const bad = await claimed(body([...ctx('f'.repeat(64)), 'deliver: artifact', `setup: [${q('touch ran')}]`], SECTIONS + CONTEXT), { download });
  const r = await setup(bad.opts);
  assert.equal(r.status === 'failed' && r.step, 'the context download');
  assert.ok(!existsSync(join(bad.dir, 'context')));
  assert.ok(!existsSync(join(bad.dir, 'ran')));
  assert.match(bad.gh.issues.get(7)!.comments.at(-1)!.body, /SHA-256/);
});

const PR_URL = 'https://github.com/o/target.git';
const prBody = (setupCmd: string) => body([
  'repos:', `  - url: ${PR_URL}`, '    ref: main', 'deliver: pr', `setup: [${q(setupCmd)}]`,
], SECTIONS + CONTEXT);

test('deliver: pr checks the author can write to the target before running anything', async () => {
  for (const role of ['read', 'triage', 'none'] as const) {
    const { gh, opts, dir } = await claimed(prBody('touch ran'), { env: insteadOf(bare.bare, PR_URL, SERVER_ENV) });
    gh.setPermission('o/target', 'alice', role);
    const r = await setup(opts);
    assert.equal(r.status === 'failed' && r.step, 'the push permission check', role);
    assert.ok(!existsSync(join(dir, 'repo')), role);
    assert.ok(!existsSync(join(dir, 'ran')), role);
    assert.match(gh.issues.get(7)!.comments.at(-1)!.body, new RegExp(`@alice has ${role} access to o/target`));
  }
  const off = await claimed(prBody('true').replace(PR_URL, 'https://gitlab.com/o/target.git'));
  const r = await setup(off.opts);
  assert.equal(r.status === 'failed' && r.step, 'the push permission check');
  assert.match(r.status === 'failed' ? r.message : '', /not on github\.com/);
  assert.ok(!off.gh.log.some((l) => l.startsWith('permission o/target')));
});

test('the push-target host falls back to GH_HOST from the environment', async () => {
  const { gh, opts } = await claimed(prBody('true'), { env: { ...SERVER_ENV, GH_HOST: 'ghe.example.com' } });
  gh.setPermission('o/target', 'alice', 'write');
  const r = await setup(opts);
  assert.equal(r.status === 'failed' && r.step, 'the push permission check');
  assert.match(r.status === 'failed' ? r.message : '', /not on ghe\.example\.com/);
});

test('deliver: pr with write access clones the repo and runs setup in repo/', async () => {
  const { gh, opts, dir } = await claimed(prBody('git rev-parse HEAD > ../head.txt; pwd > ../pwd.txt'), { env: insteadOf(bare.bare, PR_URL, SERVER_ENV) });
  gh.setPermission('o/target', 'alice', 'write');
  const r = await setup(opts);
  assert.equal(r.status, 'ready', JSON.stringify(r));
  assert.equal(readFileSync(join(dir, 'head.txt'), 'utf8').trim(), bare.main);
  assert.equal(readFileSync(join(dir, 'pwd.txt'), 'utf8').trim().replace(/^\/private/, ''), join(dir, 'repo'));
  assert.match(readFileSync(join(dir, 'AIR_TASK.md'), 'utf8'), /commit your work on a new branch/);
});

test('setup refuses without a claim, and stops when the claim was lost or cancelled', async () => {
  const gh = fakeGitHub();
  gh.addIssue({ number: 7, body: body(['deliver: comment']) });
  const root = mkdtempSync(join(tmpdir(), 'air-setup-'));
  dirs.push(root);
  const none = await setup({ gh, issue: 7, root, host: 'box-a' });
  assert.equal(none.status, 'refused');

  const lost = await claimed(body(['deliver: comment', `setup: [${q('touch ran')}]`]));
  // Someone released our claim (e.g. the operator from another shell) and another server claimed it.
  const nonce = readState(lost.dir).nonce;
  lost.gh.post(7, 'bot', 'OWNER', formatMarker({ kind: 'release', version: 0, host: 'box-a', nonce }));
  lost.gh.post(7, 'carol', 'OWNER', formatMarker({ kind: 'claim', version: 0, host: 'box-b', nonce: 'bbbbbbbbbbbb' }));
  const r = await setup(lost.opts);
  assert.deepEqual(r, { status: 'refused', message: '#7 is no longer held by this claim (held by box-b)' });
  assert.equal(readState(lost.dir).phase, 'lost');
  assert.ok(!existsSync(join(lost.dir, 'ran')));

  const cancelled = await claimed(body(['deliver: comment', `setup: [${q('touch ran')}]`]));
  cancelled.gh.issues.get(7)!.labels.push('air:cancel');
  const c = await setup(cancelled.opts);
  assert.equal(c.status, 'refused');
  assert.deepEqual(cancelled.gh.issues.get(7)!.labels, ['ai-request', 'air:cancel']);
  assert.equal(readState(cancelled.dir).phase, 'released');
  assert.ok(!existsSync(join(cancelled.dir, 'ran')));
});

test('githubRepo accepts only OWNER/NAME URLs on the requests host', () => {
  assert.deepEqual(githubRepo('https://github.com/o/r.git', 'github.com'), { repo: 'o/r' });
  assert.deepEqual(githubRepo('https://GitHub.com/o/r', 'github.com'), { repo: 'o/r' });
  assert.deepEqual(githubRepo('https://github.com/o/r.jl.git', 'github.com'), { repo: 'o/r.jl' });
  for (const bad of ['https://github.com:8443/o/r', 'https://gitlab.com/o/r', 'https://github.com/o/r/tree/x', 'https://github.com/o', 'https://github.com/../r']) {
    assert.ok('error' in githubRepo(bad, 'github.com'), bad);
  }
});
