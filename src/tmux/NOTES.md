# Notes: what came from the factory's heads.ts

Adapted (not imported) from factory `packages/coordinator-mcp/src/heads.ts`:
- Private server per tool (`-L air` here, `-S <socket>` there); exact `=session` targets, never tmux's fuzzy fallback.
- Ownership by a fresh per-launch nonce. heads.ts embeds it in the immutable `pane_start_command`; we use pane user
  options (`@air_job`, `@air_nonce`) instead, so a human split, a volunteer window named `#42`, or a recycled id is never adopted.
- Destructive writes go through `if-shell -F -t <pane> '#{==:#{@air_nonce},N}' '...'`, so the ownership check runs in the
  same tmux command queue as the write; `display-message -p` in the branch reports whether it ran.
- `new-window -d -P -F '#{window_id} #{pane_id}'` to learn the created ids; `pane_dead` checks before acting.
- "no server running" / "error connecting" means no jobs, not an error.
- `env -u ...` launch wrapper became `env -i` with an allowlist (heads.ts strips a few vars; we start from nothing).
New here: one tmux invocation creates the window on a placeholder, tags it `@air_state=starting`, sets remain-on-exit,
`respawn-pane -k`s the agent and marks it `running`. Chained commands default to the session's *current* pane, so each
targets the new window by an exact unique temp name (`=air:=air-new-<nonce>`). Leftover `starting` panes are killed.

Env scope: the scrub covers the inherited environment only (`env -i` + allowlist; `BASH_ENV`/`ENV` are denied). HOME
is the volunteer's real one on purpose (the agent needs their login and config), so dotfiles their shell sources and
files readable under HOME are the volunteer's responsibility. A filesystem sandbox is out of scope by design.
