import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Asset } from '../spec/frontmatter.ts';
import { ContextError, type Download } from '../workspace/context.ts';
import { insteadOf, insteadOfAll, makeBareRepo, type BareRepo } from '../workspace/git-fixture.ts';
import { buildZip } from '../workspace/zip-fixture.ts';
import { fetchResult, FetchError, parsePullUrl, type FetchOptions } from './fetch.ts';
import { requestBody, requestIssue, result } from './fixture.ts';

const URL_BASE = 'https://github.com/o/requests/releases/download/air-artifacts';
const SERVICE = 'https://github.com/acme/service.git';
const dirs: string[] = [];
let bare: BareRepo;
before(() => {
  const d = mkdtempSync(join(tmpdir(), 'air-fetch-test-'));
  dirs.push(d);
  bare = makeBareRepo(d);
});
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'air-fetch-test-'));
  dirs.push(d);
  return d;
}

/** Serves `files` by URL, like a release download, aborting past `max`. */
function serve(files: Record<string, Buffer>): Download {
  return async (url, dest, max) => {
    const data = files[url];
    if (!data) throw new ContextError('download failed: HTTP 404');
    if (data.length > max) throw new ContextError(`download passed the ${max} bytes declared; aborted`);
    writeFileSync(dest, data, { flag: 'wx' });
  };
}

function asset(name: string, data: Buffer): Asset {
  return { url: `${URL_BASE}/${name}`, sha256: createHash('sha256').update(data).digest('hex'), bytes: data.length };
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function opts(gh: FetchOptions['gh'], dir: string, files: Record<string, Buffer> = {}): FetchOptions {
  return { gh, issue: 1, dir, download: serve(files), env: insteadOf(bare.bare, SERVICE), ghHost: 'github.com' };
}

test('done with deliver: pr: the report and each PR head branch under repo/', async () => {
  const gh = requestIssue({ labels: ['air:done'], results: [{ report: '# Report\n\nAll done.', result: result({ prs: [{ repo: 'service', url: 'https://github.com/acme/service/pull/7' }] }) }] });
  gh.pulls.set('acme/service#7', { ref: 'feature', sha: bare.first, cloneUrl: SERVICE });
  const dir = join(tmp(), 'air-1');
  const r = await fetchResult(opts(gh, dir));
  assert.deepEqual(r.written, ['REPORT.md', 'repo/service']);
  assert.equal(readFileSync(join(dir, 'REPORT.md'), 'utf8'), '# Report\n\nAll done.\n');
  const repo = join(dir, 'repo', 'service');
  assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feature');
  assert.equal(git(repo, 'rev-parse', 'HEAD'), bare.first);
});

test('a relative DIR (the default `air-N`) is taken from the current directory, PR branches included', async () => {
  const gh = requestIssue({ labels: ['air:done'], results: [{ report: 'Done.', result: result({ prs: [{ repo: 'service', url: 'https://github.com/acme/service/pull/7' }] }) }] });
  gh.pulls.set('acme/service#7', { ref: 'feature', sha: bare.first, cloneUrl: SERVICE });
  const cwd = process.cwd();
  const base = tmp();
  process.chdir(base);
  try {
    assert.deepEqual((await fetchResult(opts(gh, 'air-1'))).written, ['REPORT.md', 'repo/service']);
  } finally {
    process.chdir(cwd);
  }
  assert.deepEqual(readdirSync(join(base, 'air-1')).sort(), ['REPORT.md', 'repo']);
  assert.equal(git(join(base, 'air-1', 'repo', 'service'), 'rev-parse', 'HEAD'), bare.first);
});

test('done with deliver: artifact: verified and extracted into artifact/; a long report is downloaded', async () => {
  const zip = buildZip([{ name: 'out/' }, { name: 'out/data.csv', data: 'a,b\n1,2\n' }, { name: 'REPORT.md', data: 'r' }]);
  const art = asset('air-1-aaaaaaaa.zip', zip);
  const report = `${URL_BASE}/air-1-aaaaaaaa-report.md`;
  const gh = requestIssue({ results: [{ report: '**Truncated:** ...', result: result({ deliver: 'artifact', artifact: art, report }) }] });
  const dir = join(tmp(), 'out-here');
  const r = await fetchResult(opts(gh, dir, { [art.url]: zip, [report]: Buffer.from('the whole report\n') }));
  assert.deepEqual(r.written, ['REPORT.md', 'artifact/']);
  assert.equal(readFileSync(join(dir, 'REPORT.md'), 'utf8'), 'the whole report\n');
  assert.equal(readFileSync(join(dir, 'artifact', 'out', 'data.csv'), 'utf8'), 'a,b\n1,2\n');
  assert.deepEqual(readdirSync(dir).sort(), ['REPORT.md', 'artifact']);
});

test('partial: checkpoint branches at their sha, on their branch, and out/', async () => {
  const zip = buildZip([{ name: 'PROGRESS.md', data: 'half way\n' }]);
  const out = asset('air-1-aaaaaaaa-out.zip', zip);
  const resume = { branches: [{ repo: 'service', branch: 'air/1', sha: bare.first }], out };
  const gh = requestIssue({ labels: ['air:partial'], results: [{ result: result({ status: 'partial', resume }), release: true }] });
  const dir = join(tmp(), 'p');
  const r = await fetchResult(opts(gh, dir, { [out.url]: zip }));
  assert.deepEqual(r.written, ['REPORT.md', 'repo/service', 'out/']);
  const repo = join(dir, 'repo', 'service');
  assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'air/1');
  assert.equal(git(repo, 'rev-parse', 'HEAD'), bare.first);
  assert.equal(readFileSync(join(dir, 'out', 'PROGRESS.md'), 'utf8'), 'half way\n');
  // The release marker is not part of the report.
  assert.equal(readFileSync(join(dir, 'REPORT.md'), 'utf8'), 'The report.\n');
});

test('multi-repo: each PR and each checkpoint branch in its own repo/<path>', async () => {
  const CLIENT = 'https://github.com/acme/client.git';
  const body = requestBody([`  - url: ${CLIENT}`, '    ref: main']);
  const env = insteadOfAll([[bare.bare, SERVICE], [bare.bare, CLIENT]]);
  const prs = [{ repo: 'service', url: 'https://github.com/acme/service/pull/7' }, { repo: 'client', url: 'https://github.com/acme/client/pull/3' }];
  const gh = requestIssue({ body, labels: ['air:done'], results: [{ result: result({ prs }) }] });
  gh.pulls.set('acme/service#7', { ref: 'air/1', sha: bare.first, cloneUrl: SERVICE });
  gh.pulls.set('acme/client#3', { ref: 'air/1', sha: bare.main, cloneUrl: CLIENT });
  const dir = join(tmp(), 'm');
  assert.deepEqual((await fetchResult({ ...opts(gh, dir), env })).written, ['REPORT.md', 'repo/service', 'repo/client']);
  assert.equal(git(join(dir, 'repo', 'service'), 'rev-parse', 'HEAD'), bare.first);
  assert.equal(git(join(dir, 'repo', 'client'), 'rev-parse', 'HEAD'), bare.main);

  const resume = { branches: [{ repo: 'service', branch: 'air/1', sha: bare.first }, { repo: 'client', branch: 'air/1-2', sha: bare.dangling }] };
  const p = requestIssue({ body, labels: ['air:partial'], results: [{ result: result({ status: 'partial', resume }), release: true }] });
  const pdir = join(tmp(), 'p');
  assert.deepEqual((await fetchResult({ ...opts(p, pdir), env })).written, ['REPORT.md', 'repo/service', 'repo/client']);
  assert.equal(git(join(pdir, 'repo', 'client'), 'rev-parse', '--abbrev-ref', 'HEAD'), 'air/1-2');
  assert.equal(git(join(pdir, 'repo', 'client'), 'rev-parse', 'HEAD'), bare.dangling);
});

test('a bad hash or a zip-slip entry stops the fetch, and nothing of that zip is extracted', async () => {
  const zip = buildZip([{ name: 'ok.txt', data: 'x' }]);
  const art = asset('a.zip', zip);
  const gh = requestIssue({ results: [{ result: result({ deliver: 'artifact', artifact: { ...art, sha256: '0'.repeat(64) } }) }] });
  const dir = join(tmp(), 'bad');
  await assert.rejects(fetchResult(opts(gh, dir, { [art.url]: zip })), (e: unknown) => e instanceof FetchError && /artifact zip SHA-256 is [0-9a-f]{64}, the result says 0{64}/.test(e.message));
  assert.ok(!existsSync(join(dir, 'artifact')));

  const evil = buildZip([{ name: 'fine.txt', data: 'x' }, { name: '../escape.txt', data: 'x' }]);
  const evilAsset = asset('e.zip', evil);
  const gh2 = requestIssue({ results: [{ result: result({ deliver: 'artifact', artifact: evilAsset }) }] });
  const dir2 = join(tmp(), 'evil');
  await assert.rejects(fetchResult(opts(gh2, dir2, { [evilAsset.url]: evil })), (e: unknown) => e instanceof FetchError && /artifact zip rejected/.test(e.message));
  assert.ok(!existsSync(join(dir2, 'artifact')));
  assert.ok(!existsSync(join(dir2, '..', 'escape.txt')));
});

test('refusals: no result yet, a non-empty DIR, a PR on another host', async () => {
  await assert.rejects(fetchResult(opts(requestIssue(), join(tmp(), 'x'))), /#1 has no result yet/);
  const full = tmp();
  mkdirSync(join(full, 'something'));
  await assert.rejects(fetchResult(opts(requestIssue({ results: [{ result: result() }] }), full)), /is not empty/);
  assert.throws(() => parsePullUrl('https://gitlab.com/a/b/pull/1', 'github.com'), /not on github\.com/);
  assert.throws(() => parsePullUrl('https://github.com/a/b/issues/1', 'github.com'), /not a pull request URL/);
  assert.deepEqual(parsePullUrl('https://GitHub.com/a/b/pull/12', 'github.com'), { repo: 'a/b', number: 12 });
});
