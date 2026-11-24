# Notes: what came from the factory's heads.ts

Adapted (not imported) from factory `packages/coordinator-mcp/src/heads.ts`:
- Private server per tool (`-L air` here, `-S <socket>` there); exact `=session` targets, never tmux's fuzzy fallback.
- Ownership by a fresh per-launch nonce. heads.ts embeds it in the immutable `pane_start_command`; we use pane user
  options (`@air_repo`, `@air_job`, `@air_nonce`) instead, seen only by the client for that `@air_repo`, so a human split, a volunteer window named `#42`, or a recycled id is never adopted.
- Destructive writes go through `if-shell -F -t <pane> '#{==:#{@air_nonce},N}' '...'`, so the ownership check runs in the
  same tmux command queue as the write; `display-message -p` in the branch reports whether it ran.
- `new-window -d -P -F '#{window_id} #{pane_id}'` to learn the created ids; `pane_dead` checks before acting.
- "no server running" / "error connecting" means no jobs, not an error.
- `env -u ...` launch wrapper became `env K=V ... argv`: the job inherits the caller's whole environment, with the
  caller's extras on top (TMUX and TMUX_PANE are tmux's own for the pane; TERM is tmux's `default-terminal`).
New here: one tmux invocation creates the window on the job's launcher, tags it (nonce first, then
`@air_state=starting`), sets remain-on-exit and marks it `running`. tmux runs a client's command list to the end before
its event loop sees any pane output or exit, so no one lists the window untagged, and a job that exits at once keeps its
window and status. Chained commands default to the session's *current* pane, so each targets the new window by an exact
unique temp name (`=air:=air-new-<nonce>`). Leftover `starting` panes are killed.
Caller words (argv, env values, cwd) never go on a tmux command line: a word equal to or ending in `;` is a tmux
separator, so `x;` `run-shell ...` would run tmux commands. They go into a private self-deleting sh launcher
(`launcher.ts`); tmux runs only `/bin/sh <tmpdir>/air-launch-*/run.sh`.

Env scope (decided 2026-11-17): the agent runs as the volunteer would run it, so it gets their whole environment,
credentials included. The launcher script therefore holds every variable's value: it lives in a 0700 directory under
tmpdir and removes itself when it runs. Only the tmux client and server get an allowlisted environment (`clientEnv`).
A filesystem sandbox is out of scope by design.

Pane death (fixed after CI flakes under bun on ubuntu): tmux sets `pane_dead` when the pty closes, but `pane_dead_status`
and `pane_dead_signal` only once it has reaped the child (`PANE_STATUSREADY`). A pane in between is reported as alive, so
`dead` always comes with a status or a signal. And `kill-server` returns before the server is gone: a client that reaches
the dying server gets "server exited unexpectedly", which means no jobs, and `ensureSession` retries until it can start a
fresh server.

Locale (the live Mac smoke run): a tmux client with no `UTF-8` in LC_ALL/LC_CTYPE/LANG (and no TMUX) is not UTF-8, and
tmux sanitises its command output: each tab in a `-F` format comes back as `_`. Every client call passes `-u`, and
`parsePanes` throws on a row without separators instead of reading it as "no panes".

## Supported tmux: 3.0 and newer

`air serve`, `air run` and `air start` refuse older versions (`MIN_TMUX`): pane user options (`set-option -p`, our job tags)
came in 3.0. Checked with the tmux and serve e2e suites on source builds of 3.0a, 3.1c, 3.2a, 3.3a, 3.4 (also built
`--enable-utempter`, as Ubuntu and Debian ship it), 3.6 (also with utempter) and 3.8. 2.9a fails, as expected.

Exit status (Ubuntu 24.04 CI, tmux 3.4): tmux before 3.6 built with utempter can lose a pane's SIGCHLD. In libutempter,
`utempter_remove_record` sets SIGCHLD to SIG_DFL while it forks and waits for its helper, so a pane child exiting in that
window is never reaped: tmux shows it `pane_dead` with no `pane_dead_status`, for good (tmux issue 4559, fixed in 3.6 by
fa5f3cef, which re-raises SIGCHLD). So job panes run a status launcher (`launcher.ts`): `/bin/sh` stays as the pane's
process (session and process group leader), runs the agent in the foreground of its group (C-c and the terminal reach the
agent as before), records the agent's pid in `<launcher dir>/pid` and its exit status in `<launcher dir>/status`. The shell
holds the pty until it exits, so a pane is never `pane_dead` before the file exists. `parsePanes` uses tmux's status when
it has one, else the file; `Job.pid` is the agent (from the pid file), `Job.panePid` the launcher shell.

Signals: the launcher catches INT, QUIT and TERM (to outlive the agent and record its status; caught signals are reset in
the child). An agent killed by signal N therefore reports as sh does, status 128 + N, and `exitSignal` stays null (it is
only set if tmux saw the launcher itself die of a signal). Failure comments read "killed by signal N (status 128 + N)";
an agent that exits 128 + N on purpose reads the same. `pane_dead_signal` is a number on Linux but a name (`int`) where tmux
has `sys_signame` (macOS, BSDs); both parse.

No orphans: closing a window (`kill-window`, a dying tmux server) hangs up the pty, and the kernel then signals only the
session leader, never the rest of the group. Two layers make sure nothing of a job outlives it:
- `stopJob`/`killOwned` check the nonce, send the job's process group (`-panePid`) TERM, wait for the agent to exit (at most
  `KILL_GRACE_MS`), send KILL, and only then kill the window.
- The launcher does not catch HUP, so a raw hangup kills it. Its reaper, a background subshell in the same group, holds the
  read end of a FIFO whose only writer is the launcher shell. When that shell is gone (an exiting process closes its fds
  even as a zombie tmux never reaps, so `kill -0` would not do), the reaper sends the group TERM, and KILL after
  `REAP_GRACE_SECONDS`. It runs after every launcher exit, so it also ends background processes an agent left behind.
A process that makes its own process group or session escapes both; agents don't, today.

The launcher dir lives until the window is killed (`killOwned`). Unit tests with made-up pane pids pass a fake `kill`, so
they never signal real process groups.

## No placeholder, no `respawn-pane` (macOS CI flake, 2026-11-24)

Job windows used to start on a `sleep 2147483647` placeholder that the same command queue replaced with `respawn-pane -k`.
On GitHub's macOS runners CI runs failed now and then (2 of 7 pull_request runs) with `respawn pane failed: fork failed: Device not configured`.
Two separate macOS problems, both measured there by running the chain in a loop (`kern.tty.ptmx_max` is 511):
- The respawn itself: with a few hundred windows open, about 1 respawn in 300 failed with that error, with any
  placeholder (`sleep`, `cat`, one that ignores HUP and holds its pty a few seconds), far below the pty limit.
  `new-window` straight on the command never failed (2,100 starts). So the window now starts on the launcher.
- The placeholder leaked: closing a pty hangs up only its session leader, and a placeholder that had not yet made the
  pty its controlling terminal (tmux respawned microseconds after the fork) got no signal, so it lived on, orphaned,
  holding its pty: 5 to 30% of starts, more under load; 37 left by one CI run of the test suites.
The tmux suites now check in teardown that no process with the test server's TMUX in its environment outlives the
server (`testing/leaks.ts`).
