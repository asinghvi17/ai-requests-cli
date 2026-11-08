import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GhError } from '../gh/gh.ts';
import { fakeReleases } from '../gh/releases-fake.ts';
import { lint } from '../spec/lint.ts';
import { extractZip } from '../workspace/zip.ts';
import { SubmitError, submit } from './submit.ts';
import { FAKE, cleanup, tmp, tree } from './fixture.ts';

after(cleanup);

const NOW = new Date('2026-11-07T12:00:00Z');
const BODY = `---
air: 0
effort: S
deliver: comment
---

## Task

Summarise the CSV files in the context zip.

## Done when

- A table of row counts per file

## Context

Two CSV files under data/.
`;

function project() {
  return tree({
    '.gitignore': 'out/\n',
    'data/a.csv': 'x,y\n1,2\n',
    'data/b.csv': 'x,y\n3,4\n',
    'out/result.txt': 'ignored',
    'node_modules/m/index.js': 'excluded',
  });
}

test('submit zips the dir, uploads it, fills in context: and files the issue', async () => {
  const gh = fakeReleases();
  const lines: string[] = [];
  const r = await submit({ repo: 'o/requests', body: BODY, dir: project(), releases: gh, now: NOW, log: (s) => lines.push(s) });

  assert.deepEqual(r.files, ['.gitignore', 'data/a.csv', 'data/b.csv']);
  const [asset] = gh.assetsByTag.get('air-context')!;
  assert.ok(asset);
  assert.match(asset.name, /^[A-Za-z0-9._-]+-20261107-[0-9a-f]{8}\.zip$/);
  assert.deepEqual(gh.log, [`upload air-context ${asset.name}`, `createIssue ${r.title}`]);

  // The issue body carries the uploaded asset's URL, size and digest, and still lints.
  assert.equal(gh.filed.length, 1);
  const filed = gh.filed[0]!;
  assert.deepEqual(filed.labels, ['ai-request']);
  assert.equal(filed.title, 'Summarise the CSV files in the context zip.');
  assert.equal(filed.body, r.body);
  const linted = lint(filed.body);
  assert.ok(linted.ok, JSON.stringify(linted.errors));
  assert.deepEqual(linted.request!.context, {
    url: asset.url, bytes: asset.data!.length, sha256: createHash('sha256').update(asset.data!).digest('hex'), expires: '2026-12-07',
  });
  assert.equal(r.issue!.url, 'https://github.com/o/requests/issues/1');

  // The uploaded zip extracts to the collected files.
  const zip = join(tmp(), 'c.zip');
  writeFileSync(zip, asset.data!);
  const dest = join(tmp(), 'context');
  await extractZip(zip, dest, 1 << 20);
  assert.deepEqual(readdirSync(dest).sort(), ['.gitignore', 'data']);
  assert.equal(readFileSync(join(dest, 'data', 'b.csv'), 'utf8'), 'x,y\n3,4\n');
  assert.ok(lines.some((l) => l.startsWith('uploading ')));
});

test('submit uses the URL GitHub reports for the asset', async () => {
  const gh = fakeReleases('o/requests', { host: 'ghe.example.com' });
  const r = await submit({ repo: 'o/requests', body: BODY, dir: project(), releases: gh, now: NOW, expires: '2027-01-31' });
  assert.match(r.context!.url, /^https:\/\/ghe\.example\.com\/o\/requests\/releases\/download\/air-context\//);
  assert.equal(lint(gh.filed[0]!.body).request!.context!.url, r.context!.url);
  assert.equal(lint(gh.filed[0]!.body).request!.context!.expires, '2027-01-31');
});

test('dry run returns the final body and file list and touches nothing', async () => {
  const gh = fakeReleases();
  const r = await submit({ repo: 'o/requests', body: BODY, dir: project(), releases: gh, now: NOW, dryRun: true, title: 'CSV summary' });
  assert.equal(r.title, 'CSV summary');
  assert.deepEqual(r.files, ['.gitignore', 'data/a.csv', 'data/b.csv']);
  assert.equal(r.issue, undefined);
  assert.match(r.body, /^context:\n {2}url: https:\/\/github\.com\/o\/requests\/releases\/download\/air-context\/.+\.zip\n {2}sha256: [0-9a-f]{64}\n {2}bytes: \d+\n {2}expires: 2026-12-07\n---$/m);
  assert.ok(lint(r.body).ok);
  assert.deepEqual(gh.log, []);
});

test('submit without a dir files the body as is', async () => {
  const gh = fakeReleases();
  const body = BODY.replace(/## Context[\s\S]*/, '');
  const r = await submit({ repo: 'o/requests', body, releases: gh, now: NOW, title: 'T' });
  assert.equal(gh.filed[0]!.body, body);
  assert.equal(r.context, undefined);
  assert.deepEqual(gh.log, ['createIssue T']);
});

test('submit refuses a body that fails lint, with line numbers of the body as given', async () => {
  const gh = fakeReleases();
  const refused = (body: string, want: [number, string][]) =>
    assert.rejects(submit({ repo: 'o/requests', body, dir: project(), releases: gh, now: NOW }), (e: unknown) => {
      assert.ok(e instanceof SubmitError && e.lint);
      assert.deepEqual(e.lint.errors.map((d) => [d.line, d.code]), want);
      return true;
    });
  await refused(BODY.replace('effort: S', 'effort: XXL'), [[3, 'value']]);
  // The zip makes `## Context` required; the error points past the generated lines.
  const noContext = BODY.replace(/## Context[\s\S]*/, '');
  await refused(noContext, [[noContext.split('\n').length, 'missing']]);
  assert.deepEqual(gh.log, []);
});

test('submit refuses a body that already sets context: when given a dir', async () => {
  const body = BODY.replace('deliver: comment', 'deliver: comment\ncontext:\n  url: https://x.test/a.zip\n  sha256: ab\n  bytes: 1');
  await assert.rejects(submit({ repo: 'o/requests', body, dir: project(), releases: fakeReleases(), now: NOW }), /already sets `context:`/);
});

test('a filled-in issue template submits without its GitHub header', async () => {
  const gh = fakeReleases();
  const body = `---\nname: AI request\nabout: x\nlabels: ai-request\n---\n${BODY}`;
  const r = await submit({ repo: 'o/requests', body, releases: gh, dir: project(), now: NOW });
  assert.ok(r.body.startsWith('---\nair: 0\n'));
});

test('secrets are refused, listed, and allowed one by one with --allow-file', async () => {
  const dir = tree({
    'data/a.csv': 'x\n',
    '.env': 'A=1',
    'notes.txt': `token: ${FAKE.ghp}`,
    '.aws/credentials': '[default]',
  });
  const gh = fakeReleases();
  await assert.rejects(submit({ repo: 'o/requests', body: BODY, dir, releases: gh, now: NOW }), (e: unknown) => {
    assert.ok(e instanceof SubmitError);
    assert.match(e.message, /look like secrets:\n {2}\.aws\/credentials: .+\n {2}\.env: environment file\n {2}notes\.txt: GitHub token/);
    assert.ok(!e.message.includes(FAKE.ghp));
    return true;
  });
  await assert.rejects(submit({ repo: 'o/requests', body: BODY, dir, releases: gh, now: NOW, allowFiles: ['.env', '.aws'] }), (e: unknown) =>
    e instanceof SubmitError && !e.message.includes('.env:') && e.message.includes('notes.txt'));
  assert.deepEqual(gh.log, []);
  const r = await submit({ repo: 'o/requests', body: BODY, dir, releases: gh, now: NOW, allowFiles: ['.env', '.aws', 'notes.txt'], dryRun: true });
  assert.deepEqual(r.files, ['.aws/credentials', '.env', 'data/a.csv', 'notes.txt']);
});

test('a failure filing the issue deletes the uploaded zip', async () => {
  const gh = fakeReleases();
  gh.createIssue = async () => { throw new GhError('validation', 'Validation Failed (HTTP 422)', 422); };
  await assert.rejects(submit({ repo: 'o/requests', body: BODY, dir: project(), releases: gh, now: NOW }), /Validation Failed/);
  assert.deepEqual(gh.assetsByTag.get('air-context'), []);
});

test('submit validates --expires', async () => {
  for (const expires of ['2026-13-01x', 'tomorrow', '2026-11-06']) {
    await assert.rejects(submit({ repo: 'o/requests', body: BODY, releases: fakeReleases(), now: NOW, expires }), SubmitError);
  }
});
