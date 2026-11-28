import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fitTitle, lint, taskSummary, TITLE_LIMIT } from './lint.ts';
import type { DiagnosticCode } from './frontmatter.ts';

const root = new URL('../../', import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), 'utf8');

const SECTIONS = `
## Task

Do the thing.

## Done when

- The thing is done.
`;

function body(frontMatter: string, sections = SECTIONS): string {
  return `---\n${frontMatter.trim()}\n---\n${sections}`;
}

function codes(b: string): DiagnosticCode[] {
  return lint(b).errors.map((e) => e.code);
}

/** Asserts lint fails with exactly one error whose message matches `re`; returns it. */
function oneError(b: string, re: RegExp) {
  const r = lint(b);
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 1, JSON.stringify(r.errors));
  assert.match(r.errors[0]!.message, re);
  return r.errors[0]!;
}

const MIN = 'air: 0\neffort: S\ndeliver: comment';
const CTX = '\n## Context\n\nThe repos.\n';
/** A `repos` block with one entry per element, each given as its `key: value` lines. */
const reposOf = (...entries: string[][]) => `repos:\n${entries.map(([first, ...rest]) => [`  - ${first}`, ...rest.map((l) => `    ${l}`)].join('\n')).join('\n')}`;

test('every example in spec/examples lints clean', () => {
  const files = readdirSync(new URL('spec/examples/', root)).filter((f) => f.endsWith('.md'));
  assert.equal(files.length, 6);
  for (const f of files) {
    const r = lint(read(`spec/examples/${f}`));
    assert.deepEqual(r.errors, [], f);
    assert.deepEqual(r.warnings, [], f);
    assert.ok(r.request, f);
  }
});

test('examples parse to the expected requests', () => {
  const pr = lint(read('spec/examples/julia-pr.md')).request!;
  assert.deepEqual(pr, {
    air: 0,
    effort: 'M',
    harness: ['claude', 'codex'],
    model: 'medium',
    repos: [{ url: 'https://github.com/acme-analytics/TimeSeriesKit.jl.git', ref: 'main', path: 'TimeSeriesKit.jl' }],
    setup: ["julia --project=repo/TimeSeriesKit.jl -e 'using Pkg; Pkg.instantiate()'"],
    check: "julia --project=repo/TimeSeriesKit.jl -e 'using TimeSeriesKit'",
    deliver: 'pr',
    deadline: '2026-11-20',
    timeoutMinutes: 180,
  });
  const research = lint(read('spec/examples/research-summary.md')).request!;
  assert.equal(research.context?.bytes, 1843302);
  assert.equal(research.timeoutMinutes, 90);
  assert.equal(lint(read('spec/examples/data-cleanup.md')).request!.check, '.venv/bin/python -c "import pandas, pyarrow"');
  assert.equal(lint(read('spec/examples/data-cleanup.md')).request!.context!.expires, '2026-12-31');
  const review = lint(read('spec/examples/multi-repo-review.md')).request!;
  assert.deepEqual(review.repos.map((r) => [r.path, r.pr ?? r.ref]), [['service', 212], ['client', 87], ['service-main', 'main']]);
  const change = lint(read('spec/examples/multi-repo-change.md')).request!;
  assert.equal(change.deliver, 'pr');
  assert.deepEqual(change.repos.map((r) => [r.path, r.deliver ?? 'pr']), [['service', 'pr'], ['client', 'pr'], ['api-guidelines', 'none']]);
  const question = lint(read('spec/examples/zip-question.md')).request!;
  assert.deepEqual([question.repos, question.deliver, question.context?.bytes], [[], 'comment', 3207114]);
});

test('template is identical in both places and only fails on the unfilled sections', () => {
  const t = read('spec/templates/ai-request.md');
  assert.equal(read('.github/ISSUE_TEMPLATE/ai-request.md'), t);
  // GitHub strips the template's own front matter; the issue body is what follows.
  const issueBody = t.replace(/^---\n[\s\S]*?\n---\n/, '');
  const r = lint(issueBody);
  assert.deepEqual(
    r.errors.map((e) => e.message),
    ['`## Task` is empty', '`## Done when` is empty'],
  );
});

test('minimal request gets defaults', () => {
  const r = lint(body(MIN));
  assert.equal(r.ok, true);
  assert.deepEqual(r.request, { air: 0, effort: 'S', harness: ['any'], model: 'medium', repos: [], setup: [], deliver: 'comment', timeoutMinutes: 240 });
  assert.equal(r.sections.Task?.text, 'Do the thing.');
  assert.equal(r.sections['Done when']?.line, 11);
});

test('CRLF and BOM bodies parse the same as LF', () => {
  const lf = read('spec/examples/julia-pr.md');
  const crlf = '﻿' + lf.replace(/\n/g, '\r\n');
  const a = lint(lf);
  const b = lint(crlf);
  assert.equal(b.ok, true, JSON.stringify(b.errors));
  assert.deepEqual(b.request, a.request);
  assert.deepEqual(b.sections, a.sections);
  // and line numbers survive
  const bad = lint('---\r\nair: 0\r\neffort: XXL\r\ndeliver: comment\r\n---\r\n' + SECTIONS);
  assert.equal(bad.errors[0]!.line, 3);
});

test('missing required fields', () => {
  const r = lint(body('effort: S'));
  assert.deepEqual(
    r.errors.map((e) => [e.code, e.message, e.line]),
    [
      ['missing', 'missing required field `air`', 3],
      ['missing', 'missing required field `deliver`', 3],
    ],
  );
});

test('missing or unterminated front matter', () => {
  assert.deepEqual(codes(SECTIONS), ['frontmatter']);
  assert.deepEqual(codes('---\nair: 0\n' + SECTIONS), ['frontmatter']);
  // leading blank lines are tolerated
  assert.equal(lint('\n\n' + body(MIN)).ok, true);
});

test('bad effort', () => {
  const e = oneError(body('air: 0\neffort: XXL\ndeliver: comment'), /`effort` must be one of XS, S, M, L, XL; got `XXL`/);
  assert.equal(e.line, 3);
  oneError(body('air: 0\neffort: m\ndeliver: comment'), /got `m`/);
  oneError(body('air: 0\neffort: [S]\ndeliver: comment'), /single value/);
});

test('deliver: pr without repos', () => {
  const e = oneError(body('air: 0\neffort: S\ndeliver: pr'), /`deliver: pr` requires `repos`/);
  assert.equal(e.code, 'missing');
  oneError(body('air: 0\neffort: S\ndeliver: email'), /`deliver` must be one of comment, pr, artifact/);
});

test('unknown keys are errors, with suggestions', () => {
  const e = oneError(body(MIN + '\ntimout: 2h'), /unknown key `timout` \(did you mean `timeout`\?\)/);
  assert.equal(e.code, 'unknown-key');
  assert.equal(e.line, 5);
  oneError(body(MIN + '\nrepos:\n  - url: https://x.test/r.git\n    ref: main\n    branch: dev', SECTIONS + CTX), /unknown key `repos\[0\].branch`/);
  oneError(body(MIN + '\npriority: high'), /^unknown key `priority`$/);
});

test('newer spec version is rejected alone, even with syntax this parser rejects', () => {
  for (const fm of ['air: 1\neffort: S\ndeliver: comment', 'air: 3\nnew_thing: {a: 1}\neffort: |\n  multi', 'air: "2"\n']) {
    const r = lint(body(fm, '\n## Something new\n'));
    assert.equal(r.errors.length, 1, JSON.stringify(r.errors));
    assert.equal(r.errors[0]!.code, 'version');
    assert.match(r.errors[0]!.message, /version \d, but this air only understands version 0/);
    assert.deepEqual(r.warnings, []);
  }
  oneError(body('air: "0"\neffort: S\ndeliver: comment'), /unquoted integer/);
  oneError(body('air: zero\neffort: S\ndeliver: comment'), /unquoted integer/);
});

test('context validation', () => {
  const ctx = (sha: string, bytes = '10', url = 'https://example.test/a.zip') =>
    body(`${MIN}\ncontext:\n  url: ${url}\n  sha256: ${sha}\n  bytes: ${bytes}`, SECTIONS + '\n## Context\n\nA zip.\n');
  const good = 'a'.repeat(64);
  assert.equal(lint(ctx(good)).ok, true);
  oneError(ctx('a'.repeat(63)), /64 lowercase hex/);
  oneError(ctx('A'.repeat(64)), /64 lowercase hex/);
  oneError(ctx('g'.repeat(64)), /64 lowercase hex/);
  oneError(ctx(good, '0'), /positive unquoted integer/);
  oneError(ctx(good, '"10"'), /positive unquoted integer/);
  oneError(ctx(good, String(3 * 1024 ** 3)), /2 GiB/);
  oneError(ctx(good, '10', 'http://example.test/a.zip'), /https/);
  oneError(body(`${MIN}\ncontext:\n  url: https://example.test/a.zip\n  bytes: 10`, SECTIONS + '\n## Context\n\nA zip.\n'), /`context` is missing `sha256`/);
  oneError(body(`${MIN}\ncontext: https://example.test/a.zip`), /`context` must be a map/);
});

test('repo validation and the Context section requirement', () => {
  const withRepo = (ref: string) => `${MIN}\n${reposOf(['url: https://github.com/o/r.git', `ref: ${ref}`])}`;
  oneError(body(withRepo('main')), /missing `## Context` section \(required when `context` or `repos` is set\)/);
  const ctx = SECTIONS + '\n## Context\n\nThe repo.\n';
  assert.equal(lint(body(withRepo('feature/x-1'), ctx)).ok, true);
  assert.equal(lint(body(withRepo('0123abc'), ctx)).ok, true);
  oneError(body(withRepo('-rf'), ctx), /not a valid branch/);
  oneError(body(withRepo('a..b'), ctx), /not a valid branch/);
  oneError(body(withRepo('main'), SECTIONS + '\n## Context\n\n<!-- todo -->\n'), /`## Context` is empty/);
  // an empty Context section is fine when nothing requires it
  assert.equal(lint(body(MIN, SECTIONS + '\n## Context\n')).ok, true);
  assert.equal(lint(body(`${MIN}\nrepos: []`, SECTIONS + '\n## Context\n')).ok, true);
});

test('harness, model, setup, check, deadline, timeout', () => {
  const ok = (fm: string) => {
    const r = lint(body(`${MIN}\n${fm}`));
    assert.deepEqual(r.errors, [], fm);
    return r.request!;
  };
  assert.deepEqual(ok('harness: claude').harness, ['claude']);
  assert.deepEqual(ok('harness:\n  - claude\n  - codex').harness, ['claude', 'codex']);
  assert.deepEqual(ok('harness:\n- codex').harness, ['codex']);
  oneError(body(`${MIN}\nharness: [any, claude]`), /`any` cannot be combined/);
  oneError(body(`${MIN}\nharness: [claude, claude]`), /twice/);
  oneError(body(`${MIN}\nharness: []`), /must not be empty/);
  oneError(body(`${MIN}\nharness: [gemini]`), /one of claude, codex, any/);

  assert.equal(ok('model: large').model, 'large');
  oneError(body(`${MIN}\nmodel: opus`), /`model` must be one of small, medium, large; got `opus`/);

  assert.deepEqual(ok('setup: []').setup, []);
  assert.deepEqual(ok('setup: ["make deps", make]').setup, ['make deps', 'make']);
  assert.deepEqual(ok('setup:\n  - "echo a: b"\n  - make # build\n  - \'it\'\'s\'').setup, ['echo a: b', 'make', "it's"]);
  oneError(body(`${MIN}\nsetup: make`), /must be a list/);
  oneError(body(`${MIN}\nsetup:\n  - echo a: b`), /quote this value/);
  assert.equal(ok('check: "test -f out.txt"').check, 'test -f out.txt');
  oneError(body(`${MIN}\ncheck: ""`), /must not be empty/);

  assert.equal(ok('deadline: 2026-12-01').deadline, '2026-12-01');
  assert.equal(ok('deadline: 2026-12-01T17:30:00+01:00').deadline, '2026-12-01T17:30:00+01:00');
  oneError(body(`${MIN}\ndeadline: 2026-02-30`), /`deadline` must be a date/);
  oneError(body(`${MIN}\ndeadline: next friday`), /`deadline` must be a date/);

  assert.equal(ok('timeout: 90m').timeoutMinutes, 90);
  assert.equal(ok('timeout: 2h').timeoutMinutes, 120);
  assert.equal(ok('timeout: 1h30m').timeoutMinutes, 90);
  oneError(body(`${MIN}\ntimeout: 2 hours`), /duration like/);
  oneError(body(`${MIN}\ntimeout: 25h`), /between 1m and 24h/);
  oneError(body(`${MIN}\ntimeout: 0m`), /between 1m and 24h/);
});

test('YAML subset errors carry line numbers', () => {
  const cases: [string, RegExp, number][] = [
    ['air: 0\neffort: S\ndeliver: comment\nsetup:\n\t- make', /tabs/, 6],
    ['air: 0\neffort: S\neffort: M\ndeliver: comment', /duplicate key `effort`/, 4],
    ['air: 0\neffort: S\ndeliver: comment\nnotes: |\n  hi', /multi-line/, 5],
    ['air: 0\neffort: S\ndeliver: comment\nrepo: {url: x}', /flow maps/, 5],
    ['air: 0\neffort: S\ndeliver: comment\ncheck: "unterminated', /unterminated double-quoted/, 5],
    ['air: 0\neffort: S\ndeliver: comment\nsetup: [a, b', /missing `\]`/, 5],
    ['air: 0\neffort: S\ndeliver: comment\nsetup:', /`setup` has no value/, 5],
    ['air: 0\neffort: S\ndeliver: comment\ncontext:\n  url: https://x.test/r\n    ref: main', /unexpected indentation/, 7],
    ['air: 0\neffort: S\ndeliver: comment\nrepos:\n  - url: https://x.test/r\n      ref: main', /unexpected indentation/, 7],
    ['air: 0\neffort: S\ndeliver: comment\nrepos:\n  - url: https://x.test/r\n   ref: main', /unexpected indentation/, 7],
    ['air: 0\neffort: S\ndeliver: comment\nsetup:\n  - a\n   - b', /not aligned/, 7],
    ['air: 0\neffort: S\ndeliver: comment\nsetup:\n  - - a', /nested collections/, 6],
    ['air: 0\neffort: S\ndeliver: comment\nsetup:\n  - a\n- b', /list item without a key/, 7],
    ['air: 0\neffort: S\ndeliver: comment\n  indented: x', /unexpected indentation/, 5],
    ['air: 0\neffort: S\ndeliver: comment\njust some words', /expected `key: value`/, 5],
    ['air: 0\neffort: S\ndeliver: comment\ncheck: "bad \\q escape"', /unsupported escape/, 5],
  ];
  for (const [fm, re, line] of cases) {
    const r = lint(body(fm));
    assert.equal(r.ok, false, fm);
    assert.ok(
      r.errors.some((e) => re.test(e.message) && e.line === line),
      `${JSON.stringify(fm)} → ${JSON.stringify(r.errors)}`,
    );
  }
});

test('sections: required, non-empty, list, duplicates, fences, unknown', () => {
  oneError(body(MIN, '\n## Task\n\nDo it.\n'), /missing `## Done when` section/);
  oneError(body(MIN, '\n## Task\n\n<!-- nothing -->\n\n## Done when\n\n- x\n'), /`## Task` is empty/);
  oneError(body(MIN, '\n## Task\n\nDo it.\n\n## Done when\n\nWhen it works.\n'), /must be a list/);
  assert.equal(lint(body(MIN, '\n## Task\n\nDo it.\n\n## Done when\n\n1. it works\n')).ok, true);
  assert.equal(lint(body(MIN, '\n## task\n\nDo it.\n\n## DONE WHEN ##\n\n- [ ] it works\n')).ok, true);
  oneError(body(MIN, SECTIONS + '\n## Task\n\nAgain.\n'), /duplicate `## Task` section \(first at line 7\)/);

  // headings inside code fences and HTML comments don't count
  const fenced = body(MIN, '\n## Task\n\n```md\n## Done when\n- no\n```\n\n<!--\n## Done when\n-->\n');
  oneError(fenced, /missing `## Done when`/);
  assert.match(lint(body(MIN, '\n## Task\n\n~~~~\n```\n## Notes\n~~~~\nafter\n\n## Done when\n\n- x\n')).sections.Task!.text, /after$/);

  // ### subheadings stay inside their section
  const sub = lint(body(MIN, '\n## Task\n\n### Part 1\n\nA\n\n## Done when\n\n- x\n'));
  assert.match(sub.sections.Task!.text, /### Part 1/);

  const unknown = lint(body(MIN, SECTIONS + '\n## Background\n\nStuff.\n'));
  assert.equal(unknown.ok, true);
  assert.match(unknown.warnings[0]!.message, /unknown section `## Background`/);
});

test('free text cannot change parsed fields', () => {
  const a = lint(body(MIN)).request;
  const b = lint(body(MIN, SECTIONS + '\n## Notes\n\neffort: XL\ndeliver: pr\n---\nair: 1\n')).request;
  assert.deepEqual(b, a);
});

test('unquoted YAML bools, nulls and numbers are rejected in string fields', () => {
  const ctx = SECTIONS + CTX;
  const repo = (ref: string) => `${MIN}\n${reposOf(['url: https://github.com/o/r.git', `ref: ${ref}`])}`;
  const e = oneError(body(repo('1.10'), ctx), /`repos\[0\].ref`: YAML reads unquoted `1.10` as a number; quote it: "1.10"/);
  assert.equal(e.line, 7);
  assert.equal(lint(body(repo('"1.10"'), ctx)).request!.repos[0]!.ref, '1.10');
  oneError(body(`${MIN}\ncheck: 100`), /`check`: YAML reads unquoted `100` as a number/);
  oneError(body(`${MIN}\nsetup: [true]`), /`setup`: YAML reads unquoted `true` as a boolean/);
  oneError(body(`${MIN}\nsetup:\n  - ~`), /as a null/);
  for (const v of ['null', 'False', '-3', '+1.5', '.5', '1e3', '2.5E-2', '0x1F', '0o17', '.inf', '-.Inf', '.NaN']) {
    assert.ok(codes(body(`${MIN}\ncheck: ${v}`)).includes('type'), v);
  }
  // not numbers in YAML 1.2: strings, accepted as-is
  for (const v of ['v1.10', '1.2.3', 'yes', 'on', '0b101', '1_000', '12:30', 'True!']) {
    assert.equal(lint(body(`${MIN}\ncheck: ${v}`)).request?.check, v, v);
  }
  // enum and duration fields report only the quoting problem, once
  oneError(body(`${MIN}\ntimeout: 90`), /`timeout`: YAML reads unquoted `90` as a number/);
  // integer fields stay unquoted
  assert.equal(lint(body(MIN)).ok, true);
});

test('comments need whitespace before #', () => {
  assert.equal(lint(body(`${MIN}\ncheck: make#target`)).request?.check, 'make#target');
  assert.equal(lint(body(`${MIN}\ncheck: make #target`)).request?.check, 'make');
  assert.equal(lint(body(`${MIN}\ncheck: "make" # c`)).request?.check, 'make');
  oneError(body(`${MIN}\ncheck: "make"#c`), /comments need a space before `#`/);
  oneError(body(`${MIN}\nsetup: [a, b]#c`), /comments need a space before `#`/);
  assert.deepEqual(lint(body(`${MIN}\nsetup: [a, b] # c`)).request?.setup, ['a', 'b']);
  oneError(body(`${MIN}\nsetup:\n  - # nothing`), /empty list item/);
  oneError(body('air: 0 #x\neffort: S\ndeliver: comment'.replace('0 #x', '1#x')), /unquoted integer/);
});

test('URLs are limited to a conservative character set', () => {
  const repo = (url: string) => body(`${MIN}\n${reposOf([`url: ${url}`, 'ref: main', 'path: r'])}`, SECTIONS + CTX);
  assert.equal(lint(repo('https://github.com/o/r.git')).ok, true);
  assert.equal(lint(repo('https://ghe.example.com:8443/team/repo-1.git')).ok, true);
  for (const bad of [
    '"https://github.com/o/r.git; rm -rf ~"',
    '"https://github.com/o/r.git x"',
    'https://github.com/o/$(id).git',
    "\"https://github.com/o/r'.git\"",
    'https://github.com/o/r.git&x',
    'https://github.com/o/r.git#frag',
    'https://user@github.com/o/r.git',
    'https://github.com/o/r`id`.git',
    'http://github.com/o/r.git',
    'ext::sh -c id',
  ]) {
    assert.ok(lint(repo(bad)).errors.some((e) => /`repos\[0\].url` must be an https:\/\/ URL/.test(e.message)), bad);
  }
});

test('deadline accepts RFC 3339 fractional seconds; context.expires is a date', () => {
  const ok = (v: string) => lint(body(`${MIN}\ndeadline: ${v}`));
  assert.equal(ok('2026-12-01T17:30:00.5Z').request?.deadline, '2026-12-01T17:30:00.5Z');
  assert.equal(ok('2026-12-01T17:30:00.123456-05:00').ok, true);
  assert.equal(ok('2026-12-01T17:30.5Z').ok, false);
  assert.equal(ok('2026-12-01T17:30:00.Z').ok, false);
  assert.equal(ok('2026-12-01T17:30:00+25:00').ok, false);

  const ctx = (extra: string) =>
    body(`${MIN}\ncontext:\n  url: https://example.test/a.zip\n  sha256: ${'a'.repeat(64)}\n  bytes: 10${extra}`, SECTIONS + '\n## Context\n\nA zip.\n');
  assert.equal(lint(ctx('')).request?.context?.expires, undefined);
  assert.equal(lint(ctx('\n  expires: 2026-12-31')).request?.context?.expires, '2026-12-31');
  oneError(ctx('\n  expires: 2026-13-01'), /`context.expires` must be a date/);
  oneError(ctx('\n  expires: 2026-12-31T00:00:00Z'), /`context.expires` must be a date/);
});

test('an HTML comment opened mid-line hides headings until it closes', () => {
  const b = body(MIN, '\n## Task\n\nDo it. <!-- draft:\n## Done when\n- hidden\n-->\n\n## Done when\n\n- shown\n');
  const r = lint(b);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.sections['Done when']!.text, '- shown');
  // closed on the same line: no effect
  assert.equal(lint(body(MIN, '\n## Task\n\nA <!-- x --> b\n\n## Done when\n\n- y\n')).ok, true);
  // reopened after a close on the same line
  oneError(body(MIN, '\n## Task\n\nA <!-- x --> b <!--\n## Done when\n- y\n'), /missing `## Done when`/);
});

test('a comment left open on a heading line hides the section body', () => {
  const draft = body(MIN, '\n## Task <!-- draft: fill in later\nRefactor the parser.\n-->\n\n## Done when\n\n- Tests pass\n');
  const e = oneError(draft, /`## Task` is empty/);
  assert.equal(e.line, 7);
  // the raw text still reaches the agent
  assert.match(lint(draft).sections.Task!.text, /Refactor the parser/);
  // text after the comment closes does count
  assert.equal(lint(body(MIN, '\n## Task <!-- draft\nold\n-->\nDo it.\n\n## Done when\n\n- x\n')).ok, true);
  // a Done when list hidden that way isn't a list
  oneError(body(MIN, '\n## Task\n\nDo it.\n\n## Done when <!--\n- x\n-->\n'), /`## Done when` is empty/);
  // an unclosed comment hides the rest of the body
  oneError(body(MIN, '\n## Done when\n\n- x\n\n## Task\n\n<!-- Do it.\n\n'), /`## Task` is empty/);
});

test('flow lists accept one trailing comma', () => {
  const r = lint(body(`${MIN}\nharness: [claude, codex,]`));
  assert.deepEqual(r.request?.harness, ['claude', 'codex']);
  assert.deepEqual(lint(body(`${MIN}\nsetup: [ "a b" , c , ]`)).request?.setup, ['a b', 'c']);
  oneError(body(`${MIN}\nsetup: [,]`), /empty value/);
  oneError(body(`${MIN}\nsetup: [a,,]`), /empty value/);
  oneError(body(`${MIN}\nsetup: [a, b,`), /missing `\]`|empty value/);
});

test('deliver: pr against a commit SHA warns', () => {
  const pr = (ref: string) => body(`air: 0\neffort: S\ndeliver: pr\n${reposOf(['url: https://github.com/o/r.git', `ref: ${ref}`])}`, SECTIONS + CTX);
  const r = lint(pr('0123456789abcdef0123456789abcdef01234567'));
  assert.equal(r.ok, true);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0]!.message, /looks like a commit SHA/);
  assert.equal(r.warnings[0]!.line, 7);
  assert.equal(lint(pr('a'.repeat(64))).warnings.length, 1);
  assert.deepEqual(lint(pr('main')).warnings, []);
  assert.deepEqual(lint(pr('deadbeef')).warnings, []); // could be a branch name
  // not a problem for other deliveries
  const review = body(`${MIN}\n${reposOf(['url: https://github.com/o/r.git', `ref: ${'b'.repeat(40)}`])}`, SECTIONS + CTX);
  assert.deepEqual(lint(review).warnings, []);
});

test('repos: entries, `ref` or `pr`, paths and `deliver: none`', () => {
  const ok = (fm: string, deliver = 'comment') => {
    const r = lint(body(`air: 0\neffort: S\ndeliver: ${deliver}\n${fm}`, SECTIONS + CTX));
    assert.deepEqual(r.errors, [], fm);
    return r.request!;
  };
  const two = ok(reposOf(['url: https://github.com/o/a.git', 'pr: 12'], ['url: https://github.com/o/b', 'ref: v1.2', 'path: deps/b', 'deliver: none']));
  assert.deepEqual(two.repos, [
    { url: 'https://github.com/o/a.git', pr: 12, path: 'a' },
    { url: 'https://github.com/o/b', ref: 'v1.2', path: 'deps/b', deliver: 'none' },
  ]);
  // the dash may sit at the key's own indent, and keys may come in any order
  assert.deepEqual(ok('repos:\n- ref: main\n  url: https://github.com/o/a.git').repos, [{ url: 'https://github.com/o/a.git', ref: 'main', path: 'a' }]);

  const bad = (fm: string, re: RegExp, deliver = 'comment') => oneError(body(`air: 0\neffort: S\ndeliver: ${deliver}\n${fm}`, SECTIONS + CTX), re);
  const A = 'url: https://github.com/o/a.git';
  bad(reposOf([A]), /`repos\[0\]` needs `ref` \(a branch, tag or commit\) or `pr`/);
  bad(reposOf([A, 'ref: main', 'pr: 3']), /`repos\[0\]` has both `ref` and `pr`; use one/);
  bad(reposOf([A, 'pr: "3"']), /`repos\[0\].pr` must be a pull request number, unquoted/);
  bad(reposOf([A, 'pr: 0']), /`repos\[0\].pr` must be a pull request number/);
  bad(reposOf([A, 'pr: abc']), /`repos\[0\].pr` must be a pull request number/);
  bad(reposOf(['ref: main']), /`repos\[0\]` is missing `url`/);
  bad(reposOf([A, 'ref: main', 'deliver: pr']), /`repos\[0\].deliver` can only be `none`/);
  bad('repos: https://github.com/o/a.git', /`repos` must be a list/);
  bad('repos:\n  url: https://github.com/o/a.git\n  ref: main', /`repos` must be a list/);
  bad('repos:\n  - https://github.com/o/a.git', /`repos\[0\]` must be a map/);
  for (const p of ['/abs', '../up', 'a/../b', '.hidden', 'a//b', 'a/', '-rf', 'a b', '"a\\\\b"', '.']) {
    bad(reposOf([A, 'ref: main', `path: ${p}`]), /`repos\[0\].path` must be a relative folder/);
  }
  bad(reposOf(['url: https://git.example.test', 'ref: main']), /no folder name can be made from .*; set `path`/);
  // paths are unique (case-insensitively, for macOS) and don't nest
  bad(reposOf([A, 'ref: main'], ['url: https://github.com/p/a', 'ref: main']), /`repos\[1\]` checks out into `repo\/a`, like `repos\[0\]`/);
  bad(reposOf([A, 'ref: main', 'path: X'], [A, 'ref: dev', 'path: x']), /like `repos\[0\]`/);
  bad(reposOf([A, 'ref: main', 'path: x'], [A, 'ref: dev', 'path: x/y']), /inside each other/);
  // the same repo twice at different refs is fine with distinct paths
  assert.equal(ok(reposOf([A, 'ref: main', 'path: before'], [A, 'pr: 9', 'path: after'])).repos.length, 2);
});

test('deliver: pr needs a repo it can deliver to', () => {
  const pr = (...entries: string[][]) => body(`air: 0\neffort: S\ndeliver: pr\n${reposOf(...entries)}`, SECTIONS + CTX);
  const A = 'url: https://github.com/o/a.git';
  const B = 'url: https://github.com/o/b.git';
  assert.equal(lint(pr([A, 'ref: main'], [B, 'pr: 4', 'deliver: none'])).ok, true);
  oneError(pr([A, 'ref: main', 'deliver: none']), /every entry in `repos` has `deliver: none`/);
  oneError(pr([A, 'pr: 4']), /`repos\[0\]` uses `pr`, and `deliver: pr` can't open a pull request against another one/);
  // an empty list is no repos at all
  oneError(body('air: 0\neffort: S\ndeliver: pr\nrepos: []', SECTIONS + CTX), /`deliver: pr` requires `repos`/);
  // the commit-SHA warning is per repo, at that repo's `ref` line, and skips read-only ones
  const r = lint(pr([A, 'ref: main'], [B, `ref: ${'c'.repeat(40)}`], ['url: https://github.com/o/c.git', `ref: ${'d'.repeat(40)}`, 'deliver: none']));
  assert.equal(r.ok, true);
  assert.deepEqual(r.warnings.map((w) => [w.line, w.message]), [[9, '`deliver: pr` needs `repos[1].ref` to be a branch to open the PR against, but it looks like a commit SHA']]);
});

test('resume: checkpoint branches and the out/ zip', () => {
  const SHA = 'e'.repeat(40);
  const zip = ['  out:', '    url: https://github.com/o/requests/releases/download/air-artifacts/air-7-abcdefgh-out.zip', `    sha256: ${'a'.repeat(64)}`, '    bytes: 1200'];
  const fm = (...resume: string[]) => body([
    'air: 0', 'effort: M', 'deliver: pr',
    reposOf(['url: https://github.com/o/a.git', 'ref: main'], ['url: https://github.com/o/b.git', 'ref: main', 'deliver: none']),
    'resume:', ...resume,
  ].join('\n'), SECTIONS + CTX);
  const r = lint(fm(...zip, '  branches:', '    - repo: a', '      branch: air/7', `      sha: "${SHA}"`));
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.request!.resume, {
    branches: [{ repo: 'a', branch: 'air/7', sha: SHA }],
    out: { url: 'https://github.com/o/requests/releases/download/air-artifacts/air-7-abcdefgh-out.zip', sha256: 'a'.repeat(64), bytes: 1200 },
  });
  // a list at its key's indent, inside a nested map
  assert.deepEqual(lint(fm('  branches:', '  - repo: a', '    branch: air/7', `    sha: ${SHA}`)).request!.resume, { branches: [{ repo: 'a', branch: 'air/7', sha: SHA }] });
  assert.deepEqual(lint(fm(...zip)).request!.resume!.branches, []);

  oneError(fm('  branches: []'), /`resume` needs a `branches` entry, `out` or both/);
  oneError(body(`${MIN}\nresume: yes`), /`resume` must be a map/);
  oneError(fm(...zip, '  from: x'), /unknown key `resume.from`/);
  const branch = (repo: string, b = 'air/7', sha = SHA) => fm('  branches:', `    - repo: ${repo}`, `      branch: ${b}`, `      sha: ${sha}`);
  oneError(branch('c'), /`resume.branches\[0\].repo` must be the `path` of an entry in `repos`; none checks out into `repo\/c`/);
  oneError(branch('b'), /which has `deliver: none`: read-only repos have no checkpoint branch/);
  oneError(branch('a', 'air/7', 'abc123'), /`resume.branches\[0\].sha` must be a full commit SHA/);
  oneError(branch('a', '-x'), /`resume.branches\[0\].branch` is not a valid branch name/);
  oneError(branch('a', 'air/7', '1'.repeat(40)), /YAML reads unquoted `1{40}` as a number/);
  oneError(fm('  branches:', '    - repo: a', '      branch: air/7', `      sha: ${SHA}`, '    - repo: a', '      branch: air/7-2', `      sha: ${SHA}`), /lists `a` twice/);
  oneError(fm(...zip.slice(0, 3)), /`resume.out` is missing `bytes`/);
  oneError(fm(...zip, '    expires: 2026-12-31'), /unknown key `resume.out.expires`/);
});

test('a Task summary over the title limit warns; fitTitle cuts it at a word boundary', () => {
  const long = 'Port the CSV summariser to streaming reads so that multi-gigabyte inputs fit in memory on small laptops';
  const r = lint(body(MIN, `\n## Task\n\n${long}\n\nMore.\n\n## Done when\n\n- x\n`));
  assert.equal(r.ok, true);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0]!.message, /becomes the issue title and is 103 characters, over 80; without --title it is cut to "Port the CSV summariser to streaming reads so that multi-gigabyte inputs fit\.\.\."/);
  assert.equal(taskSummary(r.sections), long);
  const t = fitTitle(long);
  assert.ok(t.length <= TITLE_LIMIT && long.startsWith(t.slice(0, -3)) && long[t.length - 3] === ' ', t);
  assert.equal(fitTitle('x'.repeat(80)), 'x'.repeat(80));
  assert.equal(fitTitle('x'.repeat(81)), `${'x'.repeat(77)}...`, 'one word: a hard cut');
  assert.equal(fitTitle(`${'a'.repeat(77)} bcd`), `${'a'.repeat(77)}...`, 'a space right after the room ends a whole word');
  assert.equal(fitTitle(`${'a'.repeat(70)}, bcdefghijk`), `${'a'.repeat(70)}...`, 'trailing punctuation goes');
  assert.deepEqual(lint(body(MIN, `\n## Task\n\n${'a '.repeat(40)}\n\n## Done when\n\n- x\n`)).warnings, []);
});
