import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fakeReleases, type FakeReleases } from '../gh/testing/releases-fake.ts';
import { lint } from '../spec/lint.ts';
import { cleanup, tmp, tree } from '../submit/fixture.ts';
import { lintDeps } from './lint.ts';
import { main } from './main.ts';
import { submitDeps } from './submit.ts';
import { sweepDeps } from './sweep.ts';

after(cleanup);

async function call(...argv: string[]) {
  let out = '';
  let err = '';
  const code = await main(argv, { out: (s) => { out += s; }, err: (s) => { err += s; } });
  return { code, out, err };
}

const BODY = '---\nair: 0\neffort: S\ndeliver: comment\n---\n\n## Task\n\nCount rows.\n\n## Done when\n\n- a count\n\n## Context\n\ndata/\n';

let gh: FakeReleases;
let answers: string[];
beforeEach(() => {
  gh = fakeReleases();
  answers = [];
  submitDeps.releases = () => gh;
  submitDeps.isTTY = () => false;
  submitDeps.prompter = () => ({ ask: async () => answers.shift() ?? '', close: () => {} });
});

function bodyFile(text = BODY): string {
  const f = join(tmp(), 'request.md');
  writeFileSync(f, text);
  return f;
}

test('air lint reports errors with line numbers and exits 1; ok exits 0', async () => {
  const bad = await call('lint', bodyFile(BODY.replace('effort: S', 'effort: Q')));
  assert.equal(bad.code, 1);
  assert.match(bad.err, /request\.md:3: error: `effort` must be one of/);
  assert.match(bad.err, /request\.md: 1 error\n$/);
  const good = await call('lint', bodyFile(BODY + '\n## Extra\n\nx\n'));
  assert.equal(good.code, 0);
  assert.match(good.out, /request\.md:19: warning: unknown section/);
  assert.match(good.out, /request\.md: ok\n$/);
  lintDeps.readStdin = () => BODY;
  assert.deepEqual(await call('lint', '-'), { code: 0, out: '<stdin>: ok\n', err: '' });
  assert.deepEqual(await call('lint'), { code: 0, out: '<stdin>: ok\n', err: '' });
  const missing = await call('lint', join(tmp(), 'nope.md'));
  assert.equal(missing.code, 1);
  assert.match(missing.err, /^air lint: .*ENOENT/);
});

test('air submit --dry-run prints the final body and the zip file list', async () => {
  const dir = tree({ 'data/a.csv': '1\n', '.git/HEAD': 'x' });
  const r = await call('submit', '--repo', 'o/requests', '--body', bodyFile(), '--dry-run', dir);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^title: Count rows\.\n\n---\nair: 0\n[\s\S]*\ncontext:\n {2}url: https:\/\/github\.com\/o\/requests\/releases\/download\/air-context\//);
  assert.match(r.out, /\ncontext zip \(\d+ bytes, 1 files\):\n {2}data\/a\.csv\n\ndry run: nothing uploaded, no issue filed\n$/);
  assert.deepEqual(gh.log, []);
});

test('air submit uploads and files the issue', async () => {
  const dir = tree({ 'data/a.csv': '1\n' });
  const r = await call('submit', '--repo', 'o/requests', '--body', bodyFile(), '--title', 'Rows', dir);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^uploaded https:\/\/github\.com\/o\/requests\/releases\/download\/air-context\/.+\.zip\nfiled https:\/\/github\.com\/o\/requests\/issues\/1\n$/);
  assert.equal(gh.filed[0]!.title, 'Rows');
});

test('air submit refuses secrets and lint errors with exit 1', async () => {
  const dir = tree({ 'data/a.csv': '1\n', 'id_rsa': 'x' });
  const r = await call('submit', '--repo', 'o/requests', '--body', bodyFile(), dir);
  assert.equal(r.code, 1);
  assert.match(r.err, /look like secrets:\n {2}id_rsa: SSH private key\n/);
  assert.equal((await call('submit', '--repo', 'o/requests', '--body', bodyFile(), '--allow-file', 'id_rsa', '--dry-run', dir)).code, 0);
  const bad = await call('submit', '--repo', 'o/requests', '--body', bodyFile(BODY.replace('deliver: comment', 'deliver: email')));
  assert.equal(bad.code, 1);
  assert.match(bad.err, /request\.md:4: error: `deliver`.*\nair submit: the request does not pass `air lint`\n$/);
  assert.deepEqual(gh.log, []);
});

test('air submit needs --body off a terminal and a repo', async () => {
  const r = await call('submit', '--repo', 'o/requests');
  assert.equal(r.code, 2);
  assert.match(r.err, /pass --body FILE/);
  assert.match((await call('submit', '--repo', 'bad', '--body', bodyFile())).err, /--repo must be OWNER\/NAME/);
});

test('air submit on a terminal fills in the template from prompts and confirms', async () => {
  submitDeps.isTTY = () => true;
  const dir = tree({ 'data/a.csv': '1\n' });
  const script = [
    'Count the rows', 'm', '', 'claude', 'large', '', // title, effort, deliver, harness, model, repo
    'npm ci', '', 'true', '', '90m', // setup, end setup, check, deadline, timeout
    'Count rows in data/a.csv.', '.', // task
    'a number', '', // done when
    'One CSV.', '.', // context
    '.', // notes
  ];
  answers = [...script, 'y'];
  const r = await call('submit', '--repo', 'o/requests', dir);
  assert.equal(r.code, 0, r.err);
  const filed = gh.filed[0]!;
  assert.equal(filed.title, 'Count the rows');
  const l = lint(filed.body);
  assert.ok(l.ok, JSON.stringify(l.errors));
  assert.deepEqual(
    { effort: l.request!.effort, deliver: l.request!.deliver, harness: l.request!.harness, model: l.request!.model, setup: l.request!.setup, check: l.request!.check, timeout: l.request!.timeoutMinutes },
    { effort: 'M', deliver: 'comment', harness: ['claude'], model: 'large', setup: ['npm ci'], check: 'true', timeout: 90 },
  );
  assert.match(l.sections['Done when']!.text, /^- a number$/);

  // Declining files nothing.
  gh = fakeReleases();
  answers = [...script, 'n'];
  const no = await call('submit', '--repo', 'o/requests', dir);
  assert.equal(no.code, 1);
  assert.deepEqual(gh.filed, []);
});

test('air sweep wires the sweep and exits 1 on a failed delete', async () => {
  const sg = fakeReleases();
  const a = sg.addAsset('air-context', 'old.zip');
  sg.issueList.push({ number: 1, state: 'closed', labels: [], closedAt: '2020-01-01T00:00:00Z', body: `---\nair: 0\neffort: S\ndeliver: comment\ncontext:\n  url: ${a.url}\n  sha256: ${'a'.repeat(64)}\n  bytes: 1\n---\n` });
  sweepDeps.releases = () => sg;
  sweepDeps.trust = () => async () => true;
  const dry = await call('sweep', '--repo', 'o/requests', '--dry-run');
  assert.deepEqual(dry, { code: 0, out: 'would delete air-context/old.zip (100 bytes; #1)\nwould delete 1, kept 0\n', err: '' });
  sg.failDelete.add(a.id);
  const failed = await call('sweep', '--repo', 'o/requests');
  assert.equal(failed.code, 1);
  assert.match(failed.out, /failed to delete air-context\/old\.zip: .*\ndeleted 0, kept 0, failed 1\n$/);
  sg.failDelete.clear();
  assert.equal((await call('sweep', '--repo', 'o/requests')).code, 0);
  assert.equal(sg.assetsByTag.get('air-context')!.length, 0);
});
