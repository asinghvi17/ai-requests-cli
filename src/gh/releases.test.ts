import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGh, type RunResult } from './gh.ts';
import { releases } from './releases.ts';

/** A gh runner that answers from a table keyed by the first two argv words and the path. */
function scripted(answers: Record<string, RunResult | (() => RunResult)>) {
  const calls: string[][] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    const key = args[0] === 'api' ? `${args[1]} ${args[args.indexOf('--method') + 1] || 'GET'}` : args.slice(0, 2).join(' ');
    const a = answers[key] ?? answers[args[1]!];
    if (!a) return { code: 1, stdout: '', stderr: `gh: Not Found (HTTP 404)` };
    return typeof a === 'function' ? a() : a;
  };
  return { run, calls };
}
const ok = (v: unknown): RunResult => ({ code: 0, stdout: JSON.stringify(v), stderr: '' });
const ASSET = { id: 9, name: 'ctx.zip', browser_download_url: 'https://github.com/o/r/releases/download/air-context/ctx.zip', size: 5 };

test('upload creates the release when missing, then uses gh release upload', async () => {
  let created = false;
  const s = scripted({
    'repos/o/r/releases/tags/air-context GET': () => (created ? ok({ id: 7 }) : { code: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' }),
    'repos/o/r/releases POST': () => { created = true; return ok({ id: 7 }); },
    'release upload': ok(''),
    'repos/o/r/releases/7/assets?per_page=100': ok([[ASSET]]),
  });
  const r = releases('o/r', createGh(s.run), s.run);
  assert.deepEqual(await r.upload('air-context', '/tmp/x/ctx.zip'), { id: 9, name: 'ctx.zip', url: ASSET.browser_download_url, size: 5 });
  assert.deepEqual(s.calls.find((c) => c[0] === 'release'), ['release', 'upload', 'air-context', '/tmp/x/ctx.zip', '--repo', 'o/r']);
  assert.ok(created);
});

test('assets of a missing release are empty; deleting a gone asset is fine', async () => {
  const s = scripted({});
  const r = releases('o/r', createGh(s.run), s.run);
  assert.deepEqual(await r.assets('air-artifacts'), []);
  await r.deleteAsset(3);
  assert.deepEqual(s.calls.at(-1), ['api', 'repos/o/r/releases/assets/3', '--method', 'DELETE']);
  await assert.rejects(r.assets('bad tag'), /bad release tag/);
});

test('issues and comments map the REST shapes', async () => {
  const s = scripted({
    'repos/o/r/issues?state=all&per_page=100': ok([[{ number: 1, state: 'closed', labels: [{ name: 'air:paused' }], body: null, closed_at: '2026-01-01T00:00:00Z' }]]),
    'repos/o/r/issues/comments?per_page=100': ok([[{ id: 5, issue_url: 'https://api.github.com/repos/o/r/issues/12', body: 'b', user: { login: 'u' }, author_association: 'OWNER', created_at: 't', updated_at: 't' }]]),
    'repos/o/r/issues POST': ok({ number: 3, html_url: 'https://github.com/o/r/issues/3' }),
  });
  const r = releases('o/r', createGh(s.run), s.run);
  assert.deepEqual(await r.issues(), [{ number: 1, state: 'closed', labels: ['air:paused'], body: '', closedAt: '2026-01-01T00:00:00Z' }]);
  assert.deepEqual(await r.comments(), [{ id: 5, issue: 12, body: 'b', author: 'u', authorAssociation: 'OWNER', createdAt: 't', updatedAt: 't' }]);
  assert.deepEqual(await r.createIssue('T', 'B', ['ai-request']), { number: 3, url: 'https://github.com/o/r/issues/3' });
});
