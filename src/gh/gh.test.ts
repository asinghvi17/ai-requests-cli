import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GhError, createGh, type RunResult, type Runner } from './gh.ts';

function fake(result: Partial<RunResult>) {
  const calls: { args: string[]; input: string | undefined }[] = [];
  const run: Runner = async (args, input) => {
    calls.push({ args, input });
    return { code: 0, stdout: '', stderr: '', ...result };
  };
  return { gh: createGh(run), calls };
}

test('GET parses JSON', async () => {
  const { gh, calls } = fake({ stdout: '{"number":5}' });
  assert.deepEqual(await gh.api('repos/o/r/issues/5'), { number: 5 });
  assert.deepEqual(calls, [{ args: ['api', 'repos/o/r/issues/5', '--method', 'GET'], input: undefined }]);
});

test('body goes on stdin as JSON; empty response is undefined', async () => {
  const { gh, calls } = fake({ stdout: '' });
  assert.equal(await gh.api('repos/o/r/issues/5/assignees', { method: 'POST', body: { assignees: ['me'] }, headers: { Accept: 'x' } }), undefined);
  assert.deepEqual(calls[0], {
    args: ['api', 'repos/o/r/issues/5/assignees', '-H', 'Accept: x', '--method', 'POST', '--input', '-'],
    input: '{"assignees":["me"]}',
  });
});

test('paginate flattens slurped pages and search results', async () => {
  const list = fake({ stdout: '[[{"id":1},{"id":2}],[{"id":3}]]' });
  assert.deepEqual(await list.gh.paginate('repos/o/r/issues?per_page=100'), [{ id: 1 }, { id: 2 }, { id: 3 }]);
  assert.deepEqual(list.calls[0]!.args, ['api', 'repos/o/r/issues?per_page=100', '--paginate', '--slurp']);
  const search = fake({ stdout: '[{"total_count":3,"items":[1,2]},{"total_count":3,"items":[3]}]' });
  assert.deepEqual(await search.gh.paginate('search/issues?q=x'), [1, 2, 3]);
});

test('maps errors by HTTP status', async () => {
  const cases: [Partial<RunResult>, string, number | undefined, RegExp][] = [
    [{ code: 1, stdout: '{"message":"Not Found","status":"404"}', stderr: 'gh: Not Found (HTTP 404)\n' }, 'not_found', 404, /^Not Found \(HTTP 404\)$/],
    [{ code: 1, stderr: 'To get started with GitHub CLI, please run:  gh auth login\n' }, 'auth', undefined, /gh auth login/],
    [{ code: 1, stdout: '{"message":"API rate limit exceeded"}', stderr: 'gh: API rate limit exceeded (HTTP 403)' }, 'rate_limited', 403, /rate limit/],
    [{ code: 1, stdout: '{"message":"Validation Failed","errors":[{"message":"bad label"}]}', stderr: 'gh: Validation Failed (HTTP 422)' }, 'validation', 422, /Validation Failed: bad label/],
    [{ code: 1, stderr: 'gh: Server Error (HTTP 502)' }, 'server', 502, /Server Error/],
    [{ code: 1, stderr: '' }, 'other', undefined, /gh exited 1/],
  ];
  for (const [result, kind, status, re] of cases) {
    await assert.rejects(fake(result).gh.api('x'), (e: unknown) => e instanceof GhError && e.kind === kind && e.status === status && re.test(e.message), kind);
  }
});

test('rejects non-JSON output and flag-like paths', async () => {
  await assert.rejects(fake({ stdout: '<html>' }).gh.api('x'), /not JSON/);
  await assert.rejects(fake({}).gh.api('--hostname=evil'), /bad API path/);
});
