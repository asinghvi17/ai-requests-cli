// Requests with claims and results on a fake GitHub, for the requester command tests.
import { fakeGitHub, type FakeGitHub } from '../../gh/testing/fake.ts';
import { formatMarker, formatResult, type AirResult } from '../markers.ts';

export const NONCE = 'aaaaaaaa';
export const SHA = '0e3c5f4b9a1d2c7e8f6a5b4c3d2e1f0a9b8c7d6e';

/** A request body; `fm` lines are added to the front matter. */
export function requestBody(fm: string[] = [], effort = 'S'): string {
  return `---\nair: 0\neffort: ${effort}\ndeliver: pr\nrepos:\n  - url: https://github.com/acme/service.git\n    ref: main\n${fm.join('\n')}${fm.length ? '\n' : ''}---\n\n## Task\n\nDo it.\n\n## Done when\n\n- Done.\n\n## Context\n\nSee repo/service.\n`;
}

export const PR = 'https://github.com/acme/service/pull/7';

/** A valid result: by default `done` with a pull request; `prs` defaults to none for any other status or `deliver`. */
export function result(r: Partial<AirResult> = {}): AirResult {
  const out: AirResult = { status: 'done', deliver: 'pr', prs: [], report: 'comment', host: 'box', nonce: NONCE, ...r };
  if (r.prs === undefined && out.status === 'done' && out.deliver === 'pr') out.prs = [{ repo: 'service', url: PR }];
  return out;
}

/**
 * Issue 1 by alice on a fake repo whose viewer is alice. The server account `srv` (OWNER) claims it with
 * host `box`; `claimed` posts the claim, and each of `results` is posted as a final comment after it.
 */
export function requestIssue(opts: { labels?: string[]; body?: string; claimed?: boolean; results?: { report?: string; result: AirResult; release?: boolean }[] } = {}): FakeGitHub {
  const gh = fakeGitHub({ viewer: 'alice' });
  gh.addIssue({ number: 1, body: opts.body ?? requestBody(), labels: ['ai-request', ...(opts.labels ?? [])] });
  if (opts.claimed ?? true) claim(gh, 'box', NONCE);
  for (const r of opts.results ?? []) {
    const release = r.release ? `${formatMarker({ kind: 'release', version: 0, host: r.result.host, nonce: r.result.nonce })}\n` : '';
    gh.post(1, 'srv', 'OWNER', `${r.report ?? 'The report.'}\n\n${release}${formatResult(r.result)}\n`);
  }
  return gh;
}

export function claim(gh: FakeGitHub, host: string, nonce: string): void {
  gh.post(1, 'srv', 'OWNER', `Claimed by ${host}.\n\n${formatMarker({ kind: 'claim', version: 0, host, nonce })}\n`);
}
