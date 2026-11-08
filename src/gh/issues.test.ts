import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGh, type RunResult } from './gh.ts';
import { requestsRepo } from './issues.ts';

/** A gh runner answering by path; records argv and stdin. */
function fake(answers: Record<string, Partial<RunResult>>) {
  const calls: string[] = [];
  const gh = createGh(async (args, input) => {
    calls.push([...args, ...(input ? [input] : [])].join(' '));
    const hit = Object.entries(answers).find(([k]) => args[1] === k);
    return { code: 0, stdout: '', stderr: '', ...(hit?.[1] ?? {}) };
  });
  return { calls, repo: requestsRepo('o/r', gh) };
}

test('maps issues and comments from the REST shapes', async () => {
  const { repo, calls } = fake({
    'repos/o/r/issues/5': { stdout: JSON.stringify({ number: 5, title: 't', body: null, state: 'open', labels: [{ name: 'ai-request' }, 'x'], user: { login: 'al' }, author_association: 'MEMBER', html_url: 'u' }) },
    'repos/o/r/issues/5/comments?per_page=100': { stdout: JSON.stringify([[{ id: 9, body: 'b', user: { login: 'c' }, author_association: 'OWNER', created_at: 'a', updated_at: 'a' }]]) },
  });
  assert.deepEqual(await repo.issue(5), { number: 5, title: 't', body: '', state: 'open', labels: ['ai-request', 'x'], author: 'al', authorAssociation: 'MEMBER', url: 'u', isPullRequest: false });
  assert.deepEqual(await repo.comments(5), [{ id: 9, body: 'b', author: 'c', authorAssociation: 'OWNER', createdAt: 'a', updatedAt: 'a' }]);
  assert.deepEqual(calls, ['api repos/o/r/issues/5 --method GET', 'api repos/o/r/issues/5/comments?per_page=100 --paginate --slurp']);
});

test('writes go to the right endpoints', async () => {
  const { repo, calls } = fake({ 'repos/o/r/issues/5/comments': { stdout: '{"id":1,"body":"x","user":{"login":"me"},"created_at":"a","updated_at":"a"}' } });
  await repo.comment(5, 'x');
  await repo.deleteComment(1);
  await repo.addLabels(5, ['air:claimed']);
  await repo.removeLabel(5, 'air:claimed');
  await repo.assign(5, 'me');
  await repo.unassign(5, 'me');
  assert.deepEqual(calls, [
    'api repos/o/r/issues/5/comments --method POST --input - {"body":"x"}',
    'api repos/o/r/issues/comments/1 --method DELETE',
    'api repos/o/r/issues/5/labels --method POST --input - {"labels":["air:claimed"]}',
    'api repos/o/r/issues/5/labels/air%3Aclaimed --method DELETE',
    'api repos/o/r/issues/5/assignees --method POST --input - {"assignees":["me"]}',
    'api repos/o/r/issues/5/assignees --method DELETE --input - {"assignees":["me"]}',
  ]);
});

test('removing an absent label is fine; permission reads role_name, 404 is none', async () => {
  const notFound = { code: 1, stderr: 'gh: Not Found (HTTP 404)' };
  const { repo } = fake({
    'repos/o/r/issues/5/labels/x': notFound,
    'repos/o/r/collaborators/m/permission': { stdout: '{"permission":"write","role_name":"maintain"}' },
    'repos/o/r/collaborators/w/permission': { stdout: '{"permission":"write","role_name":"custom-role"}' },
    'repos/o/r/collaborators/n/permission': notFound,
    'repos/o/r/collaborators/dependabot%5Bbot%5D/permission': { stdout: '{"permission":"write","role_name":"write"}' },
  });
  await repo.removeLabel(5, 'x');
  assert.equal(await repo.permission('o/r', 'dependabot[bot]'), 'write');
  assert.equal(await repo.permission('o/r', 'm'), 'maintain');
  assert.equal(await repo.permission('o/r', 'w'), 'write');
  assert.equal(await repo.permission('o/r', 'n'), 'none');
  await assert.rejects(repo.permission('../x', 'm'), /bad repo/);
  await assert.rejects(repo.permission('o/r', '../m'), /bad GitHub login/);
  assert.throws(() => requestsRepo('o/r/x'), /bad repo/);
});
