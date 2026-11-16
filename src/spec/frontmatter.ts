// Front-matter parser for air request issues (spec/v0.md).
//
// Parses the YAML subset described in spec/v0.md §"YAML subset" without a YAML library, then
// validates the fields into a typed Request. Every diagnostic carries a 1-based line number of the
// issue body (after CRLF normalisation).

export const SPEC_VERSION = 0;

export const EFFORTS = ['XS', 'S', 'M', 'L', 'XL'] as const;
export type Effort = (typeof EFFORTS)[number];
/** Share of one weekly usage window, in percent. */
export const EFFORT_PERCENT: Record<Effort, number> = { XS: 1, S: 3, M: 8, L: 20, XL: 40 };

export const HARNESSES = ['claude', 'codex', 'any'] as const;
export type Harness = (typeof HARNESSES)[number];

export const MODEL_TIERS = ['small', 'medium', 'large'] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

export const DELIVERIES = ['comment', 'pr', 'artifact'] as const;
export type Deliver = (typeof DELIVERIES)[number];

export const DEFAULT_TIMEOUT_MINUTES = 4 * 60;
export const MAX_TIMEOUT_MINUTES = 24 * 60;
/** GitHub's release-asset size limit; context zips can't be larger than this. */
export const MAX_CONTEXT_BYTES = 2 * 1024 ** 3;

/** A zip on a release of the requests repo: `context`, `resume.out`, a result's `artifact`. */
export interface Asset {
  url: string;
  sha256: string;
  bytes: number;
  /** YYYY-MM-DD after which `air sweep` may delete the zip. Absent: 14 days after the issue closes. */
  expires?: string;
}

/** One entry of `repos`. Exactly one of `ref` and `pr` is set. */
export interface RepoEntry {
  url: string;
  /** A branch, tag or commit. */
  ref?: string;
  /** A pull request number: check out `refs/pull/<pr>/head`. */
  pr?: number;
  /** Folder under `repo/`, relative, `/`-separated. Defaults to the repo's name. */
  path: string;
  /** `none`: read-only, never pushed. Absent: delivered as the request's `deliver` says. */
  deliver?: 'none';
}

/** `resume`: where an earlier claim's checkpoint left off (written by `air retry` from a `partial` result). */
export interface Resume {
  /** Per repo (by `path`), the pushed checkpoint branch and the commit to continue from. */
  branches: { repo: string; branch: string; sha: string }[];
  /** The checkpoint's `out/`, zipped. */
  out?: Asset;
}


export interface Request {
  air: number;
  effort: Effort;
  harness: Harness[];
  model: ModelTier;
  context?: Asset;
  /** In order. Empty: no `repo/` directory. */
  repos: RepoEntry[];
  resume?: Resume;
  setup: string[];
  check?: string;
  deliver: Deliver;
  /** As written: YYYY-MM-DD or an RFC 3339 date-time with offset. */
  deadline?: string;
  timeoutMinutes: number;
}

export type DiagnosticCode =
  | 'frontmatter' // missing or unterminated front-matter block
  | 'yaml' // outside the YAML subset
  | 'version' // `air` newer than this parser supports
  | 'missing' // required field or section absent
  | 'unknown-key'
  | 'type' // wrong shape (scalar vs list vs map, string vs integer)
  | 'value' // right shape, invalid value
  | 'section';

export interface Diagnostic {
  line: number;
  code: DiagnosticCode;
  message: string;
}

export type FrontMatterResult =
  | {
    ok: true;
    request: Request;
    /** Problems that don't stop a server from acting on the request. */
    warnings: Diagnostic[];
    /** 0-based index into `lines` of the first line after the closing `---`. */
    bodyStart: number;
    lines: string[];
  }
  | { ok: false; errors: Diagnostic[]; bodyStart?: number; lines: string[] };

// ---------------------------------------------------------------------------------------------
// YAML subset

export interface Scalar {
  kind: 'scalar';
  value: string;
  quoted: boolean;
  line: number;
}
export interface List {
  kind: 'list';
  /** Scalars, or maps for `- key: value` items. */
  items: (Scalar | MapNode)[];
  line: number;
}
export interface MapNode {
  kind: 'map';
  entries: Map<string, Entry>;
  line: number;
}
export type Value = Scalar | List | MapNode;
export interface Entry {
  key: string;
  keyLine: number;
  value: Value;
}

const KEY_RE = /^([A-Za-z_][A-Za-z0-9_-]*):(?=\s|$)(.*)$/;

/** Splits an issue body into normalised lines: BOM stripped, CRLF/CR turned into LF. */
export function splitLines(body: string): string[] {
  return body.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
}

/**
 * Parses the YAML subset. `lines` are the lines between the `---` delimiters; `firstLine` is the
 * 1-based body line number of lines[0].
 */
export function parseYamlSubset(lines: string[], firstLine: number): { entries: Map<string, Entry>; errors: Diagnostic[] } {
  const errors: Diagnostic[] = [];
  const err = (line: number, message: string) => errors.push({ line, code: 'yaml', message });

  // Significant lines only: blank and comment-only lines are dropped up front.
  const toks: { line: number; indent: number; text: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    if (/^\s*(#.*)?$/.test(raw)) continue;
    const lead = /^[ \t]*/.exec(raw)![0];
    if (lead.includes('\t')) err(firstLine + i, 'indent with spaces, not tabs');
    else toks.push({ line: firstLine + i, indent: lead.length, text: raw.slice(lead.length) });
  }
  const isItem = (text: string) => text === '-' || text.startsWith('- ');
  let at = 0;

  // `key: value` lines at exactly `indent`, until a line indented less.
  const parseMap = (indent: number, into: Map<string, Entry>): void => {
    while (at < toks.length) {
      const t = toks[at]!;
      if (t.indent < indent) return;
      at++;
      if (t.indent > indent) {
        err(t.line, isItem(t.text) ? 'list item is not aligned with its key or the previous item' : 'unexpected indentation');
        continue;
      }
      if (isItem(t.text)) {
        err(t.line, 'list item without a key');
        continue;
      }
      const m = KEY_RE.exec(t.text);
      if (!m) {
        err(t.line, t.text.startsWith('---') ? 'unexpected `---` inside front matter' : 'expected `key: value`');
        continue;
      }
      const key = m[1]!;
      const value = parseValue(key, m[2]!.trim(), t.line, indent);
      if (into.has(key)) err(t.line, `duplicate key \`${key}\``);
      else if (value) into.set(key, { key, keyLine: t.line, value });
    }
  };

  // `- item` lines at exactly `indent`. An item may open a map (`- key: value`, more keys aligned with it).
  const parseList = (indent: number, list: List): void => {
    while (at < toks.length) {
      const t = toks[at]!;
      if (t.indent < indent || (t.indent === indent && !isItem(t.text))) return;
      if (t.indent > indent) {
        at++;
        err(t.line, isItem(t.text) ? 'list item is not aligned with the previous item' : 'unexpected indentation');
        continue;
      }
      const item = t.text.slice(1).trimStart();
      if (item === '' || item.startsWith('#')) {
        at++;
        err(t.line, 'empty list item; write `- value`, or `- key: value` for a map');
        continue;
      }
      if (item.startsWith('[') || item.startsWith('{') || isItem(item)) {
        at++;
        err(t.line, 'nested collections are not allowed in list items; quote the value if it is a string');
        continue;
      }
      if (KEY_RE.test(item)) {
        // Re-read this line as the first key of a map indented to where the key starts.
        toks[at] = { line: t.line, indent: t.indent + t.text.length - item.length, text: item };
        const entries = new Map<string, Entry>();
        parseMap(toks[at]!.indent, entries);
        list.items.push({ kind: 'map', entries, line: t.line });
        continue;
      }
      at++;
      const s = parseScalar(item, t.line, false, errors);
      if (s) list.items.push(s);
    }
  };

  // The value of a key at `indent`: inline on its line, or the indented block that follows.
  const parseValue = (key: string, rest: string, line: number, indent: number): Value | undefined => {
    if (stripComment(rest) === '') {
      const next = toks[at];
      if (next && isItem(next.text) && next.indent >= indent) {
        const list: List = { kind: 'list', items: [], line };
        parseList(next.indent, list);
        return list;
      }
      if (next && next.indent > indent) {
        const map: MapNode = { kind: 'map', entries: new Map(), line };
        parseMap(next.indent, map.entries);
        return map;
      }
      err(line, `\`${key}\` has no value`);
      return { kind: 'list', items: [], line };
    }
    if (rest.startsWith('[')) return parseFlowList(rest, line, errors);
    if (rest.startsWith('{')) {
      err(line, 'flow maps `{...}` are not supported; write the map as indented `key: value` lines');
      return undefined;
    }
    if (/^[|>][-+0-9]*$/.test(stripComment(rest))) {
      err(line, 'multi-line strings are not supported');
      return undefined;
    }
    return parseScalar(rest, line, false, errors);
  };

  const entries = new Map<string, Entry>();
  parseMap(0, entries);
  return { entries, errors };
}

/** Removes a trailing ` # comment` from an unquoted value (only used to detect empty values). */
function stripComment(text: string): string {
  if (text.startsWith('#')) return '';
  if (text.startsWith('"') || text.startsWith("'")) return text;
  const at = text.search(/\s#/);
  return (at < 0 ? text : text.slice(0, at)).trim();
}

/** YAML 1.2: a comment after a value must be separated from it by whitespace. */
function isCommentOrEmpty(tail: string): boolean {
  return tail.trim() === '' || /^\s+#/.test(tail);
}

const PLAIN_BAD_START = /^[[\]{},&*!|>%@`"'#]|^[-?:](\s|$)/;

/**
 * Parses one scalar starting at `text[0]`. In block context the scalar runs to end of line (minus a
 * comment); in flow context it ends at `,` or `]`. Returns undefined after pushing an error.
 */
function parseScalar(text: string, line: number, flow: boolean, errors: Diagnostic[]): Scalar | undefined {
  const r = readScalar(text, line, flow, errors);
  if (!r) return undefined;
  const tail = text.slice(r.end);
  if (!isCommentOrEmpty(tail)) {
    errors.push({ line, code: 'yaml', message: `unexpected text after value: \`${tail.trim()}\` (comments need a space before \`#\`)` });
    return undefined;
  }
  return r.scalar;
}

function readScalar(text: string, line: number, flow: boolean, errors: Diagnostic[]): { scalar: Scalar; end: number } | undefined {
  const err = (message: string) => {
    errors.push({ line, code: 'yaml', message });
    return undefined;
  };
  const q = text[0];
  if (q === '"') {
    let out = '';
    for (let i = 1; i < text.length; i++) {
      const c = text[i]!;
      if (c === '"') return { scalar: { kind: 'scalar', value: out, quoted: true, line }, end: i + 1 };
      if (c !== '\\') {
        out += c;
        continue;
      }
      const e = text[++i];
      const simple: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', n: '\n', t: '\t', r: '\r', '0': '\0' };
      if (e !== undefined && e in simple) out += simple[e];
      else if (e === 'u' && /^[0-9A-Fa-f]{4}$/.test(text.slice(i + 1, i + 5))) {
        out += String.fromCharCode(parseInt(text.slice(i + 1, i + 5), 16));
        i += 4;
      } else return err(`unsupported escape \`\\${e ?? ''}\` in double-quoted string`);
    }
    return err('unterminated double-quoted string');
  }
  if (q === "'") {
    let out = '';
    for (let i = 1; i < text.length; i++) {
      const c = text[i]!;
      if (c !== "'") {
        out += c;
        continue;
      }
      if (text[i + 1] === "'") {
        out += "'";
        i++;
        continue;
      }
      return { scalar: { kind: 'scalar', value: out, quoted: true, line }, end: i + 1 };
    }
    return err('unterminated single-quoted string');
  }

  // Plain scalar.
  let end = text.length;
  if (flow) {
    const at = text.search(/[,\]]/);
    if (at >= 0) end = at;
  }
  const comment = text.slice(0, end).search(/\s#/);
  if (comment >= 0) end = comment;
  const value = text.slice(0, end).trim();
  if (value === '') return err('empty value');
  if (PLAIN_BAD_START.test(value) || /:(\s|$)/.test(value) || (flow && /[[\]{}]/.test(value))) {
    return err(`quote this value: \`${value}\` contains characters YAML treats specially`);
  }
  return { scalar: { kind: 'scalar', value, quoted: false, line }, end };
}

/** `v` as a YAML scalar in the subset (§3): plain when that reads back as the same string, else double-quoted. */
export function yamlScalar(v: string): string {
  const plain = v !== '' && v.trim() === v && /^[\x21-\x7e ]*$/.test(v) && !PLAIN_BAD_START.test(v) && !/:(\s|$)/.test(v) && !/\s#/.test(v) && !yamlNonStringKind(v);
  if (plain) return v;
  return `"${v.replace(/[\\"]/g, (c) => `\\${c}`).replace(/[\x00-\x1f\x7f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}"`;
}

function parseFlowList(text: string, line: number, errors: Diagnostic[]): List | undefined {
  const items: Scalar[] = [];
  let i = 1;
  const skip = () => {
    while (text[i] === ' ') i++;
  };
  skip();
  if (text[i] === ']') {
    i++;
  } else {
    for (;;) {
      skip();
      const r = readScalar(text.slice(i), line, true, errors);
      if (!r) return undefined;
      items.push(r.scalar);
      i += r.end;
      skip();
      if (text[i] === ',') {
        i++;
        skip();
        // YAML 1.2 allows one trailing comma: [a, b,]
        if (text[i] === ']') {
          i++;
          break;
        }
        continue;
      }
      if (text[i] === ']') {
        i++;
        break;
      }
      errors.push({ line, code: 'yaml', message: i >= text.length ? 'unterminated flow list: missing `]`' : 'expected `,` or `]` in flow list' });
      return undefined;
    }
  }
  const tail = text.slice(i);
  if (!isCommentOrEmpty(tail)) {
    errors.push({ line, code: 'yaml', message: `unexpected text after \`]\`: \`${tail.trim()}\` (comments need a space before \`#\`)` });
    return undefined;
  }
  return { kind: 'list', items, line };
}

// ---------------------------------------------------------------------------------------------
// Front-matter block and field validation

const FIELDS = ['air', 'effort', 'harness', 'model', 'context', 'repos', 'resume', 'setup', 'check', 'deliver', 'deadline', 'timeout'] as const;

/** Finds the front-matter block, parses it and validates the fields. */
export function parseFrontMatter(body: string): FrontMatterResult {
  const lines = splitLines(body);
  let open = 0;
  while (open < lines.length && lines[open]!.trim() === '') open++;
  if (open >= lines.length || lines[open]!.trimEnd() !== '---') {
    return {
      ok: false,
      lines,
      errors: [{ line: Math.min(open, lines.length - 1) + 1, code: 'frontmatter', message: 'the issue body must start with a `---` front-matter block' }],
    };
  }
  let close = open + 1;
  while (close < lines.length && lines[close]!.trimEnd() !== '---') close++;
  if (close >= lines.length) {
    return { ok: false, lines, errors: [{ line: open + 1, code: 'frontmatter', message: 'front matter is not closed by a `---` line' }] };
  }
  const yaml = lines.slice(open + 1, close);
  const bodyStart = close + 1;

  // Version gate first: a newer spec may use syntax or fields this parser doesn't know.
  for (let i = 0; i < yaml.length; i++) {
    const v = /^air:\s*["']?(\d+)["']?(\s+#.*)?$/.exec(yaml[i]!.trimEnd());
    if (v && Number(v[1]) > SPEC_VERSION) {
      return { ok: false, lines, bodyStart, errors: [versionError(open + 2 + i, Number(v[1]))] };
    }
  }

  const { entries, errors } = parseYamlSubset(yaml, open + 2);
  const closeLine = close + 1;
  const warnings: Diagnostic[] = [];
  const req = validateFields(entries, closeLine, errors, warnings);
  if (errors.length > 0 || !req) return { ok: false, lines, bodyStart, errors: sortDiagnostics(errors) };
  return { ok: true, request: req, warnings: sortDiagnostics(warnings), bodyStart, lines };
}

function versionError(line: number, v: number): Diagnostic {
  return {
    line,
    code: 'version',
    message: `request uses air spec version ${v}, but this air only understands version ${SPEC_VERSION}; upgrade air to serve it`,
  };
}

export function sortDiagnostics(ds: Diagnostic[]): Diagnostic[] {
  return [...ds].sort((a, b) => a.line - b.line);
}

/** Collects a diagnostic. */
export type Report = (line: number, code: DiagnosticCode, message: string) => void;

function validateFields(entries: Map<string, Entry>, closeLine: number, errors: Diagnostic[], warnings: Diagnostic[]): Request | undefined {
  const err: Report = (line, code, message) => {
    errors.push({ line, code, message });
  };

  for (const e of entries.values()) {
    if (!(FIELDS as readonly string[]).includes(e.key)) {
      const near = closest(e.key, FIELDS);
      err(e.keyLine, 'unknown-key', `unknown key \`${e.key}\`${near ? ` (did you mean \`${near}\`?)` : ''}`);
    }
  }

  // Unquoted values a YAML 1.2 parser would read as bool, null or a number must be quoted in string
  // fields. Other errors on those lines would only repeat the problem, so they're dropped below.
  const nonStringLines = nonStringErrors(entries, INTEGER_FIELDS, err);
  const firstNonString = errors.length;

  const get = (k: string) => entries.get(k);
  const required = (k: string): Entry | undefined => {
    const e = get(k);
    if (!e) err(closeLine, 'missing', `missing required field \`${k}\``);
    return e;
  };
  const scalar = (e: Entry): Scalar | undefined => {
    if (e.value.kind === 'scalar') return e.value;
    err(e.keyLine, 'type', `\`${e.key}\` must be a single value, not a ${e.value.kind}`);
    return undefined;
  };
  const enumOf = <T extends string>(e: Entry, s: Scalar, allowed: readonly T[]): T | undefined => {
    if ((allowed as readonly string[]).includes(s.value)) return s.value as T;
    err(s.line, 'value', `\`${e.key}\` must be one of ${allowed.join(', ')}; got \`${s.value}\``);
    return undefined;
  };

  // air
  let air: number | undefined;
  const airE = required('air');
  if (airE) {
    const s = scalar(airE);
    if (s) {
      if (s.quoted || !/^\d+$/.test(s.value)) err(s.line, 'type', '`air` must be an unquoted integer (the spec version, 0)');
      else if (Number(s.value) !== SPEC_VERSION) errors.push(versionError(s.line, Number(s.value)));
      else air = SPEC_VERSION;
    }
  }

  // effort
  let effort: Effort | undefined;
  const effortE = required('effort');
  if (effortE) {
    const s = scalar(effortE);
    if (s) effort = enumOf(effortE, s, EFFORTS);
  }

  // harness
  let harness: Harness[] = ['any'];
  const harnessE = get('harness');
  if (harnessE) {
    const v = harnessE.value;
    if (v.kind === 'map' || (v.kind === 'list' && v.items.some((s) => s.kind === 'map'))) err(harnessE.keyLine, 'type', '`harness` must be a list, e.g. [claude, codex]');
    else {
      const items = v.kind === 'scalar' ? [v] : (v.items as Scalar[]);
      const got: Harness[] = [];
      for (const s of items) {
        const h = enumOf(harnessE, s, HARNESSES);
        if (!h) continue;
        if (got.includes(h)) err(s.line, 'value', `\`harness\` lists \`${h}\` twice`);
        else got.push(h);
      }
      if (items.length === 0) err(harnessE.keyLine, 'value', '`harness` must not be empty; omit it to accept any harness');
      else if (got.includes('any') && got.length > 1) err(harnessE.keyLine, 'value', '`any` cannot be combined with other harnesses');
      if (got.length > 0) harness = got;
    }
  }

  // model
  let model: ModelTier = 'medium';
  const modelE = get('model');
  if (modelE) {
    const s = scalar(modelE);
    if (s) model = enumOf(modelE, s, MODEL_TIERS) ?? model;
  }

  // context
  let context: Asset | undefined;
  const contextE = get('context');
  if (contextE) context = checkAsset(contextE.value, 'context', contextE.keyLine, err, { expires: true });

  // repos
  const repos: RepoEntry[] = [];
  const repoLines: { item: number; ref?: number }[] = [];
  let reposOk = true;
  const reposE = get('repos');
  if (reposE) {
    const before = errors.length;
    if (reposE.value.kind !== 'list') {
      err(reposE.keyLine, 'type', '`repos` must be a list: one `- url: ...` entry per repo, with `ref:` or `pr:` on the next line');
    } else {
      reposE.value.items.forEach((item, i) => {
        const r = repoEntry(item, `repos[${i}]`, err);
        if (r) {
          repos.push(r.entry);
          repoLines.push(r.lines);
        }
      });
    }
    if (errors.length === before) {
      for (let i = 0; i < repos.length; i++) {
        for (let j = 0; j < i; j++) {
          const a = repos[j]!.path.toLowerCase();
          const b = repos[i]!.path.toLowerCase();
          if (a === b) {
            err(repoLines[i]!.item, 'value', `\`repos[${i}]\` checks out into \`repo/${repos[i]!.path}\`, like \`repos[${j}]\`; set a different \`path\` on one of them (paths compare case-insensitively)`);
          } else if (b.startsWith(`${a}/`) || a.startsWith(`${b}/`)) {
            err(repoLines[i]!.item, 'value', `\`repos[${i}]\` (\`${repos[i]!.path}\`) and \`repos[${j}]\` (\`${repos[j]!.path}\`) would be checked out inside each other; pick paths that don't nest`);
          }
        }
      }
    }
    reposOk = errors.length === before;
  }

  // resume
  const resumeE = get('resume');
  const resume = resumeE && checkResume(resumeE.value, 'resume', resumeE.keyLine, err, reposOk ? repos : undefined);

  // setup
  let setup: string[] = [];
  const setupE = get('setup');
  if (setupE) {
    if (setupE.value.kind !== 'list' || setupE.value.items.some((s) => s.kind === 'map')) {
      err(setupE.keyLine, 'type', '`setup` must be a list of commands (one `- command` per line; quote a command that contains `: `)');
    } else {
      const items = setupE.value.items as Scalar[];
      setup = items.map((s) => s.value);
      for (const s of items) if (s.value.trim() === '') err(s.line, 'value', '`setup` commands must not be empty');
    }
  }

  // check
  let check: string | undefined;
  const checkE = get('check');
  if (checkE) {
    const s = scalar(checkE);
    if (s && s.value.trim() === '') err(s.line, 'value', '`check` must not be empty');
    else if (s) check = s.value;
  }

  // deliver
  let deliver: Deliver | undefined;
  const deliverE = required('deliver');
  if (deliverE) {
    const s = scalar(deliverE);
    if (s) deliver = enumOf(deliverE, s, DELIVERIES);
    if (deliver === 'pr' && reposOk) {
      if (repos.length === 0) err(s!.line, 'missing', '`deliver: pr` requires `repos`, with at least one repo to open a pull request on');
      else if (repos.every((r) => r.deliver === 'none')) err(s!.line, 'value', '`deliver: pr` needs a repo to deliver to, but every entry in `repos` has `deliver: none`');
      repos.forEach((r, i) => {
        if (r.deliver === 'none') return;
        if (r.pr !== undefined) {
          err(repoLines[i]!.item, 'value', `\`repos[${i}]\` uses \`pr\`, and \`deliver: pr\` can't open a pull request against another one; use \`ref\` with a branch, or add \`deliver: none\``);
        } else if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(r.ref!)) {
          // A full commit SHA is certainly not a branch to open the PR against.
          warnings.push({ line: repoLines[i]!.ref!, code: 'value', message: `\`deliver: pr\` needs \`repos[${i}].ref\` to be a branch to open the PR against, but it looks like a commit SHA` });
        }
      });
    }
  }

  // deadline
  let deadline: string | undefined;
  const deadlineE = get('deadline');
  if (deadlineE) {
    const s = scalar(deadlineE);
    if (s && !isDeadline(s.value)) err(s.line, 'value', '`deadline` must be a date (2026-11-20) or a date-time with offset (2026-11-20T17:00:00Z, 2026-11-20T17:00:00.5+01:00)');
    else if (s) deadline = s.value;
  }

  // timeout
  let timeoutMinutes = DEFAULT_TIMEOUT_MINUTES;
  const timeoutE = get('timeout');
  if (timeoutE) {
    const s = scalar(timeoutE);
    if (s) {
      const t = parseDuration(s.value);
      if (t === undefined) err(s.line, 'value', '`timeout` must be a duration like 90m, 2h or 1h30m');
      else if (t < 1 || t > MAX_TIMEOUT_MINUTES) err(s.line, 'value', '`timeout` must be between 1m and 24h');
      else timeoutMinutes = t;
    }
  }

  if (nonStringLines.size > 0) {
    const later = errors.splice(firstNonString).filter((d) => !nonStringLines.has(d.line));
    errors.push(...later);
  }
  if (air === undefined || !effort || !deliver || errors.length > 0) return undefined;
  const req: Request = { air, effort, harness, model, repos, setup, deliver, timeoutMinutes };
  if (context) req.context = context;
  if (resume) req.resume = resume;
  if (check !== undefined) req.check = check;
  if (deadline !== undefined) req.deadline = deadline;
  return req;
}

/**
 * Why setup, serve and delivery can't run a request yet, or undefined if they can: they handle at most
 * one repo, checked out at a `ref` into `repo/`. Temporary, until they implement the rest.
 */
export function singleRepoLimitation(r: Request): string | undefined {
  if (r.repos.length > 1) return 'it lists more than one repo';
  if (r.repos[0]?.pr !== undefined) return 'it checks out a pull request (`pr:`)';
  return undefined;
}

/** One `repos` entry, or undefined after reporting why it's invalid. */
function repoEntry(item: Scalar | MapNode, name: string, err: Report): { entry: RepoEntry; lines: { item: number; ref?: number } } | undefined {
  const m = scalarMap(item, name, item.line, ['url'], ['ref', 'pr', 'path', 'deliver'], err);
  if (!m) return undefined;
  const [url, ref, pr, path, deliver] = [m.get('url'), m.get('ref'), m.get('pr'), m.get('path'), m.get('deliver')];
  let bad = false;
  const fail: Report = (line, code, message) => {
    bad = true;
    err(line, code, message);
  };
  if (!url) bad = true;
  else if (!isSafeUrl(url.value)) fail(url.line, 'value', URL_MESSAGE(`${name}.url`));
  if (ref && pr) fail(pr.line, 'value', `\`${name}\` has both \`ref\` and \`pr\`; use one`);
  else if (!ref && !pr) fail(item.line, 'missing', `\`${name}\` needs \`ref\` (a branch, tag or commit) or \`pr\` (a pull request number)`);
  if (ref && !isGitRef(ref.value)) fail(ref.line, 'value', `\`${name}.ref\` is not a valid branch, tag or commit: \`${ref.value}\``);
  if (pr && (pr.quoted || !/^[1-9]\d{0,9}$/.test(pr.value))) fail(pr.line, 'type', `\`${name}.pr\` must be a pull request number, unquoted`);
  if (deliver && deliver.value !== 'none') {
    fail(deliver.line, 'value', `\`${name}.deliver\` can only be \`none\` (read-only, never pushed); omit it to deliver this repo as the request's \`deliver\` says`);
  }
  if (path && !isSafePath(path.value)) {
    fail(path.line, 'value', `\`${name}.path\` must be a relative folder like \`billing\` or \`deps/billing\`: segments of letters, digits, \`.\`, \`_\` and \`-\` that start with a letter, digit or \`_\`, separated by \`/\``);
  } else if (!path && url && !bad && !isSafePath(repoName(url.value))) {
    fail(item.line, 'missing', `\`${name}\`: no folder name can be made from \`${url.value}\`; set \`path\``);
  }
  if (bad) return undefined;
  const entry: RepoEntry = { url: url!.value, path: path?.value ?? repoName(url!.value) };
  if (ref) entry.ref = ref.value;
  if (pr) entry.pr = Number(pr.value);
  if (deliver) entry.deliver = 'none';
  const lines: { item: number; ref?: number } = { item: item.line };
  if (ref) lines.ref = ref.line;
  return { entry, lines };
}

/**
 * `resume` in a request, or in an `air-result` block (§6): checkpoint `branches` and the `out` zip. With
 * `repos`, each branch must name the `path` of a repo that isn't `deliver: none`.
 */
export function checkResume(v: Value, name: string, line: number, err: Report, repos?: RepoEntry[]): Resume | undefined {
  const m = mapOf(v, name, line, [], ['branches', 'out'], err);
  if (!m) return undefined;
  let bad = false;
  const fail: Report = (l, code, message) => {
    bad = true;
    err(l, code, message);
  };
  const outE = m.get('out');
  const out = outE && checkAsset(outE.value, `${name}.out`, outE.keyLine, fail, { expires: false });
  if (outE && !out) bad = true;
  const branches: Resume['branches'] = [];
  const branchesE = m.get('branches');
  if (branchesE && branchesE.value.kind !== 'list') {
    fail(branchesE.keyLine, 'type', `\`${name}.branches\` must be a list of \`- repo: <path>\` entries, each with \`branch\` and \`sha\``);
  } else if (branchesE && branchesE.value.kind === 'list') {
    branchesE.value.items.forEach((item, i) => {
      const at = `${name}.branches[${i}]`;
      const b = scalarMap(item, at, item.line, ['repo', 'branch', 'sha'], [], fail);
      if (!b) return void (bad = true);
      const [repo, branch, sha] = [b.get('repo'), b.get('branch'), b.get('sha')];
      if (!repo || !branch || !sha) return void (bad = true);
      if (!isSafePath(repo.value)) fail(repo.line, 'value', `\`${at}.repo\` must be a repo's \`path\`, a relative folder under \`repo/\``);
      else if (repos) {
        const target = repos.find((r) => r.path === repo.value);
        if (!target) fail(repo.line, 'value', `\`${at}.repo\` must be the \`path\` of an entry in \`repos\`; none checks out into \`repo/${repo.value}\``);
        else if (target.deliver === 'none') fail(repo.line, 'value', `\`${at}.repo\` names \`${repo.value}\`, which has \`deliver: none\`: read-only repos have no checkpoint branch`);
      }
      if (!isGitRef(branch.value)) fail(branch.line, 'value', `\`${at}.branch\` is not a valid branch name: \`${branch.value}\``);
      if (!isSha(sha.value)) fail(sha.line, 'value', `\`${at}.sha\` must be a full commit SHA (40 or 64 lowercase hex digits)`);
      if (branches.some((x) => x.repo === repo.value)) fail(repo.line, 'value', `\`${name}.branches\` lists \`${repo.value}\` twice`);
      branches.push({ repo: repo.value, branch: branch.value, sha: sha.value });
    });
  }
  if (!outE && !(branchesE?.value.kind === 'list' && branchesE.value.items.length > 0)) fail(line, 'missing', `\`${name}\` needs a \`branches\` entry, \`out\` or both`);
  if (bad) return undefined;
  return out ? { branches, out } : { branches };
}

/** The last path segment of a clone URL without `.git`: the default `path` of a `repos` entry. */
export function repoName(url: string): string {
  let segments: string[];
  try {
    segments = new URL(url).pathname.split('/').filter(Boolean);
  } catch {
    return '';
  }
  return (segments.at(-1) ?? '').replace(/\.git$/, '');
}

/** A relative folder under `repo/`: no absolute paths, no `.`/`..` or hidden segments, no option-like names. */
export function isSafePath(s: string): boolean {
  return s.length > 0 && s.length <= 200 && s.split('/').every((seg) => /^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(seg));
}

/** A full commit SHA (SHA-1 or SHA-256). */
export function isSha(s: string): boolean {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(s);
}

/**
 * A release-asset reference (`context`, `resume.out`, a result's `artifact`): `url`, `sha256`, `bytes`
 * and, if `expires` is allowed, an optional `expires` date.
 */
export function checkAsset(v: Value, name: string, line: number, err: Report, opts: { expires: boolean }): Asset | undefined {
  const m = scalarMap(v, name, line, ['url', 'sha256', 'bytes'], opts.expires ? ['expires'] : [], err);
  if (!m) return undefined;
  const [url, sha, bytes, expires] = [m.get('url'), m.get('sha256'), m.get('bytes'), m.get('expires')];
  let bad = false;
  const fail: Report = (l, code, message) => {
    bad = true;
    err(l, code, message);
  };
  if (url && !isSafeUrl(url.value)) fail(url.line, 'value', URL_MESSAGE(`${name}.url`));
  if (sha && !/^[0-9a-f]{64}$/.test(sha.value)) fail(sha.line, 'value', `\`${name}.sha256\` must be 64 lowercase hex digits (the output of \`sha256sum\`)`);
  if (bytes && (bytes.quoted || !/^[1-9]\d*$/.test(bytes.value))) fail(bytes.line, 'type', `\`${name}.bytes\` must be a positive unquoted integer`);
  else if (bytes && Number(bytes.value) > MAX_CONTEXT_BYTES) fail(bytes.line, 'value', `\`${name}.bytes\` exceeds the 2 GiB limit`);
  if (expires && !isDate(expires.value)) fail(expires.line, 'value', `\`${name}.expires\` must be a date like 2026-12-31`);
  if (bad || !url || !sha || !bytes) return undefined;
  const asset: Asset = { url: url.value, sha256: sha.value, bytes: Number(bytes.value) };
  if (expires) asset.expires = expires.value;
  return asset;
}

/** Checks `v` is a map with all `required` keys and only `optional` others; returns its entries. */
export function mapOf(v: Value, name: string, line: number, required: readonly string[], optional: readonly string[], err: Report): Map<string, Entry> | undefined {
  const keys = [...required, ...optional];
  if (v.kind !== 'map') {
    const shape = required.length ? `with ${required.map((k) => `\`${k}\``).join(', ')} on indented lines` : 'of indented `key: value` lines';
    err(line, 'type', `\`${name}\` must be a map ${shape}`);
    return undefined;
  }
  const out = new Map<string, Entry>();
  for (const sub of v.entries.values()) {
    if (!keys.includes(sub.key)) {
      const near = closest(sub.key, keys);
      err(sub.keyLine, 'unknown-key', `unknown key \`${name}.${sub.key}\`${near ? ` (did you mean \`${near}\`?)` : ''}`);
    } else out.set(sub.key, sub);
  }
  for (const k of required) if (!v.entries.has(k)) err(line, 'missing', `\`${name}\` is missing \`${k}\``);
  return out;
}

/** Like `mapOf`, for a map whose values must all be scalars. */
export function scalarMap(v: Value, name: string, line: number, required: readonly string[], optional: readonly string[], err: Report): Map<string, Scalar> | undefined {
  const m = mapOf(v, name, line, required, optional, err);
  if (!m) return undefined;
  const out = new Map<string, Scalar>();
  for (const [k, e] of m) {
    if (e.value.kind === 'scalar') out.set(k, e.value);
    else err(e.keyLine, 'type', `\`${name}.${k}\` must be a single value`);
  }
  return out;
}

/**
 * Reports every unquoted value that YAML 1.2 reads as a null, boolean or number, outside `numeric`
 * fields (paths like `context.bytes`; list indices are left out). Returns the lines reported.
 */
export function nonStringErrors(entries: Map<string, Entry>, numeric: readonly string[], err: Report): Set<number> {
  const lines = new Set<number>();
  const check = (path: string, shown: string, sc: Scalar) => {
    const kind = sc.quoted || numeric.includes(path) ? undefined : yamlNonStringKind(sc.value);
    if (!kind) return;
    err(sc.line, 'type', `\`${shown}\`: YAML reads unquoted \`${sc.value}\` as a ${kind}; quote it: "${sc.value}"`);
    lines.add(sc.line);
  };
  const visit = (path: string, shown: string, v: Value) => {
    if (v.kind === 'scalar') check(path, shown, v);
    else if (v.kind === 'map') for (const sub of v.entries.values()) visit(`${path}.${sub.key}`, `${shown}.${sub.key}`, sub.value);
    else v.items.forEach((it, i) => (it.kind === 'map' ? visit(path, `${shown}[${i}]`, it) : check(path, shown, it)));
  };
  for (const e of entries.values()) visit(e.key, e.key, e.value);
  return lines;
}

/** Fields whose values are integers rather than strings. */
const INTEGER_FIELDS = ['air', 'context.bytes', 'repos.pr', 'resume.out.bytes'];

/** What a YAML 1.2 (core schema) parser makes of a plain scalar, if not a string. */
export function yamlNonStringKind(v: string): 'null' | 'boolean' | 'number' | undefined {
  if (/^(?:null|Null|NULL|~)$/.test(v)) return 'null';
  if (/^(?:true|True|TRUE|false|False|FALSE)$/.test(v)) return 'boolean';
  if (/^(?:[-+]?[0-9]+|0o[0-7]+|0x[0-9a-fA-F]+)$/.test(v)) return 'number';
  if (/^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?$/.test(v)) return 'number';
  if (/^(?:[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$/.test(v)) return 'number';
  return undefined;
}

export const URL_MESSAGE = (field: string) =>
  `\`${field}\` must be an https:// URL using only letters, digits and \`. - _ ~ % + = @ : , / ?\` (no spaces, quotes, \`&\`, \`;\`, \`$\` or other shell characters)`;

/**
 * https URLs from a conservative character set: no whitespace, quotes or shell metacharacters, no
 * userinfo, no fragment. Servers still pass URLs to git/curl as argv, never through a shell.
 */
export function isSafeUrl(s: string): boolean {
  if (!/^https:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?(?:\/[A-Za-z0-9._~%+=@:,\/?-]*)?$/.test(s)) return false;
  try {
    return new URL(s).hostname !== '';
  } catch {
    return false;
  }
}

/** A loose subset of git-check-ref-format, enough to reject typos and option injection. */
export function isGitRef(s: string): boolean {
  return /^[A-Za-z0-9_][A-Za-z0-9._/+-]*$/.test(s) && !s.includes('..') && !s.includes('//') && !s.endsWith('/') && !s.endsWith('.lock') && !s.endsWith('.');
}

export function isDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

/** YYYY-MM-DD, or RFC 3339 date-time (seconds and fraction optional) with Z or an offset. */
function isDeadline(s: string): boolean {
  const m = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-](\d{2}):(\d{2})))?$/.exec(s);
  if (!m || !isDate(m[1]!)) return false;
  if (m[2] !== undefined && (Number(m[2]) > 23 || Number(m[3]) > 59 || Number(m[4] ?? 0) > 59)) return false;
  if (m[5] !== undefined && (Number(m[5]) > 23 || Number(m[6]) > 59)) return false;
  return true;
}

/** Parses `90m`, `2h`, `1h30m` into minutes. */
export function parseDuration(s: string): number | undefined {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?$/.exec(s);
  if (!m || (m[1] === undefined && m[2] === undefined)) return undefined;
  return Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0);
}

function closest(word: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestD = 3;
  for (const c of candidates) {
    const d = editDistance(word.toLowerCase(), c);
    if (d < bestD) [best, bestD] = [c, d];
  }
  return best;
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length]!;
}
