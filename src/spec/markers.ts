// Hidden HTML-comment markers servers put in issue comments (spec/v0.md §"Claiming"), and the `air-result`
// block that ends every final comment (spec/v0.md §"Results").

import {
  checkAsset, checkResume, DELIVERIES, HARNESSES, isSafePath, isSafeUrl, mapOf, MODEL_TIERS, nonStringErrors, parseYamlSubset,
  scalarMap, URL_MESSAGE, yamlScalar, type Asset, type Deliver, type Diagnostic, type Harness, type ModelTier, type Report, type Resume,
} from './frontmatter.ts';

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

const MARKER_RE = /^<!-- air-(claim|release|unsupported) v(\d+)((?: [a-z]+=[^\s=]+)+) -->$/;

/**
 * Finds every well-formed marker in a comment body, in order. A marker counts only when it is alone on
 * its line (surrounding spaces allowed) outside fenced code blocks, so quoting one in code or prose
 * does nothing. Malformed markers are ignored.
 */
export function parseMarkers(text: string): Marker[] {
  const out: Marker[] = [];
  let fence: { char: string; len: number } | undefined;
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (f && f[1]![0] === fence.char && f[1]!.length >= fence.len && line.trim() === f[1]) fence = undefined;
      continue;
    }
    if (f) {
      fence = { char: f[1]![0]!, len: f[1]!.length };
      continue;
    }
    const m = MARKER_RE.exec(line.trim());
    if (!m) continue;
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
  return walkClaims(comments);
}

/**
 * Goes through the comments in id order, applying counted markers, and returns the final holder. `visit`
 * sees each counted comment with the claim that held the issue just before it.
 */
function walkClaims<C extends MarkedComment>(comments: C[], visit?: (c: C, holder: Marker & { commentId: number }) => void): (Marker & { commentId: number }) | undefined {
  let holder: (Marker & { commentId: number }) | undefined;
  for (const c of [...comments].sort((a, b) => a.id - b.id)) {
    const markers = countedMarkers(c);
    if (holder && visit && c.trusted && c.createdAt === c.updatedAt) visit(c, holder);
    for (const m of markers) {
      if (m.kind === 'claim' && !holder) holder = { ...m, commentId: c.id };
      else if (m.kind === 'release' && holder && m.nonce === holder.nonce && m.host === holder.host) holder = undefined;
    }
  }
  return holder;
}

// ---------------------------------------------------------------------------------------------
// Results

export const RESULT_MARKER = '<!-- air-result v0 -->';
export const RESULT_STATUSES = ['done', 'partial', 'failed', 'released'] as const;
export type ResultStatus = (typeof RESULT_STATUSES)[number];

/** What a server reports at the end of every final comment (spec/v0.md §"Results"). */
export interface AirResult {
  status: ResultStatus;
  /** The request's `deliver`. */
  deliver: Deliver;
  /** One per repo that got a pull request, by the repo's `path`. */
  prs: { repo: string; url: string }[];
  artifact?: Asset;
  /** `comment`: the report is the text above the block. Otherwise the URL of the full report's asset. */
  report?: string;
  /** Only for `partial`: where the checkpoint is. */
  resume?: Resume;
  usage?: ResultUsage;
  host: string;
  nonce: string;
}

export interface ResultUsage {
  harness: Exclude<Harness, 'any'>;
  tier: ModelTier;
  /** Percent used of the subscription's weekly window before the first start and after the last stop. */
  before_pct?: number;
  after_pct?: number;
  /** How many times the agent was started for this claim. */
  attempts: number;
}

/**
 * The marker line and the fenced block for `r`; servers end their final comment with it. Throws unless the
 * block reads back as a valid result, so a server can only write results `parseResult` accepts.
 */
export function formatResult(r: AirResult): string {
  const text = blockOf(r);
  const back = parseResult(text);
  if (!back?.ok) throw new Error(`invalid result: ${back?.errors.map((e) => e.message).join('; ')}`);
  return text;
}

function blockOf(r: AirResult): string {
  if (!HOST_RE.test(r.host)) throw new Error(`invalid host for result: ${r.host}`);
  if (!NONCE_RE.test(r.nonce)) throw new Error(`invalid nonce for result: ${r.nonce}`);
  const q = yamlScalar;
  const asset = (a: Asset, indent: string) => [`${indent}url: ${q(a.url)}`, `${indent}sha256: ${a.sha256}`, `${indent}bytes: ${a.bytes}`, ...(a.expires ? [`${indent}expires: ${a.expires}`] : [])];
  const y = [`status: ${r.status}`, `deliver: ${r.deliver}`];
  if (r.prs.length) y.push('prs:', ...r.prs.flatMap((p) => [`  - repo: ${q(p.repo)}`, `    url: ${q(p.url)}`]));
  if (r.artifact) y.push('artifact:', ...asset(r.artifact, '  '));
  if (r.report !== undefined) y.push(`report: ${q(r.report)}`);
  if (r.resume) {
    y.push('resume:');
    if (r.resume.branches.length) {
      y.push('  branches:', ...r.resume.branches.flatMap((b) => [`    - repo: ${q(b.repo)}`, `      branch: ${q(b.branch)}`, `      sha: ${q(b.sha)}`]));
    }
    if (r.resume.out) y.push('  out:', ...asset(r.resume.out, '    '));
  }
  if (r.usage) {
    const u = r.usage;
    y.push('usage:', `  harness: ${u.harness}`, `  tier: ${u.tier}`);
    if (u.before_pct !== undefined) y.push(`  before_pct: ${u.before_pct}`);
    if (u.after_pct !== undefined) y.push(`  after_pct: ${u.after_pct}`);
    y.push(`  attempts: ${u.attempts}`);
  }
  y.push(`host: ${q(r.host)}`, `nonce: ${r.nonce}`);
  return [RESULT_MARKER, '```yaml', ...y, '```'].join('\n');
}

export type ParsedResult = { ok: true; result: AirResult } | { ok: false; errors: Diagnostic[] };

/** Number-valued keys of a result block. */
const RESULT_NUMBERS = ['artifact.bytes', 'resume.out.bytes', 'usage.before_pct', 'usage.after_pct', 'usage.attempts'];

/**
 * The `air-result` block that ends a comment body, if any. Only the last `<!-- air-result v0 -->` line
 * outside fenced code counts, alone on its line; the next line must open a ```` ```yaml ```` fence, and
 * that fence must close on the last non-blank line. Undefined when there is no such marker line; an
 * error when the block after it is malformed. Says nothing about who wrote it: see `countedResults`.
 */
export function parseResult(body: string): ParsedResult | undefined {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  let end = lines.length;
  while (end > 0 && lines[end - 1]!.trim() === '') end--;
  let marker = -1;
  let fence: { char: string; len: number } | undefined;
  for (let i = 0; i < end; i++) {
    const line = lines[i]!;
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (f && f[1]![0] === fence.char && f[1]!.length >= fence.len && line.trim() === f[1]) fence = undefined;
      continue;
    }
    if (f) fence = { char: f[1]![0]!, len: f[1]!.length };
    else if (line.trim() === RESULT_MARKER) marker = i;
  }
  if (marker < 0) return undefined;
  const fail = (line: number, message: string): ParsedResult => ({ ok: false, errors: [{ line: line + 1, code: 'frontmatter', message }] });
  if (!/^```yaml[ \t]*$/.test(lines[marker + 1] ?? '')) return fail(marker + 1, 'the `air-result` marker must be followed by a ```yaml fence on the next line');
  let close = marker + 2;
  while (close < end && !/^```[ \t]*$/.test(lines[close]!)) close++;
  if (close >= end) return fail(marker + 1, 'the `air-result` block is not closed');
  if (close !== end - 1) return fail(close + 1, 'the `air-result` block must end the comment');

  const { entries, errors } = parseYamlSubset(lines.slice(marker + 2, close), marker + 3);
  const err: Report = (line, code, message) => void errors.push({ line, code, message });
  const nonString = nonStringErrors(entries, RESULT_NUMBERS, err);
  const firstNonString = errors.length;
  const top = mapOf({ kind: 'map', entries, line: marker + 3 }, 'air-result', marker + 3, ['status', 'deliver', 'host', 'nonce'], ['prs', 'artifact', 'report', 'resume', 'usage'], err);
  const scalar = (k: string) => {
    const e = top?.get(k);
    if (e && e.value.kind !== 'scalar') err(e.keyLine, 'type', `\`${k}\` must be a single value`);
    return e?.value.kind === 'scalar' ? e.value : undefined;
  };
  const oneOf = <T extends string>(k: string, allowed: readonly T[]): T | undefined => {
    const s = scalar(k);
    if (s && !(allowed as readonly string[]).includes(s.value)) err(s.line, 'value', `\`${k}\` must be one of ${allowed.join(', ')}`);
    return s && (allowed as readonly string[]).includes(s.value) ? (s.value as T) : undefined;
  };
  const status = oneOf('status', RESULT_STATUSES);
  const deliver = oneOf('deliver', DELIVERIES);
  const host = scalar('host');
  if (host && !HOST_RE.test(host.value)) err(host.line, 'value', '`host` is not a valid host name');
  const nonce = scalar('nonce');
  if (nonce && !NONCE_RE.test(nonce.value)) err(nonce.line, 'value', '`nonce` is not a valid nonce');

  const prs: AirResult['prs'] = [];
  const prsE = top?.get('prs');
  if (prsE?.value.kind !== 'list' && prsE) err(prsE.keyLine, 'type', '`prs` must be a list of `- repo: <path>` entries with `url`');
  else if (prsE?.value.kind === 'list') {
    prsE.value.items.forEach((item, i) => {
      const m = scalarMap(item, `prs[${i}]`, item.line, ['repo', 'url'], [], err);
      const [repo, url] = [m?.get('repo'), m?.get('url')];
      if (repo && !isSafePath(repo.value)) err(repo.line, 'value', `\`prs[${i}].repo\` must be a repo's \`path\``);
      if (url && !isSafeUrl(url.value)) err(url.line, 'value', URL_MESSAGE(`prs[${i}].url`));
      if (repo && prs.some((p) => p.repo === repo.value)) err(repo.line, 'value', `\`prs\` lists \`${repo.value}\` twice`);
      else if (repo && url) prs.push({ repo: repo.value, url: url.value });
    });
  }
  const artifactE = top?.get('artifact');
  const artifact = artifactE && checkAsset(artifactE.value, 'artifact', artifactE.keyLine, err, { expires: true });
  // §10: a `done` result carries what was delivered, and only that.
  if (status && deliver) {
    const wantPrs = status === 'done' && deliver === 'pr';
    const wantArtifact = status === 'done' && deliver === 'artifact';
    if (prsE && !wantPrs) err(prsE.keyLine, 'value', '`prs` is only for `status: done` with `deliver: pr`');
    else if (wantPrs && !prsE) err(marker + 3, 'missing', '`status: done` with `deliver: pr` needs `prs`');
    else if (wantPrs && prsE?.value.kind === 'list' && prsE.value.items.length === 0) err(prsE.keyLine, 'value', '`prs` must list at least one pull request');
    if (artifactE && !wantArtifact) err(artifactE.keyLine, 'value', '`artifact` is only for `status: done` with `deliver: artifact`');
    else if (wantArtifact && !artifactE) err(marker + 3, 'missing', '`status: done` with `deliver: artifact` needs `artifact`');
  }
  const report = scalar('report');
  if (report && report.value !== 'comment' && !isSafeUrl(report.value)) err(report.line, 'value', '`report` must be `comment` or the URL of the report asset');
  const resumeE = top?.get('resume');
  const resume = resumeE && checkResume(resumeE.value, 'resume', resumeE.keyLine, err);
  if (resumeE && status !== undefined && status !== 'partial') err(resumeE.keyLine, 'value', '`resume` is only for `status: partial`');

  let usage: ResultUsage | undefined;
  const usageE = top?.get('usage');
  const u = usageE && scalarMap(usageE.value, 'usage', usageE.keyLine, ['harness', 'tier', 'attempts'], ['before_pct', 'after_pct'], err);
  if (u) {
    const n = errors.length;
    const harness = u.get('harness');
    const tier = u.get('tier');
    const attempts = u.get('attempts');
    if (harness && (harness.value === 'any' || !(HARNESSES as readonly string[]).includes(harness.value))) err(harness.line, 'value', '`usage.harness` must be claude or codex');
    if (tier && !(MODEL_TIERS as readonly string[]).includes(tier.value)) err(tier.line, 'value', `\`usage.tier\` must be one of ${MODEL_TIERS.join(', ')}`);
    if (attempts && (attempts.quoted || !/^[1-9]\d{0,5}$/.test(attempts.value))) err(attempts.line, 'value', '`usage.attempts` must be a positive unquoted integer');
    const pct: Record<string, number> = {};
    for (const k of ['before_pct', 'after_pct']) {
      const s = u.get(k);
      if (!s) continue;
      if (s.quoted || !/^\d{1,3}(?:\.\d+)?$/.test(s.value) || Number(s.value) > 100) err(s.line, 'value', `\`usage.${k}\` must be an unquoted number from 0 to 100`);
      else pct[k] = Number(s.value);
    }
    if (errors.length === n && harness && tier && attempts) {
      usage = { harness: harness.value as ResultUsage['harness'], tier: tier.value as ModelTier, ...pct, attempts: Number(attempts.value) };
    }
  }

  // As in front matter: an unquoted bool, null or number is reported once, not again as a bad value.
  if (nonString.size) errors.push(...errors.splice(firstNonString).filter((d) => !nonString.has(d.line)));
  if (errors.length || !top || !status || !deliver || !host || !nonce) return { ok: false, errors };
  const result: AirResult = { status, deliver, prs, host: host.value, nonce: nonce.value };
  if (artifact) result.artifact = artifact;
  if (report) result.report = report.value;
  if (resume) result.resume = resume;
  if (usage) result.usage = usage;
  return { ok: true, result };
}

export interface AuthoredComment extends MarkedComment {
  /** GitHub login of the comment's author. */
  author: string;
}

export interface CountedResult {
  commentId: number;
  /** The claim the result reports on. */
  claimCommentId: number;
  result: AirResult;
}

/**
 * Results that count, oldest first. A result counts only if its comment counts for markers (trusted
 * author, never edited), the claim named by its `host` and `nonce` held the issue when it was posted,
 * the same account posted that claim, and that claim has no counted result yet. So a result quoted or
 * pasted by someone else, edited, left by a server that had lost its claim, or posted after a claim's
 * final result (a `done` claim is never released) does nothing.
 */
export function countedResults(comments: AuthoredComment[]): CountedResult[] {
  const out: CountedResult[] = [];
  const authors = new Map(comments.map((c) => [c.id, c.author]));
  const finished = new Set<number>();
  walkClaims(comments, (c, holder) => {
    if (finished.has(holder.commentId)) return;
    const r = parseResult(c.body);
    if (!r?.ok || r.result.host !== holder.host || r.result.nonce !== holder.nonce || c.author !== authors.get(holder.commentId)) return;
    finished.add(holder.commentId);
    out.push({ commentId: c.id, claimCommentId: holder.commentId, result: r.result });
  });
  return out;
}
