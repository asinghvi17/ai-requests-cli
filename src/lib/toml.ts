// A TOML subset: `[table]` / `[a."b.c"]` headers, `key = value` with bare or quoted keys, basic and literal
// strings, integers, floats, booleans, and (possibly multi-line) arrays of those scalars. No inline tables,
// arrays of tables, dates or multi-line strings: those are rejected with a line number.
// Tables have a null prototype and the keys __proto__, prototype and constructor are rejected, so a config
// file can't reach Object.prototype or shadow it for later lookups.

export type TomlScalar = string | number | boolean;
export type TomlValue = TomlScalar | TomlScalar[] | TomlTable;
export type TomlTable = { [key: string]: TomlValue };

export class TomlError extends Error {
  constructor(message: string, line: number) {
    super(`line ${line}: ${message}`);
  }
}

const BARE = /[A-Za-z0-9_-]/;

class Cursor {
  pos = 0;
  line = 1;
  readonly src: string;
  constructor(src: string) { this.src = src; }
  peek(): string | undefined { return this.src[this.pos]; }
  next(): string | undefined {
    const c = this.src[this.pos++];
    if (c === '\n') this.line++;
    return c;
  }
  fail(message: string): never { throw new TomlError(message, this.line); }
  // Skip spaces and tabs, and with `newlines` also newlines and comments.
  skip(newlines = false): void {
    for (;;) {
      const c = this.peek();
      if (c === ' ' || c === '\t' || c === '\r') this.pos++;
      else if (newlines && c === '\n') this.next();
      else if (newlines && c === '#') while (this.peek() !== undefined && this.peek() !== '\n') this.pos++;
      else return;
    }
  }
  // After a statement: only a comment may follow on the line.
  endLine(): void {
    this.skip();
    if (this.peek() === '#') while (this.peek() !== undefined && this.peek() !== '\n') this.pos++;
    const c = this.peek();
    if (c !== undefined && c !== '\n') this.fail(`unexpected ${JSON.stringify(c)}`);
  }
}

const ESCAPES: Record<string, string> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };

function basicString(c: Cursor): string {
  c.next(); // opening "
  let out = '';
  for (;;) {
    const peek = c.peek();
    if (peek === undefined || peek === '\n') c.fail('unterminated string');
    const ch = c.next();
    if (ch === '"') return out;
    if (ch !== '\\') { out += ch; continue; }
    const e = c.next();
    if (e === 'u' || e === 'U') {
      const hex = c.src.slice(c.pos, c.pos + (e === 'u' ? 4 : 8));
      if (!/^[0-9A-Fa-f]+$/.test(hex) || hex.length !== (e === 'u' ? 4 : 8)) c.fail('bad unicode escape');
      const cp = parseInt(hex, 16);
      if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) c.fail(`\\${e}${hex} is not a Unicode scalar value`);
      c.pos += hex.length;
      out += String.fromCodePoint(cp);
    } else if (e !== undefined && e in ESCAPES) {
      out += ESCAPES[e];
    } else {
      c.fail(`bad escape \\${e ?? ''}`);
    }
  }
}

function literalString(c: Cursor): string {
  c.next(); // opening '
  const end = c.src.indexOf("'", c.pos);
  const nl = c.src.indexOf('\n', c.pos);
  if (end < 0 || (nl >= 0 && nl < end)) c.fail('unterminated string');
  const s = c.src.slice(c.pos, end);
  c.pos = end + 1;
  return s;
}

const RESERVED = new Set(['__proto__', 'prototype', 'constructor']);

function key(c: Cursor): string[] {
  const parts: string[] = [];
  for (;;) {
    c.skip();
    const ch = c.peek();
    if (ch === '"') parts.push(basicString(c));
    else if (ch === "'") parts.push(literalString(c));
    else {
      const start = c.pos;
      while (c.peek() !== undefined && BARE.test(c.peek()!)) c.pos++;
      if (c.pos === start) c.fail('expected a key');
      parts.push(c.src.slice(start, c.pos));
    }
    const part = parts.at(-1)!;
    if (RESERVED.has(part)) c.fail(`key ${JSON.stringify(part)} is not allowed`);
    c.skip();
    if (c.peek() !== '.') return parts;
    c.pos++;
  }
}

function scalar(c: Cursor): TomlScalar {
  const ch = c.peek();
  if (ch === '"') {
    if (c.src.startsWith('"""', c.pos)) c.fail('multi-line strings are not supported');
    return basicString(c);
  }
  if (ch === "'") {
    if (c.src.startsWith("'''", c.pos)) c.fail('multi-line strings are not supported');
    return literalString(c);
  }
  if (ch === '{') c.fail('inline tables are not supported');
  const start = c.pos;
  while (c.peek() !== undefined && /[^\s,\]#]/.test(c.peek()!)) c.pos++;
  const word = c.src.slice(start, c.pos);
  if (word === 'true') return true;
  if (word === 'false') return false;
  if (/^[+-]?(0|[1-9](_?\d)*)$/.test(word)) return Number(word.replaceAll('_', ''));
  if (/^[+-]?(0|[1-9](_?\d)*)(\.\d(_?\d)*)?([eE][+-]?\d(_?\d)*)?$/.test(word)) return Number(word.replaceAll('_', ''));
  if (/^[+-]?(inf|nan)$/.test(word)) return word.endsWith('inf') ? (word[0] === '-' ? -Infinity : Infinity) : NaN;
  c.fail(word === '' ? 'expected a value' : `unsupported value ${JSON.stringify(word)}`);
}

function value(c: Cursor): TomlValue {
  if (c.peek() !== '[') return scalar(c);
  c.next();
  const items: TomlScalar[] = [];
  for (;;) {
    c.skip(true);
    if (c.peek() === ']') break;
    if (c.peek() === '[') c.fail('nested arrays are not supported');
    items.push(scalar(c));
    c.skip(true);
    if (c.peek() === ',') { c.next(); continue; }
    if (c.peek() !== ']') c.fail('expected , or ] in array');
  }
  c.next();
  return items;
}

function isTable(v: TomlValue | undefined): v is TomlTable {
  return typeof v === 'object' && !Array.isArray(v);
}

export function parseToml(src: string): TomlTable {
  const root: TomlTable = Object.create(null);
  const defined = new Set<TomlTable>(); // tables opened by a [header], to reject duplicates
  let current = root;
  const c = new Cursor(src);
  const descend = (from: TomlTable, path: string[], name: string): TomlTable => {
    let t = from;
    for (const part of path) {
      const existing = Object.hasOwn(t, part) ? t[part] : undefined;
      if (existing === undefined) t = t[part] = Object.create(null) as TomlTable;
      else if (isTable(existing)) t = existing;
      else c.fail(`${name} is not a table`);
    }
    return t;
  };
  for (;;) {
    c.skip(true);
    const ch = c.peek();
    if (ch === undefined) return root;
    if (ch === '[') {
      c.next();
      if (c.peek() === '[') c.fail('arrays of tables are not supported');
      const path = key(c);
      if (c.next() !== ']') c.fail('expected ] after table name');
      const name = path.join('.');
      current = descend(root, path, name);
      if (defined.has(current)) c.fail(`table ${name} defined twice`);
      defined.add(current);
    } else {
      const path = key(c);
      if (c.next() !== '=') c.fail('expected = after key');
      c.skip();
      const last = path.pop()!;
      const table = descend(current, path, path.join('.'));
      if (Object.hasOwn(table, last)) c.fail(`key ${[...path, last].join('.')} defined twice`);
      table[last] = value(c);
    }
    c.endLine();
  }
}
