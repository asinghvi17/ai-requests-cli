// The normalised shape every reader returns: one Subscription per local login, one Window per quota meter.

export type WindowKind = 'five_hour' | 'weekly' | 'monthly' | 'daily' | (string & {});

export interface Window {
  /** Stable machine name: `five_hour`, `seven_day`, `seven_day_fable`, `monthly`, `90_min`... */
  name: string;
  kind: WindowKind;
  /** Percent of the window used, 0-100 (may exceed 100); null when unknown. */
  usedPct: number | null;
  /** Manual budgets in tokens only. */
  tokensLeft?: number;
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
  /** Older than STALE_MS (or never read): callers must treat every window as unknown. */
  stale: boolean;
  /** Why there is no (fresh) reading, when there isn't one. */
  note?: string;
}

/** What a CLI reader returns before the cache stamps it. */
export interface Reading { windows: Window[]; note?: string }

/** One entry of the volunteer's subscriptions config. */
export type SubscriptionConfig =
  | { name: string; harness: 'claude'; bin?: string; configDir?: string }
  | { name: string; harness: 'codex'; bin?: string; codexHome?: string }
  | ManualConfig;

export interface ManualConfig {
  name: string;
  harness: 'manual';
  /** weekly: `day` 0-6 (Sunday 0); monthly: `day` 1-28. `hour` 0-23, default 0. Local time unless `utc`. */
  reset: { every: 'weekly' | 'monthly'; day: number; hour?: number; utc?: boolean };
  /** Exactly one of tokens or percent. Spend is recorded in the same unit. */
  budget: { tokens: number } | { percent: number };
}
