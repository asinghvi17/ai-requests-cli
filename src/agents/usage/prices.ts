// API prices, in US dollars per million tokens, for pricing what a job's agent spent (spent.ts). The one table
// air uses: a job's cost, a manual budget's spend and a request's effort are all in these dollars.
//
// Sources, read 2026-11-17:
// - CLAUDE: https://platform.claude.com/docs/en/about-claude/pricing, "Model pricing" (base input, 5m and 1h
//   cache writes, cache hits, output), "Long context pricing" (Claude Haiku 5.5 above 100,000 prompt tokens),
//   "Fast mode pricing" and "Data residency pricing" (`inference_geo: "us"`: 1.1x).
// - OPENAI: https://developers.openai.com/api/docs/pricing, standard tier (input, cached input, output) and its
//   long-context rows (above 272K input tokens), "Flagship models" > "Standard". OpenAI bills no cache writes.
//   The models are those `codex debug models` lists (Codex 0.164.0). gpt-5.6-sol is left out: its listed price
//   is promotional until 2026-11-30. Codex's fast mode (OpenAI's "Fast" tier, formerly priority) costs twice
//   these rates; rollouts don't say which tier a call used, so a fast-mode job is priced at the standard rates.
// A model that isn't here is not priced: a job's calls on it are not charged, and serve logs a warning naming it.

export interface Rates {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
}

export interface ModelPrice extends Rates {
  /** Higher rates for a request whose prompt (all input tokens, cache reads and writes included) is over `tokens`. */
  over?: { tokens: number; rates: Rates };
  /** Fast mode multiplies every rate by this (Claude `usage.speed: "fast"`). */
  fast?: number;
  source: 'CLAUDE' | 'OPENAI';
}

const claude = (input: number, w5: number, w1: number, read: number, output: number, extra: Partial<ModelPrice> = {}): ModelPrice =>
  ({ input, cacheWrite5m: w5, cacheWrite1h: w1, cacheRead: read, output, source: 'CLAUDE', ...extra });
const openai = (input: number, cached: number, output: number, over?: [number, number, number]): ModelPrice => ({
  input, cacheWrite5m: input, cacheWrite1h: input, cacheRead: cached, output, source: 'OPENAI',
  ...(over ? { over: { tokens: 272_000, rates: { input: over[0], cacheWrite5m: over[0], cacheWrite1h: over[0], cacheRead: over[1], output: over[2] } } } : {}),
});

export const PRICES: Readonly<Record<string, ModelPrice>> = {
  'claude-fable-5-1': claude(10, 12.5, 20, 0.25, 50),
  'claude-mythos-5-1': claude(10, 12.5, 20, 0.25, 50),
  'claude-fable-5': claude(10, 12.5, 20, 1, 50),
  'claude-mythos-5': claude(10, 12.5, 20, 1, 50),
  'claude-opus-5-5': claude(4, 5, 8, 0.2, 20, { fast: 2 }),
  'claude-opus-5': claude(5, 6.25, 10, 0.5, 25, { fast: 2 }),
  'claude-opus-4-8': claude(5, 6.25, 10, 0.5, 25, { fast: 2 }),
  'claude-opus-4-7': claude(5, 6.25, 10, 0.5, 25),
  'claude-opus-4-6': claude(5, 6.25, 10, 0.5, 25),
  'claude-opus-4-5': claude(5, 6.25, 10, 0.5, 25),
  'claude-sonnet-5-5': claude(2, 2.5, 4, 0.1, 10),
  'claude-sonnet-5': claude(2, 2.5, 4, 0.2, 10),
  'claude-sonnet-4-6': claude(3, 3.75, 6, 0.3, 15),
  'claude-sonnet-4-5': claude(3, 3.75, 6, 0.3, 15),
  'claude-haiku-5-5': claude(0.1, 0.125, 0.2, 0.01, 0.5, { over: { tokens: 100_000, rates: { input: 0.5, cacheWrite5m: 0.625, cacheWrite1h: 1, cacheRead: 0.05, output: 2.5 } } }),
  'claude-haiku-4-5': claude(1, 1.25, 2, 0.1, 5),
  'gpt-6-astra': openai(10, 1, 50, [20, 2, 75]),
  'gpt-6.1-sol': openai(2, 0.1, 10, [4, 0.2, 15]),
  'gpt-6-sol': openai(2, 0.2, 10, [4, 0.4, 15]),
  'gpt-6-luna': openai(0.1, 0.01, 0.5, [0.2, 0.02, 0.75]),
  'gpt-5.6-terra': openai(2, 0.2, 12, [4, 0.4, 18]),
  'gpt-5.6-luna': openai(0.2, 0.02, 1.2, [0.4, 0.04, 1.8]),
  'gpt-5.5': openai(5, 0.5, 30, [10, 1, 45]),
  'gpt-5.4': openai(2.5, 0.25, 15, [5, 0.5, 22.5]),
  'gpt-5.4-mini': openai(0.75, 0.075, 4.5),
  'gpt-5.4-nano': openai(0.2, 0.02, 1.25),
  'gpt-5.3-codex': openai(1.75, 0.175, 14),
  'gpt-5.2': openai(1.75, 0.175, 14),
  'gpt-5.1': openai(1.25, 0.125, 10),
  'gpt-5': openai(1.25, 0.125, 10),
  'gpt-5-mini': openai(0.25, 0.025, 2),
  'gpt-5-nano': openai(0.05, 0.005, 0.4),
};

/** Dollars as air prints them: `$12.35`. */
export const usd = (n: number): string => `$${n.toFixed(2)}`;

/** One API call's tokens. `input` excludes cache reads and writes. */
export interface CallTokens {
  input: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  output: number;
}

/** The table's entry for `model`, ignoring a date suffix (`claude-haiku-4-5-20251001`). */
export function priceOf(model: string): ModelPrice | undefined {
  const id = model.replace(/-\d{8}$/, '');
  return Object.hasOwn(PRICES, id) ? PRICES[id] : undefined;
}

/** What a call cost at API prices, in USD; undefined for a model (or fast mode) the table doesn't price. */
export function callCost(model: string, t: CallTokens, opts: { fast?: boolean; us?: boolean; prompt?: number } = {}): number | undefined {
  const p = priceOf(model);
  if (!p) return undefined;
  if (opts.fast && !p.fast) return undefined;
  // The request's prompt size picks long-context rates; `prompt` gives it when `t` sums several requests.
  const prompt = opts.prompt ?? t.input + t.cacheWrite5m + t.cacheWrite1h + t.cacheRead;
  const r = p.over && prompt > p.over.tokens ? p.over.rates : p;
  const cost = (t.input * r.input + t.cacheWrite5m * r.cacheWrite5m + t.cacheWrite1h * r.cacheWrite1h + t.cacheRead * r.cacheRead + t.output * r.output) / 1e6;
  return cost * (opts.fast ? p.fast! : 1) * (opts.us ? 1.1 : 1);
}
