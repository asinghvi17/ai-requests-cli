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
  workspace. The server then interrupts it (C-c, grace, close window) and delivers. A pane that exits 0 also
  delivers; a non-zero exit fails with the last lines of the window.
- Sessions: Claude Code starts with `--session-id <uuid>` chosen by air, so resume is `--resume <uuid>`. Codex's
  id is read from its rollout file (`$CODEX_HOME/sessions/**/rollout-*.jsonl`, `session_meta.cwd` = workspace)
  when stopping. A resume that dies within `resumeCheckMs` falls back to a fresh start told to read `out/` and
  the git log first.
- Restart: live tagged panes are re-adopted (matched by `@air_nonce` recorded in `job.paneNonce`). A `running`
  job whose window is gone at startup is resumed; one whose window disappears while the server runs was closed
  by the volunteer and becomes an operator pause. A setup cut off by a restart is released as failed.
- Quota stop: a running job whose subscription has an all-model window (or the window scoped to its model) at
  100 % is stopped with `pauseReason: quota` and `resumeAfter` = the reset; after that time a fresh reading that
  isn't exhausted and a claim that still holds restart it.
- gh: `createGh` bounds every call (default 2 min, uploads 30 min) with an AbortSignal; `spawnGh` runs gh in its
  own process group and kills the group on timeout. Tests drive the real gh argv layer through `fake-gh.ts`.
- PR delivery never runs git with credentials inside `repo/`: the agent controlled its config and hooks. air
  fetches the agent's HEAD and branches into a fresh bare repo (hooks and fsmonitor off) and pushes from there to
  `repo.url` itself, the URL the permission check covered. The branch is HEAD if it has commits beyond the
  remote's `<ref>`, else the most recently committed local branch that has.
- Failure paths are retryable states: `delivering` (up to 5 attempts, then `air:failed`), `failing` (until the
  release posts), and orphaned `setting-up` workspaces (until released). Labels are repaired from the job state
  each tick. Report text is defused: marker-like lines (after any whitespace) and `air-artifact` fences, and an
  open code fence is closed before the footer or the asset block.
- Not here: `air sweep` (daily, per spec §7) belongs to the sweep work; the loop has no hook for it yet.
