// Hidden HTML-comment markers servers put in issue comments (spec/v0.md §"Claiming").

export const MARKER_KINDS = ['claim', 'release', 'unsupported'] as const;
export type MarkerKind = (typeof MARKER_KINDS)[number];

export interface Marker {
  kind: MarkerKind;
  /** Spec version of the server that wrote it. */
  version: number;
  host: string;
  /** claim, release: the claim's nonce. */
  nonce?: string;
  /** unsupported: the request's `air` version. */
  air?: number;
}

const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const NONCE_RE = /^[A-Za-z0-9]{8,64}$/;

export function formatMarker(m: Marker): string {
  if (!HOST_RE.test(m.host)) throw new Error(`invalid host for marker: ${m.host}`);
  let out = `<!-- air-${m.kind} v${m.version} host=${m.host}`;
  if (m.kind === 'unsupported') {
    if (m.air === undefined) throw new Error('unsupported marker needs `air`');
    out += ` air=${m.air}`;
  } else {
    if (!m.nonce || !NONCE_RE.test(m.nonce)) throw new Error(`invalid nonce for marker: ${m.nonce}`);
    out += ` nonce=${m.nonce}`;
  }
  return `${out} -->`;
}

const MARKER_RE = /<!-- air-(claim|release|unsupported) v(\d+)((?: [a-z]+=[^\s=]+)+) -->/g;

/** Finds every well-formed marker in a comment body, in order. Malformed markers are ignored. */
export function parseMarkers(text: string): Marker[] {
  const out: Marker[] = [];
  for (const m of text.matchAll(MARKER_RE)) {
    const kind = m[1] as MarkerKind;
    const attrs = new Map<string, string>();
    for (const kv of m[3]!.trim().split(' ')) {
      const [k, v] = kv.split('=') as [string, string];
      attrs.set(k, v);
    }
    const host = attrs.get('host');
    if (!host || !HOST_RE.test(host)) continue;
    const marker: Marker = { kind, version: Number(m[2]), host };
    if (kind === 'unsupported') {
      const air = attrs.get('air');
      if (!air || !/^\d+$/.test(air)) continue;
      marker.air = Number(air);
    } else {
      const nonce = attrs.get('nonce');
      if (!nonce || !NONCE_RE.test(nonce)) continue;
      marker.nonce = nonce;
    }
    out.push(marker);
  }
  return out;
}

export interface MarkedComment {
  /** GitHub comment id; ids increase with creation time. */
  id: number;
  body: string;
  /** GitHub `created_at` / `updated_at`. A comment whose two differ was edited, and its markers don't count. */
  createdAt: string;
  updatedAt: string;
  /** The comment's author has write access to the requests repo (see `associationTrust`). */
  trusted: boolean;
}

/**
 * What GitHub's `author_association` says about write access. `OWNER` is conclusive. `MEMBER` (org
 * member) and `COLLABORATOR` (may be read-only) are ambiguous: check
 * `gh api repos/{owner}/{repo}/collaborators/{login}/permission` for write, maintain or admin.
 * Anything else is untrusted.
 */
export function associationTrust(association: string): 'trusted' | 'check' | 'untrusted' {
  if (association === 'OWNER') return 'trusted';
  if (association === 'MEMBER' || association === 'COLLABORATOR') return 'check';
  return 'untrusted';
}

/** Markers a server may act on: from trusted authors, in comments that were never edited. */
export function countedMarkers(c: MarkedComment): Marker[] {
  if (!c.trusted || c.createdAt !== c.updatedAt) return [];
  return parseMarkers(c.body);
}

/**
 * The claim that currently holds the issue: the earliest counted claim after the latest release,
 * where a release only counts if it names the host and nonce of the claim it ends. Undefined if free.
 */
export function currentClaim(comments: MarkedComment[]): (Marker & { commentId: number }) | undefined {
  const sorted = [...comments].sort((a, b) => a.id - b.id);
  let holder: (Marker & { commentId: number }) | undefined;
  for (const c of sorted) {
    for (const m of countedMarkers(c)) {
      if (m.kind === 'claim' && !holder) holder = { ...m, commentId: c.id };
      else if (m.kind === 'release' && holder && m.nonce === holder.nonce && m.host === holder.host) holder = undefined;
    }
  }
  return holder;
}
