// What the serve loop and the job commands (`air run/stop/start/...`) share: the requests repo, tmux,
// config, usage and a log. Built from the config by `serveContext`; tests build their own.
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { configPath, type Config } from '../config.ts';
import { defaultHost } from '../claim/claim.ts';
import { createTrust, type Trust } from '../claim/trust.ts';
import { createGh } from '../gh/gh.ts';
import { requestsRepo, type RequestsRepo } from '../gh/issues.ts';
import { releases, type Releases } from '../gh/releases.ts';
import type { MatchConfig } from '../match/match.ts';
import { createTmux, type Tmux } from '../tmux/tmux.ts';
import { configFile, loadConfig as loadSubscriptions, readAll, stateDir as usageStateDir } from '../usage/index.ts';
import type { ManualConfig, Subscription, SubscriptionConfig } from '../usage/types.ts';
import type { Download } from '../workspace/context.ts';
import { serveGitHub, type ServeGitHub } from './github.ts';
import { loginsOf } from './preflight.ts';

export interface ServeContext {
  gh: RequestsRepo;
  api: ServeGitHub;
  tmux: Tmux;
  config: Config;
  root: string;
  host: string;
  /** The requests repo's GitHub host (a `deliver: pr` repo must be on it). */
  ghHost: string;
  /** The server's environment: git (clone, push) runs with it, so it uses the volunteer's credentials. */
  env: NodeJS.ProcessEnv;
  /** Where the server state file and log live. */
  stateDir: string;
  trust: Trust;
  /** Usage readings of every local subscription (cached by the usage module; `refresh` forces a read). */
  usage(opts?: { refresh?: boolean }): Promise<Subscription[]>;
  /** Environment that selects a subscription's login for its agent (CLAUDE_CONFIG_DIR / CODEX_HOME). */
  agentEnv(subscription: string): Record<string, string>;
  /** A manual subscription's budget (subscriptions.json), which a job is charged what it spent; undefined for others. */
  manual?(subscription: string): ManualConfig | undefined;
  log(message: string): void;
  /** The file `log` appends to; tmux window 0 follows it. */
  logFile?: string;
  now(): Date;
  /** After the interrupt keys, how long an agent gets to exit before its window is closed. */
  stopGraceMs: number;
  /** After `--resume`, how long the agent must stay up for the resume to count as working. */
  resumeCheckMs: number;
  /** After a fresh start, how long to wait for the agent's screen to be ready for its task (`sendTask`). */
  agentReadyMs: number;
  claimWaitMs?: number;
  setupTimeoutMs?: number;
  download?: Download;
  codexHome?: string;
  /** air's config file, named in fixes the server logs. */
  configFile?: string;
  /** Subscription name -> why new work isn't run on it (the startup preflight failed for its agent). */
  refused?: Record<string, string>;
  /** Release assets for the daily sweep; default: the requests repo through gh. */
  releases?: Releases;
}

export const SERVE_LOG = 'serve.log';

export function matchConfig(config: Config, refused?: Record<string, string>): MatchConfig {
  return { subscriptions: config.subscriptions, models: config.models, maxJobs: config.max_jobs, ...(refused ? { refused } : {}) };
}

/** A logger that appends timestamped lines to `file` (shown in tmux window 0) and echoes them. */
export function fileLogger(file: string, echo?: (line: string) => void, now = () => new Date()): (message: string) => void {
  mkdirSync(dirname(file), { recursive: true });
  return (message) => {
    const line = `[${now().toISOString()}] ${message}`;
    try {
      appendFileSync(file, `${line}\n`);
    } catch {
      // the log is best effort; never let it stop the loop
    }
    echo?.(line);
  };
}

export function serveContext(config: Config, repo: string, opts: { echo?: (line: string) => void; env?: NodeJS.ProcessEnv } = {}): ServeContext {
  const env = opts.env ?? process.env;
  const gh = createGh();
  const issues = requestsRepo(repo, gh);
  const dir = usageStateDir();
  let subs: SubscriptionConfig[] | undefined;
  const subscriptions = () => (subs ??= loadSubscriptions(configFile()));
  return {
    gh: issues,
    api: serveGitHub(repo, gh),
    releases: releases(repo, gh),
    tmux: createTmux({ repo }),
    config,
    configFile: configPath(),
    root: config.workspace_root,
    host: defaultHost(),
    ghHost: env.GH_HOST || 'github.com',
    env,
    stateDir: dir,
    trust: createTrust(issues),
    usage: (o = {}) => readAll(subscriptions(), { stateDir: dir, refresh: o.refresh }),
    agentEnv(name): Record<string, string> {
      const [login] = loginsOf(subscriptions().filter((c) => c.name === name), config);
      if (login?.configDir) return { CLAUDE_CONFIG_DIR: login.configDir };
      if (login?.codexHome) return { CODEX_HOME: login.codexHome };
      return {};
    },
    manual(name) {
      const s = subscriptions().find((c) => c.name === name);
      return s?.harness === 'manual' ? s : undefined;
    },
    log: fileLogger(join(dir, SERVE_LOG), opts.echo),
    logFile: join(dir, SERVE_LOG),
    now: () => new Date(),
    stopGraceMs: 10_000,
    resumeCheckMs: 15_000,
    agentReadyMs: 60_000,
  };
}
