# Notes: `air serve` and the job lifecycle

- The loop (`server.ts`) is plain code. Each tick it reads usage (the usage module's 5-minute cache) and the tmux
  job list, then handles every workspace this machine holds: cancel or closed issue, agent finished, pane dead,
  `timeout`, quota stop, quota restart, 48 h pause, restart resume. Then, unless `air pause` is set, it lists open
  `ai-request` issues, skips held/assigned/cancelled/past-deadline ones, lints, `choose()`s and claims while
  `canTakeMore`. Claim waits, setups, starts and deliveries run as per-issue promises (`inflight`), so a slow
  setup never blocks the tick, and an error in one costs a log line. `tick()` never throws.
- State: each workspace's `state.json` gets a `job` record (status, harness, subscription, model, session id,
  pane nonce, agent time, pause reason, usage before, delivery progress). The server scans workspaces every tick
  instead of keeping its own list, so a restarted server and the `air run/stop/start` commands all see the same
  thing. `<state dir>/serve.json` only holds the `air pause` flag; `serve.lock` keeps one server per state dir.
- Done: an interactive agent doesn't exit when it finishes, so AIR_TASK.md asks it to create `AIR_DONE` in the
  workspace. The server then interrupts it (C-c, grace, close window) and delivers. Only `AIR_DONE` delivers.
- Stopping early (spec §11), all in `watch`: a pane that exits without `AIR_DONE` (any status) is resumed once
  (`pauseReason: exit`, `exitResumes`), with an instruction to read `out/PROGRESS.md` and the git log; a second
  exit stops it early. So do a quota window resetting more than 24 h away, a quota pause past `QUOTA_WAIT_MS`
  (24 h; not before an hour after the reset it waited on), more than twice `expectedCost` used of the primary
  window (`overEffort`, only with comparable readings) and `timeout`. `partialJob` sets `checkpointing`, closes
  the window, pushes `air/<N>[-k]` for `deliver: pr` (`pushWork`, shared with PR delivery) and uploads `out/` as
  `air-<N>-<nonce>-out.zip`, then posts the `partial` release with `resume`. A timeout whose checkpoint keeps
  nothing fails instead. Quota pauses are never released by the 48 h rule.
- Every final comment (done, failed, partial, released) ends with an `air-result` block; `usage` is in it once
  the agent started (`usageReport`). Release comments get theirs from `release()` in src/claim.
- Sessions: Claude Code starts with `--session-id <uuid>` chosen by air, so resume is `--resume <uuid>`. Codex's
  id is read from its rollout file (`$CODEX_HOME/sessions/**/rollout-*.jsonl`, `session_meta.cwd` = workspace)
  when stopping. A resume that dies within `resumeCheckMs` falls back to a fresh start told to read `out/` and
  the git log first.
- Restart: live tagged panes are re-adopted (matched by `@air_nonce` recorded in `job.paneNonce`). A `running`
  job whose window is gone at startup is resumed; one whose window disappears while the server runs was closed
  by the volunteer and becomes an operator pause. A setup cut off by a restart is released as failed.
- Quota stop: a running job whose subscription has an all-model window (or the window scoped to its model) at
  100 % is stopped with `pauseReason: quota` and `resumeAfter` = the reset (if that is within 24 h); after that
  time a fresh reading that isn't exhausted and a claim that still holds restart it.
- Repos (src/claim/repos.ts): before posting a claim, `claim()` checks push permissions (author and this server)
  for every repo that gets a PR and resolves every entry to a SHA; `state.repos` records them and setup clones each
  into `repo/<path>/` at its SHA. A `repos` or `cannot-push` refusal is retried every poll (logged once per reason).
- Resume intake is in setup (src/workspace/setup.ts): `resume.branches` are fetched by SHA and checked out on
  their branch in `repo/<path>`, and `resume.out` is downloaded and checked like a context zip into `out/`. Release
  assets are downloaded through gh (`releaseDownload`), so private requests repos work.
- gh: `createGh` bounds every call (default 2 min, uploads 30 min) with an AbortSignal; `spawnGh` runs gh in its
  own process group and kills the group on timeout. Tests drive the real gh argv layer through `fake-gh.ts`.
- PR delivery never runs git with credentials inside `repo/<path>`: the agent controlled its config and hooks.
  For each repo it delivers to, air fetches the agent's HEAD and branches into a fresh bare repo (hooks and
  fsmonitor off) and pushes from there to the entry's url itself, the URL the permission checks covered. The
  branch is HEAD if it has commits beyond the SHA recorded at claim time, else the most recently committed local
  branch that has. One PR per repo with commits; once all are open, each body gets its siblings.
- Claim guard: every tick re-reads the claim of each held job before acting, and `moveLabel` / `startAgent` /
  `finishJob` check it again (`ensureHeld`). A lost claim makes the workspace `lost` and stops our agent; we
  never relabel, comment on or resume an issue another server holds. Release paths rely on `release()`'s own
  holder check. Uploaded assets are recorded in `job.delivery.asset`, so a retry reuses them.
- Failure paths are retryable states: `delivering` (up to 5 attempts, then `air:failed`), `failing` (until the
  release posts), and orphaned `setting-up` workspaces (until released). Labels are repaired from the job state
  each tick. Report text is defused: marker-like lines (after any whitespace), including `air-result` lines,
  and an open code fence is closed before the footer and the result block.
- Not here: `air sweep` (daily, per spec §7) belongs to the sweep work; the loop has no hook for it yet.
