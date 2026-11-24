// The trust rule (spec/v0.md §1): servers act only on issues, comments and labels written by accounts with
// write, maintain or admin on the requests repo. `OWNER` is trusted outright; `MEMBER` and `COLLABORATOR`
// are confirmed with the permission API; anything else is untrusted.
import type { IssueComment, RequestsRepo } from '../gh/index.ts';
import { associationTrust, type AuthoredComment } from './markers.ts';

export const WRITE_ROLES = ['admin', 'maintain', 'write'] as const;

export type Trust = (login: string, association: string) => Promise<boolean>;

/**
 * A trust checker that asks the permission API at most once per login per `ttlMs`, so a long-running
 * server notices revoked access. A missing collaborator (404) is
 * untrusted; other API errors propagate, so a transient failure never makes a rival's claim look forged.
 */
export function createTrust(gh: RequestsRepo, ttlMs = 5 * 60_000, now = () => Date.now()): Trust {
  const cache = new Map<string, { at: number; p: Promise<boolean> }>();
  return async (login, association) => {
    const verdict = associationTrust(association);
    if (verdict !== 'check') return verdict === 'trusted';
    if (!login) return false;
    let hit = cache.get(login);
    if (!hit || now() - hit.at > ttlMs) {
      const p = gh.permission(gh.repo, login).then((role) => (WRITE_ROLES as readonly string[]).includes(role));
      hit = { at: now(), p };
      cache.set(login, hit);
      p.catch(() => cache.delete(login));
    }
    return hit.p;
  };
}

/** Comments in the shape `currentClaim` and `countedResults` read, with each author's trust resolved. */
export async function markedComments(comments: IssueComment[], trust: Trust): Promise<AuthoredComment[]> {
  return Promise.all(comments.map(async (c) => ({
    id: c.id, body: c.body, author: c.author, createdAt: c.createdAt, updatedAt: c.updatedAt, trusted: await trust(c.author, c.authorAssociation),
  })));
}
