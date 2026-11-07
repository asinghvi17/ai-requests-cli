import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { lint } from './lint.ts';
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

test('every example in spec/examples lints clean', () => {
  const files = readdirSync(new URL('spec/examples/', root)).filter((f) => f.endsWith('.md'));
  assert.equal(files.length, 4);
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
    repo: { url: 'https://github.com/acme-analytics/TimeSeriesKit.jl.git', ref: 'main' },
    setup: ["julia --project=. -e 'using Pkg; Pkg.instantiate()'"],
    check: "julia --project=. -e 'using TimeSeriesKit'",
    deliver: 'pr',
    deadline: '2026-11-20',
    timeoutMinutes: 180,
  });
  const research = lint(read('spec/examples/research-summary.md')).request!;
  assert.equal(research.context?.bytes, 1843302);
  assert.equal(research.timeoutMinutes, 90);
  assert.equal(lint(read('spec/examples/data-cleanup.md')).request!.check, '.venv/bin/python -c "import pandas, pyarrow"');
  assert.equal(lint(read('spec/examples/code-review.md')).request!.repo!.ref, 'feature/proration-v2');
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
  assert.deepEqual(r.request, { air: 0, effort: 'S', harness: ['any'], model: 'medium', setup: [], deliver: 'comment', timeoutMinutes: 240 });
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

test('deliver: pr without repo', () => {
  const e = oneError(body('air: 0\neffort: S\ndeliver: pr'), /`deliver: pr` requires `repo`/);
  assert.equal(e.code, 'missing');
  oneError(body('air: 0\neffort: S\ndeliver: email'), /`deliver` must be one of comment, pr, artifact/);
});

test('unknown keys are errors, with suggestions', () => {
  const e = oneError(body(MIN + '\ntimout: 2h'), /unknown key `timout` \(did you mean `timeout`\?\)/);
  assert.equal(e.code, 'unknown-key');
  assert.equal(e.line, 5);
  oneError(body(MIN + '\nrepo:\n  url: https://x.test/r.git\n  ref: main\n  branch: dev'), /unknown key `repo.branch`/);
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
  const withRepo = (ref: string) => `${MIN}\nrepo:\n  url: https://github.com/o/r.git\n  ref: ${ref}`;
  oneError(body(withRepo('main')), /missing `## Context` section \(required when `context` or `repo` is set\)/);
  const ctx = SECTIONS + '\n## Context\n\nThe repo.\n';
  assert.equal(lint(body(withRepo('feature/x-1'), ctx)).ok, true);
  assert.equal(lint(body(withRepo('0123abc'), ctx)).ok, true);
  oneError(body(withRepo('-rf'), ctx), /not a valid branch/);
  oneError(body(withRepo('a..b'), ctx), /not a valid branch/);
  oneError(body(withRepo('main'), SECTIONS + '\n## Context\n\n<!-- todo -->\n'), /`## Context` is empty/);
  // an empty Context section is fine when nothing requires it
  assert.equal(lint(body(MIN, SECTIONS + '\n## Context\n')).ok, true);
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
    ['air: 0\neffort: S\ndeliver: comment\nrepo:\n  url: https://x.test/r\n    ref: main', /one level/, 7],
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
