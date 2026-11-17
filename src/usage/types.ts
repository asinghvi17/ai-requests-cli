// The normalised shape every reader returns: one Subscription per local login, one Window per quota meter.

export type WindowKind = 'five_hour' | 'weekly' | 'monthly' | 'daily' | (string & {});

export interface Window {
  /** Stable machine name: `five_hour`, `seven_day`, `seven_day_fable`, `monthly`, `90_min`... */
  name: string;
  kind: WindowKind;
  /** Percent of the window used, 0-100 (may exceed 100); null when unknown. */
  usedPct: number | null;
  /** Manual budgets: US dollars (at API prices) left of the budget, and the whole budget. */
  usdLeft?: number;
  usdBudget?: number;
  /** ISO time the window resets; null when the source gives none. */
  resetsAt: string | null;
  /** A meter that only counts one model (Claude's `weekly_scoped`), e.g. `Fable`. */
  scope?: string;
}

export interface Subscription {
  name: string;
  harness: 'claude' | 'codex' | 'manual' | (string & {});
  windows: Window[];
  /** When the windows were read; null if never read successfully. */
  readAt: string | null;
  /** Older than STALE_MS (or never read): every usedPct is null and usdLeft absent. */
  stale: boolean;
  /** The source answered but its primary window (Claude weekly, Codex primary) was missing, e.g. renamed:
   *  every usedPct is null, as for stale. */
  incomplete?: boolean;
  /** Why there is no (fresh) reading, when there isn't one. */
  note?: string;
}

/** What a CLI reader returns before the cache stamps it. */
export interface Reading { windows: Window[]; note?: string; incomplete?: boolean }

/** One entry of the volunteer's subscriptions config. */
export type SubscriptionConfig =
  | { name: string; harness: 'claude'; bin?: string; configDir?: string }
  | { name: string; harness: 'codex'; bin?: string; codexHome?: string }
  | ManualConfig;

export interface ManualConfig {
  name: string;
  harness: 'manual';
  /** The login of the agent it runs, by the harness config.toml gives it: Claude Code's CLAUDE_CONFIG_DIR. */
  configDir?: string;
  /** Likewise Codex's CODEX_HOME. */
  codexHome?: string;
  /** weekly: `day` 0-6 (Sunday 0); monthly: `day` 1-28. `hour` 0-23, default 0. Local time unless `utc`. */
  reset: { every: 'weekly' | 'monthly'; day: number; hour?: number; utc?: boolean };
  /** US dollars at API prices (src/usage/prices.ts) per period; spend is recorded in the same dollars. */
  budget: { usd: number };
}
