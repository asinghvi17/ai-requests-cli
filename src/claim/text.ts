// Helpers for comment text. Anything not written by air itself (lint messages that quote the body, setup
// output) goes inside a fenced block whose fence is longer than any backtick run in it, so it renders
// as code, mentions nobody, and can never carry a marker that counts (markers inside fences don't).

export function fenced(text: string, info = ''): string {
  // markers.ts and lint treat CR as a line break too, so normalise before measuring.
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}${info}\n${text.replace(/\r\n?/g, '\n').replace(/\n+$/, '')}\n${fence}`;
}

/** The last `maxLines` lines of `text`, at most `maxChars` characters, marking what was cut. */
export function tail(text: string, maxLines = 60, maxChars = 6000): string {
  let lines = text.replace(/\n+$/, '').split('\n');
  let cut = false;
  if (lines.length > maxLines) {
    lines = lines.slice(-maxLines);
    cut = true;
  }
  let out = lines.join('\n');
  if (out.length > maxChars) {
    out = out.slice(-maxChars);
    const nl = out.indexOf('\n');
    if (nl >= 0 && nl < out.length - 1) out = out.slice(nl + 1);
    cut = true;
  }
  return cut ? `[... earlier output cut ...]\n${out}` : out;
}

/** Inline code on one line: every control character becomes a space, so no line break (CR included) survives. */
export function code(s: string): string {
  const longest = Math.max(0, ...[...s.matchAll(/`+/g)].map((m) => m[0].length));
  const tick = '`'.repeat(longest + 1);
  const pad = s.startsWith('`') || s.endsWith('`') ? ' ' : '';
  return `${tick}${pad}${s.replace(/[\x00-\x1f\x7f\u2028\u2029]/g, ' ')}${pad}${tick}`;
}
