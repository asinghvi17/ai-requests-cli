// For tests: a gh `Runner` that answers `gh api` argv from the in-memory FakeGitHub (src/gh/fake.ts), plus
// releases, assets and pull requests. The real createGh, requestsRepo and serveGitHub run on top of it, so
// tests see the argv and JSON gh would. `hang` makes matching calls never answer (gh timeout tests).
import { readFileSync, writeFileSync } from 'node:fs';
import { GhError, type OutFile, type Runner, type RunResult } from '../gh/gh.ts';
import type { FakeGitHub, FakeIssue } from '../gh/fake.ts';

export interface FakeRelease { id: number; tag: string; assets: { id: number; name: string; data: Buffer; contentType: string }[] }
export interface FakePull { repo: string; number: number; title: string; head: string; base: string; body: string; url: string }

export interface FakeGh {
  run: Runner;
  releases: FakeRelease[];
  pulls: FakePull[];
  /** Every call's args, joined by spaces. */
  calls: string[];
  /** Calls whose joined args match never answer. */
  hang?: (args: string) => boolean;
  /** The first call matching this fails with a 502 (then it is cleared). */
  failOnce?: (args: string) => boolean;
  /** The next PR is created but its response is lost (a 502). */
  failNextPull?: boolean;
}

const ok = (v: unknown): RunResult => ({ code: 0, stdout: v === undefined ? '' : JSON.stringify(v), stderr: '' });
const fail = (status: number, message: string): RunResult => ({ code: 1, stdout: JSON.stringify({ message }), stderr: `gh: ${message} (HTTP ${status})\n` });

function rawIssue(i: FakeIssue) {
  return {
    number: i.number, title: i.title, body: i.body, state: i.state, labels: i.labels.map((name) => ({ name })),
    user: { login: i.author }, author_association: i.authorAssociation, html_url: i.url, assignees: i.assignees.map((login) => ({ login })),
    ...(i.isPullRequest ? { pull_request: {} } : {}),
  };
}

export function fakeGh(gh: FakeGitHub): FakeGh {
  const f: FakeGh = { run: undefined as unknown as Runner, releases: [], pulls: [], calls: [] };
  let nextId = 1;
  const base = `repos/${gh.repo}/`;
  const release = (r: FakeRelease) => ({
    id: r.id, tag_name: r.tag, upload_url: `https://uploads.example.test/${base}releases/${r.id}/assets{?name,label}`,
    assets: r.assets.map((a) => ({ id: a.id, name: a.name })),
  });

  async function answer(args: string[], input: string | undefined, out: OutFile | undefined): Promise<RunResult> {
    if (args[0] !== 'api') return fail(400, `unsupported gh ${args[0]}`);
    const path = args[1]!;
    const method = args.includes('--method') ? args[args.indexOf('--method') + 1]! : 'GET';
    const inputFile = args.includes('--input') ? args[args.indexOf('--input') + 1]! : undefined;
    const body = inputFile === '-' && input ? JSON.parse(input) : undefined;
    const slurp = args.includes('--slurp');
    const page = (v: unknown[]) => ok(slurp ? [v] : v);
    let m: RegExpExecArray | null;
    try {
      if (path === 'user') return ok({ login: await gh.viewer() });
      if ((m = /^https:\/\/uploads\.example\.test\/repos\/[^/]+\/[^/]+\/releases\/(\d+)\/assets\?name=([^&]+)$/.exec(path))) {
        const r = f.releases.find((x) => x.id === Number(m![1]));
        if (!r) return fail(404, 'Not Found');
        const name = decodeURIComponent(m[2]!);
        if (r.assets.some((a) => a.name === name)) return fail(422, 'Validation Failed');
        const hi = args.indexOf('-H');
        const asset = { id: nextId++, name, data: readFileSync(inputFile!), contentType: hi >= 0 ? args[hi + 1]!.replace(/^Content-Type: /, '') : '' };
        r.assets.push(asset);
        return ok({ id: asset.id, name, browser_download_url: `https://github.com/${gh.repo}/releases/download/${r.tag}/${name}` });
      }
      if ((m = /^repos\/([^/]+\/[^/]+)\/collaborators\/([^/]+)\/permission$/.exec(path))) {
        const role = await gh.permission(m[1]!, decodeURIComponent(m[2]!));
        if (role === 'none') return fail(404, 'Not Found');
        return ok({ permission: role === 'maintain' ? 'write' : role === 'triage' ? 'read' : role, role_name: role });
      }
      if ((m = /^repos\/([^/]+\/[^/]+)\/pulls$/.exec(path)) && method === 'POST') {
        const req = body as { head: string };
        if (f.pulls.some((p) => p.repo === m![1] && p.head === req.head)) return fail(422, 'Validation Failed');
        if (f.failNextPull) {
          f.failNextPull = false;
          f.pulls.push({ repo: m[1]!, number: 100 + f.pulls.length, ...(body as { title: string; head: string; base: string; body: string }), url: `https://github.com/${m[1]}/pull/${100 + f.pulls.length}` });
          return fail(502, 'Server Error');
        }
        const number = 100 + f.pulls.length;
        const pr = { repo: m[1]!, number, ...(body as { title: string; head: string; base: string; body: string }), url: `https://github.com/${m[1]}/pull/${number}` };
        f.pulls.push(pr);
        return ok({ number, html_url: pr.url });
      }
      if ((m = /^repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/.exec(path)) && method === 'PATCH') {
        const pr = f.pulls.find((p) => p.repo === m![1] && p.number === Number(m![2]));
        if (!pr) return fail(404, 'Not Found');
        pr.body = (body as { body: string }).body;
        return ok({ number: pr.number, html_url: pr.url });
      }
      if ((m = /^repos\/([^/]+\/[^/]+)\/pulls\?state=open&head=([^&]+)$/.exec(path)) && method === 'GET') {
        const [, branch] = decodeURIComponent(m[2]!).split(':');
        return ok(f.pulls.filter((p) => p.repo === m![1] && p.head === branch).map((p) => ({ number: p.number, html_url: p.url })));
      }
      if (!path.startsWith(base)) return fail(404, 'Not Found');
      const rest = path.slice(base.length);
      if (/^issues\?/.test(rest)) {
        const q = new URLSearchParams(rest.slice('issues?'.length));
        const label = q.get('labels');
        return page([...gh.issues.values()].filter((i) => i.state === q.get('state') && (!label || i.labels.includes(label))).sort((a, b) => a.number - b.number).map(rawIssue));
      }
      if ((m = /^issues\/(\d+)$/.exec(rest))) {
        const i = gh.issues.get(Number(m[1]));
        return i ? ok(rawIssue(i)) : fail(404, 'Not Found');
      }
      if ((m = /^issues\/(\d+)\/comments(\?.*)?$/.exec(rest))) {
        const n = Number(m[1]);
        if (method === 'POST') {
          const c = await gh.comment(n, (body as { body: string }).body);
          return ok({ id: c.id, body: c.body, user: { login: c.author }, author_association: c.authorAssociation, created_at: c.createdAt, updated_at: c.updatedAt });
        }
        const cs = await gh.comments(n);
        return page(cs.map((c) => ({ id: c.id, body: c.body, user: { login: c.author }, author_association: c.authorAssociation, created_at: c.createdAt, updated_at: c.updatedAt })));
      }
      if ((m = /^issues\/comments\/(\d+)$/.exec(rest)) && method === 'DELETE') return ok(await gh.deleteComment(Number(m[1])));
      if (rest === 'labels?per_page=100' && method === 'GET') return page([...gh.labels].map((name) => ({ name })));
      if (rest === 'labels' && method === 'POST') {
        const { name } = body as { name: string };
        if (gh.labels.has(name)) return fail(422, 'Validation Failed');
        gh.labels.add(name);
        return ok({ name });
      }
      if ((m = /^issues\/(\d+)\/labels$/.exec(rest)) && method === 'POST') return ok(await gh.addLabels(Number(m[1]), (body as { labels: string[] }).labels));
      if ((m = /^issues\/(\d+)\/labels\/(.+)$/.exec(rest)) && method === 'DELETE') {
        const i = gh.issues.get(Number(m[1]));
        if (!i?.labels.includes(decodeURIComponent(m[2]!))) return fail(404, 'Label does not exist');
        return ok(await gh.removeLabel(Number(m[1]), decodeURIComponent(m[2]!)));
      }
      if ((m = /^issues\/(\d+)\/assignees$/.exec(rest))) {
        const [login] = (body as { assignees: string[] }).assignees;
        return ok(method === 'POST' ? await gh.assign(Number(m[1]), login!) : await gh.unassign(Number(m[1]), login!));
      }
      if ((m = /^releases\/tags\/(.+)$/.exec(rest))) {
        const r = f.releases.find((x) => x.tag === decodeURIComponent(m![1]!));
        return r ? ok(release(r)) : fail(404, 'Not Found');
      }
      if (rest === 'releases' && method === 'POST') {
        const tag = (body as { tag_name: string }).tag_name;
        if (f.releases.some((x) => x.tag === tag)) return fail(422, 'Validation Failed');
        const r: FakeRelease = { id: nextId++, tag, assets: [] };
        f.releases.push(r);
        return ok(release(r));
      }
      if ((m = /^releases\/(\d+)\/assets\?per_page=100$/.exec(rest)) && method === 'GET') {
        const r = f.releases.find((x) => x.id === Number(m![1]));
        return r ? page(r.assets.map((a) => ({ id: a.id, name: a.name, size: a.data.length }))) : fail(404, 'Not Found');
      }
      if ((m = /^releases\/assets\/(\d+)$/.exec(rest)) && method === 'GET') {
        // Only the asset's bytes, and only to a file: what `gh api -H 'Accept: application/octet-stream'` gives.
        const asset = f.releases.flatMap((r) => r.assets).find((a) => a.id === Number(m![1]));
        if (!asset) return fail(404, 'Not Found');
        if (!args.includes('Accept: application/octet-stream') || !out) return fail(415, 'fake gh: asset bytes need Accept: application/octet-stream and an output file');
        // As spawnGh: past the limit, gh is killed and the call rejects (`return`, so the catch below doesn't map it).
        if (asset.data.length > out.maxBytes) return Promise.reject(new GhError('other', `download passed the ${out.maxBytes} bytes declared; aborted`));
        writeFileSync(out.path, asset.data, { flag: 'wx' });
        return ok(undefined);
      }
      if ((m = /^releases\/assets\/(\d+)$/.exec(rest)) && method === 'DELETE') {
        for (const r of f.releases) r.assets = r.assets.filter((a) => a.id !== Number(m![1]));
        return ok(undefined);
      }
    } catch (e) {
      const status = (e as { status?: number }).status ?? 500;
      return fail(status, (e as Error).message.replace(/ \(HTTP \d+\)$/, ''));
    }
    return fail(404, `fake gh: no route for ${method} ${path}`);
  }

  f.run = (args, input, signal, out) => {
    const joined = args.join(' ');
    f.calls.push(joined);
    if (f.failOnce?.(joined)) {
      f.failOnce = undefined;
      return Promise.resolve(fail(502, 'Server Error'));
    }
    if (f.hang?.(joined)) {
      return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    }
    return answer(args, input, out);
  };
  return f;
}
