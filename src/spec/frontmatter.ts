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

export interface ContextZip {
  url: string;
  sha256: string;
  bytes: number;
  /** YYYY-MM-DD after which `air sweep` may delete the zip. Absent: 14 days after the issue closes. */
  expires?: string;
}

export interface RepoRef {
  url: string;
  ref: string;
}

export interface Request {
  air: number;
  effort: Effort;
  harness: Harness[];
  model: ModelTier;
  context?: ContextZip;
  repo?: RepoRef;
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
  | { ok: true; request: Request; /** 0-based index into `lines` of the first line after the closing `---`. */ bodyStart: number; lines: string[] }
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
  items: Scalar[];
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
  const entries = new Map<string, Entry>();
  const errors: Diagnostic[] = [];
  const err = (line: number, message: string) => errors.push({ line, code: 'yaml', message });

  // The top-level or nested key whose value is an indented block still being read.
  interface Open {
    entry: Entry;
    into: Map<string, Entry>; // where the entry lives, for the "no value" check
    childIndent?: number;
    nested: boolean; // a key inside a nested map: may only hold a block list, not another map
  }
  let open: Open | undefined;
  let topMap: { entry: Entry; indent: number } | undefined; // nested map currently being filled

  const closeOpen = () => {
    if (open && open.childIndent === undefined) {
      err(open.entry.keyLine, `\`${open.entry.key}\` has no value`);
    }
    open = undefined;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const lineNo = firstLine + i;
    if (/^\s*(#.*)?$/.test(raw)) continue;
    const lead = /^[ \t]*/.exec(raw)![0];
    if (lead.includes('\t')) {
      err(lineNo, 'indent with spaces, not tabs');
      continue;
    }
    const indent = lead.length;
    const text = raw.slice(indent);

    // Block-list item: belongs to the open key (YAML allows the dash at the key's own indent).
    if (text === '-' || text.startsWith('- ')) {
      const owner = open;
      if (!owner || (owner.childIndent !== undefined && owner.childIndent !== indent) || owner.entry.value.kind === 'map') {
        err(lineNo, owner ? 'list item is not aligned with the previous item' : 'list item without a key');
        continue;
      }
      const ownerIndent = owner.nested ? topMap!.indent : 0;
      if (indent < ownerIndent) {
        err(lineNo, 'list item is indented less than its key');
        continue;
      }
      owner.childIndent = indent;
      const list = owner.entry.value as List;
      const item = text.slice(1).trimStart();
      if (item === '' || item.startsWith('#')) {
        err(lineNo, 'empty list item');
        continue;
      }
      if (item.startsWith('[') || item.startsWith('{')) {
        err(lineNo, 'nested collections are not allowed in list items; quote the value if it is a string');
        continue;
      }
      const s = parseScalar(item, lineNo, false, errors);
      if (s) list.items.push(s);
      continue;
    }

    const m = KEY_RE.exec(text);
    if (!m) {
      err(lineNo, text.startsWith('---') ? 'unexpected `---` inside front matter' : 'expected `key: value`');
      continue;
    }
    const key = m[1]!;
    const rest = m[2]!.trim();

    // Decide which map this key belongs to.
    let target: Map<string, Entry>;
    let nested: boolean;
    if (indent === 0) {
      closeOpen();
      topMap = undefined;
      target = entries;
      nested = false;
    } else if (topMap && indent === topMap.indent) {
      if (open && open.nested) closeOpen();
      target = (topMap.entry.value as MapNode).entries;
      nested = true;
    } else if (open && !open.nested && open.childIndent === undefined) {
      // First key under `open`: it becomes a nested map.
      const entry = open.entry;
      open.childIndent = indent;
      entry.value = { kind: 'map', entries: new Map(), line: entry.keyLine };
      open = undefined;
      topMap = { entry, indent };
      target = entry.value.entries;
      nested = true;
    } else {
      err(lineNo, topMap || open ? 'maps nest only one level deep; check the indentation' : 'unexpected indentation');
      continue;
    }

    if (target.has(key)) {
      err(lineNo, `duplicate key \`${key}\``);
      continue;
    }
    const valueText = stripComment(rest);
    const entry: Entry = { key, keyLine: lineNo, value: { kind: 'list', items: [], line: lineNo } };
    target.set(key, entry);
    if (valueText === '') {
      open = { entry, into: target, nested };
      continue;
    }
    if (rest.startsWith('[')) {
      const list = parseFlowList(rest, lineNo, errors);
      if (list) entry.value = list;
      else target.delete(key);
    } else if (rest.startsWith('{')) {
      err(lineNo, 'flow maps `{...}` are not supported; write the map as indented `key: value` lines');
      target.delete(key);
    } else if (/^[|>][-+0-9]*$/.test(valueText)) {
      err(lineNo, 'multi-line strings are not supported');
      target.delete(key);
    } else {
      const s = parseScalar(rest, lineNo, false, errors);
      if (s) entry.value = s;
      else target.delete(key);
    }
  }
  closeOpen();
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

const FIELDS = ['air', 'effort', 'harness', 'model', 'context', 'repo', 'setup', 'check', 'deliver', 'deadline', 'timeout'] as const;

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
  const req = validateFields(entries, closeLine, errors);
  if (errors.length > 0 || !req) return { ok: false, lines, bodyStart, errors: sortDiagnostics(errors) };
  return { ok: true, request: req, bodyStart, lines };
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

function validateFields(entries: Map<string, Entry>, closeLine: number, errors: Diagnostic[]): Request | undefined {
  const err = (line: number, code: DiagnosticCode, message: string): void => {
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
  const nonStringLines = new Set<number>();
  const visit = (path: string, v: Value) => {
    if (v.kind === 'map') for (const sub of v.entries.values()) visit(`${path}.${sub.key}`, sub.value);
    for (const sc of v.kind === 'list' ? v.items : v.kind === 'scalar' ? [v] : []) {
      const kind = sc.quoted || INTEGER_FIELDS.includes(path) ? undefined : yamlNonStringKind(sc.value);
      if (!kind) continue;
      err(sc.line, 'type', `\`${path}\`: YAML reads unquoted \`${sc.value}\` as a ${kind}; quote it: "${sc.value}"`);
      nonStringLines.add(sc.line);
    }
  };
  for (const e of entries.values()) visit(e.key, e.value);
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
    if (v.kind === 'map') err(harnessE.keyLine, 'type', '`harness` must be a list, e.g. [claude, codex]');
    else {
      const items = v.kind === 'scalar' ? [v] : v.items;
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
  let context: ContextZip | undefined;
  const contextE = get('context');
  if (contextE) {
    const m = mapFields(contextE, ['url', 'sha256', 'bytes'], ['expires'], err);
    if (m) {
      const url = m.get('url');
      const sha = m.get('sha256');
      const bytes = m.get('bytes');
      const expires = m.get('expires');
      const before = errors.length;
      if (url && !isSafeUrl(url.value)) err(url.line, 'value', URL_MESSAGE('context.url'));
      if (sha && !/^[0-9a-f]{64}$/.test(sha.value)) err(sha.line, 'value', '`context.sha256` must be 64 lowercase hex digits (the output of `sha256sum`)');
      if (bytes && (bytes.quoted || !/^[1-9]\d*$/.test(bytes.value))) err(bytes.line, 'type', '`context.bytes` must be a positive unquoted integer');
      else if (bytes && Number(bytes.value) > MAX_CONTEXT_BYTES) err(bytes.line, 'value', '`context.bytes` exceeds the 2 GiB limit');
      if (expires && !isDate(expires.value)) err(expires.line, 'value', '`context.expires` must be a date like 2026-12-31');
      if (errors.length === before && url && sha && bytes) {
        context = { url: url.value, sha256: sha.value, bytes: Number(bytes.value) };
        if (expires) context.expires = expires.value;
      }
    }
  }

  // repo
  let repo: RepoRef | undefined;
  const repoE = get('repo');
  if (repoE) {
    const m = mapFields(repoE, ['url', 'ref'], [], err);
    if (m) {
      const url = m.get('url');
      const ref = m.get('ref');
      const before = errors.length;
      if (url && !isSafeUrl(url.value)) err(url.line, 'value', URL_MESSAGE('repo.url'));
      if (ref && !isGitRef(ref.value)) err(ref.line, 'value', `\`repo.ref\` is not a valid branch, tag or commit: \`${ref.value}\``);
      if (errors.length === before && url && ref) repo = { url: url.value, ref: ref.value };
    }
  }

  // setup
  let setup: string[] = [];
  const setupE = get('setup');
  if (setupE) {
    if (setupE.value.kind !== 'list') err(setupE.keyLine, 'type', '`setup` must be a list of commands (one `- command` per line)');
    else {
      setup = setupE.value.items.map((s) => s.value);
      for (const s of setupE.value.items) if (s.value.trim() === '') err(s.line, 'value', '`setup` commands must not be empty');
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
    if (deliver === 'pr' && !repoE) err(s!.line, 'missing', '`deliver: pr` requires `repo`');
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
  const req: Request = { air, effort, harness, model, setup, deliver, timeoutMinutes };
  if (context) req.context = context;
  if (repo) req.repo = repo;
  if (check !== undefined) req.check = check;
  if (deadline !== undefined) req.deadline = deadline;
  return req;
}

/** Checks a nested map has all `required` keys, optionally `optional` ones, all scalars. */
function mapFields(
  e: Entry,
  required: readonly string[],
  optional: readonly string[],
  err: (line: number, code: DiagnosticCode, message: string) => void,
): Map<string, Scalar> | undefined {
  const keys = [...required, ...optional];
  if (e.value.kind !== 'map') {
    err(e.keyLine, 'type', `\`${e.key}\` must be a map with ${required.map((k) => `\`${k}\``).join(', ')} on indented lines`);
    return undefined;
  }
  const out = new Map<string, Scalar>();
  for (const sub of e.value.entries.values()) {
    if (!keys.includes(sub.key)) {
      const near = closest(sub.key, keys);
      err(sub.keyLine, 'unknown-key', `unknown key \`${e.key}.${sub.key}\`${near ? ` (did you mean \`${near}\`?)` : ''}`);
    } else if (sub.value.kind !== 'scalar') err(sub.keyLine, 'type', `\`${e.key}.${sub.key}\` must be a single value`);
    else out.set(sub.key, sub.value);
  }
  for (const k of required) if (!e.value.entries.has(k)) err(e.keyLine, 'missing', `\`${e.key}\` is missing \`${k}\``);
  return out;
}

/** Fields whose values are integers rather than strings. */
const INTEGER_FIELDS = ['air', 'context.bytes'];

/** What a YAML 1.2 (core schema) parser makes of a plain scalar, if not a string. */
export function yamlNonStringKind(v: string): 'null' | 'boolean' | 'number' | undefined {
  if (/^(?:null|Null|NULL|~)$/.test(v)) return 'null';
  if (/^(?:true|True|TRUE|false|False|FALSE)$/.test(v)) return 'boolean';
  if (/^(?:[-+]?[0-9]+|0o[0-7]+|0x[0-9a-fA-F]+)$/.test(v)) return 'number';
  if (/^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?$/.test(v)) return 'number';
  if (/^(?:[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$/.test(v)) return 'number';
  return undefined;
}

const URL_MESSAGE = (field: string) =>
  `\`${field}\` must be an https:// URL using only letters, digits and \`. - _ ~ % + = @ : , / ?\` (no spaces, quotes, \`&\`, \`;\`, \`$\` or other shell characters)`;

/**
 * https URLs from a conservative character set: no whitespace, quotes or shell metacharacters, no
 * userinfo, no fragment. Servers still pass URLs to git/curl as argv, never through a shell.
 */
function isSafeUrl(s: string): boolean {
  if (!/^https:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?(?:\/[A-Za-z0-9._~%+=@:,\/?-]*)?$/.test(s)) return false;
  try {
    return new URL(s).hostname !== '';
  } catch {
    return false;
  }
}

/** A loose subset of git-check-ref-format, enough to reject typos and option injection. */
function isGitRef(s: string): boolean {
  return /^[A-Za-z0-9_][A-Za-z0-9._/+-]*$/.test(s) && !s.includes('..') && !s.includes('//') && !s.endsWith('/') && !s.endsWith('.lock') && !s.endsWith('.');
}

function isDate(s: string): boolean {
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
