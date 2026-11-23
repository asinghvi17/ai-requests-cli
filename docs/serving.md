# Serving

`air serve` is the one command a volunteer runs. This page covers what it does and the commands for
handling single jobs.

## The first run

On a terminal, `air serve` sets up whatever is missing, then serves:

1. **GitHub CLI.** If `gh` isn't logged in, it offers to run `gh auth login`.
2. **Config.** With no `~/.config/air/config.toml`, it asks for the requests repo. It looks for Claude Code
   and Codex on your PATH and reads each one's subscription usage. It writes one `[subscriptions.NAME]` per
   login it can read. See [config.md](config.md).
3. **Agent checks.** Each agent's binary must run, and its launch flags must keep it unattended. Claude Code
   must have finished its first-run setup and must trust `workspace_root`.
4. **Folder trust.** If Claude Code doesn't trust `workspace_root` yet, air asks
   "Trust ~/air for Claude Code? [y/N]". On yes, it writes that one entry to Claude Code's `.claude.json`,
   as answering "Yes, I trust this folder" would. It never writes trust without asking.
5. **tmux.** Outside tmux, air starts itself in window `serve` of its own tmux session and attaches you to it.

Later runs skip what is already done. If a server is already running, `air serve` attaches you to it. From
a window of air's own session, it switches you to the `serve` window.

It also stops if tmux is missing or older than 3.0, or if it can't create `workspace_root`. `air doctor`
runs these same checks and changes nothing ([doctor.md](doctor.md)).

Codex needs no trust step: air tells it to trust each job's directory when it starts it.

An agent that fails its checks takes no new work. The other agent keeps working.

## Where it runs

air's tmux session is on a private socket, so it never mixes with your own tmux. Window `serve` is the
server. Each job gets a window named after its issue, like `#12`.

Inside a tmux of your own, `air serve` runs in the current pane instead. Off a terminal (a service, CI), it
just serves: it asks nothing, and changes no config or trust.

`air serve --once` runs one poll, waits for the jobs it started, and exits. It stays in the current terminal
and never attaches; with a server already running it fails.

## How claiming works

Every tick (60 s by default) `air serve` lists the requests repo's open requests. It claims one whose
`effort` fits the quota you have left, minus your reserve.

To claim, it posts a comment with a hidden claim marker, waits 10 seconds and reads the comments again. The
earliest claim wins, so two servers never run the same request. The winner adds `air:claimed`; the others
delete their comment. [spec/v0.md §9](../spec/v0.md#9-claiming) has the details.

air then sets up a fresh workspace under `workspace_root`: the context zip and any repos the request names.

It starts the agent in a new tmux window and, once the agent's input box is up, pastes the whole task in as
its first message. The task stays in `AIR_TASK.md` in the workspace, for the agent to read again. When the
agent finishes, air delivers the result as a comment, a pull request or an artifact, as the request asks.

A request runs on the model tier its `model` names (`small`, `medium`, `large`; default `medium`), mapped by
`[models.HARNESS]` in the config. Effort doesn't pick the tier: an S request without `model` runs on medium
(Sonnet), and `model: small` runs it on Haiku.

The labels are listed in [spec/v0.md](../spec/v0.md#8-labels). `air serve` creates any the repo lacks.

## Budgets

air counts in **US dollars at API prices**: what the tokens would cost at the provider's published rates,
whatever your plan costs. A request's effort is such an estimate: XS $1, S $3, M $10, L $30, XL $100.

air reads each subscription's quota as a percentage of its weekly window. `window_usd` in the config says
what the whole window is worth, so 60% used of a $1000 window leaves $400.

The first run asks for each subscription's `window_usd` and suggests $500 (Enter takes it). A Max plan's week
is worth hundreds of dollars to over a thousand at API prices, so $500 is the low end of a Max plan; a Pro or
Plus plan's week is worth far less. Check it from your first jobs: each final comment gives the job's cost and
the window's usage before and after. A $12 job that moved the window from 40% to 41.5% puts the whole window
near $800.

`reserve` (default 0.3) is the share of each window kept for you: air takes no new work once the window is 70%
used. In the last 24 hours before the window resets the reserve shrinks to 0, so quota that would otherwise
go unused gets used. Both are shares of the window, so `window_usd` doesn't change where air stops; it
changes how big a share of the week each effort is. At $20, an S request is 15% of the week; at $500 it is
0.6%.

When the only thing keeping air from a request is budget or reserve, the log says so once, when that starts
(at startup too), with the exact key to change (`subscriptions.NAME.window_usd`, or `reserve`), the file, and
the `window_usd` that would take the request. The tmux status bar says so while it lasts.

`air serve` reads config.toml again every tick, so a change takes effect without a restart (`workspace_root`
excepted). A file that doesn't parse is logged once, and the config in use stays.

A job that costs more than twice its effort's dollars is stopped early, as partial.

## When an agent waits on you

While a job runs, air reads its tmux window on every tick. It notices when the agent sits at a prompt (a
permission request, folder trust, a Codex approval) for a minute, or its screen hasn't changed for 15 minutes.

The server log then names the job, the prompt and the fix. The tmux status bar shows it too. A prompt also
gets one comment on the issue (at most 3 per job). The job keeps running, and its timeout still applies.

`air attach 12` opens that job's window so you can answer.

## Job commands

```sh
air usage            # quota air reads for each subscription
air attach ISSUE     # open a job's window
air stop ISSUE       # interrupt the agent; keeps the claim and workspace (air:paused)
air start ISSUE      # resume the agent's own session
air pause | resume   # stop or resume taking new work; running jobs continue
air release ISSUE    # give a claimed request back
air serve --manual   # claim and set up, but wait for `air run ISSUE` to start each agent
```

`air claim ISSUE` and `air setup ISSUE` do the first two steps of a job by hand, for one chosen request.

## Cleaning up

air removes what a job leaves behind:

- A job's tmux window closes when the job ends, however it ends. The server checks every job window on each
  tick, and closes one whose job is over or whose workspace is gone. A job ended outside the server (say
  `air release` in another shell) has its window closed this way on the next tick.
- A delivered job's window is closed and its workspace deleted right after delivery. The workspace of a job
  that failed, was cancelled, was released or lost its claim is kept 7 days for debugging, then deleted.
- `air serve` runs a cleanup pass when it starts and then once a day, before its daily `air sweep`. It deletes
  its own requests repo's workspaces past their 7 days, lock files whose process is dead, temp files of air
  processes that died, and launcher dirs (`air-launch-*` in the temp dir) that no tmux window uses. It never
  deletes a workspace while its job still has a process: a delivery in progress, or a tmux window.
- When `air serve` stops with no job window left, it closes air's `log` window, and the air tmux session ends
  with its last window (its own `serve` window, as it exits). air only ever closes windows it created: a
  window of your own on air's socket keeps the session. So do jobs still running in tmux (stopped with `C-c`
  while they ran), which the next `air serve` re-adopts.

air only deletes inside `workspace_root`, its state dir and its own launcher dirs, never through a symlink.
Lock files record the host with the pid, so a state dir shared between machines is safe: a lock another host
wrote is never judged by its pid.

`air status` without an issue shows what is on this machine: the jobs it holds, its tmux windows, the
workspaces kept for debugging (and when each goes), and anything left behind. It ends with
`clean: nothing left behind` when there is nothing. `--json` gives the same as one object.

## The agent's environment

The agent inherits the environment you start `air serve` in (git identity, proxy settings, tokens), so it
works as it would in your own shell.

air adds `AIR_WORKSPACE`, `AIR_CONTEXT` and `AIR_OUT`, plus a login's `CLAUDE_CONFIG_DIR` or `CODEX_HOME`. It
removes the variables Claude Code and Codex set for their own child commands, so you can start `air serve`
from inside either one.
