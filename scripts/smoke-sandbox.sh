#!/usr/bin/env bash
# Smoke test: `air serve --once` against the sandbox repo asinghvi17/ai-requests-sandbox with a FAKE agent
# (no AI quota is spent). Run it from a checkout of main, on a Mac or Linux box with a logged-in `gh`:
#
#   bash scripts/smoke-sandbox.sh              # file one test issue, serve it once, print the result
#   bash scripts/smoke-sandbox.sh --cleanup    # close the test issue the last run filed (nothing else)
#   bash scripts/smoke-sandbox.sh --cleanup 12 # close issue #12 (only if its title starts "air smoke test")
#
# Needs: node >= 26 (air runs TypeScript directly), gh (logged in as asinghvi17), git, tmux, perl or timeout.
#
# GITHUB SIDE EFFECTS, all on asinghvi17/ai-requests-sandbox (confirmed from the code paths named below).
# Happy path, `deliver: comment`, report far under the 65,536-char comment limit:
#
#  1. ISSUE. One issue is CREATED by `gh issue create` (this script), titled "air smoke test <UTC time>",
#     author asinghvi17, with label `ai-request`. Its body is the lint-valid XS `deliver: comment` request.
#  2. LABEL `ai-request` is CREATED on the repo only if it does not exist yet (`gh label create`, this
#     script). It is never deleted.
#  3. CLAIM (src/claim/claim.ts `claim`):
#       - COMMENT #1 posted: "Claimed by `<host>` with air." plus an `air-claim` marker.
#       - ASSIGNMENT: asinghvi17 is assigned to the issue (POST .../assignees).
#       - after a 10 s wait, LABEL `air:claimed` is ADDED to the issue.
#  4. START (src/serve/jobs.ts `startAgent` -> `moveLabel`): LABEL `air:running` ADDED, then `air:claimed`
#     REMOVED from the issue.
#  5. DELIVERY (src/serve/jobs.ts `finishJob`, src/serve/deliver.ts `deliverComment`), in this order:
#       - COMMENT #2 posted: the contents of out/REPORT.md (the word "hello") plus air's usage footer.
#       - LABEL `air:done` ADDED, then `air:running` REMOVED from the issue.
#       - ASSIGNMENT: asinghvi17 is UNASSIGNED.
#  6. CLEANUP (`--cleanup`): the issue is CLOSED (`gh issue close --reason "not planned"`), no comment.
#
#  Final state: issue closed after cleanup (open before), labels `ai-request` + `air:done`, assignees none,
#  exactly 2 comments (the claim comment and the report).
#
#  Repo-level label objects: `air:claimed`, `air:running` and `air:done` are added to issues through the
#  issues-labels API, which creates a missing label on the repo as a side effect. Nothing here deletes them.
#  Read-only calls: GET user, GET issue/comments, list open `ai-request` issues, the sandbox's default
#  branch and its HEAD SHA, and, if the issue author is not the repo owner, GET collaborators/<login>/permission.
#  `git clone` of the sandbox repo into the temp workspace (a read; `repos:` points at the sandbox itself).
#
#  NOT HAPPENING with `deliver: comment`:
#   - NO comment is deleted. (deleteComment is only called when a claim is lost to another server or the claim
#     itself errors, src/claim/claim.ts; neither happens with one server and one issue.)
#   - NO git push, NO branch, NO pull request. (Only `deliverPr` pushes and opens PRs, and it is only called for
#     `deliver: pr`, src/serve/deliver.ts `deliver`.)
#   - NO release, NO release asset, NO upload. (`ctx.api.release`/`uploadAsset` are only reached from
#     `uploadOnce`, which `deliverComment` calls only for a report over 65,536 chars and `deliverArtifact`
#     only for `deliver: artifact`.)
#   - NO other issue is touched: the script refuses to run if any other open `ai-request` issue exists,
#     because `air serve` would otherwise claim the oldest one.
#  If something goes wrong instead (setup/agent/delivery failure), air posts ONE release comment (with an
#  `air-release` marker and the reason), adds `air:failed`, removes `air:claimed`/`air:running`/`air:paused`,
#  and unassigns asinghvi17 (src/claim/claim.ts `giveUp`). Still no push, PR or asset.
#
# LOCAL ISOLATION. air has env overrides, so the real air config is not touched (HOME is not changed):
#   XDG_CONFIG_HOME -> <tmp>/xdg   config.toml lives at $XDG_CONFIG_HOME/air/config.toml (src/setup/config.ts)
#   AIR_CONFIG_DIR  -> <tmp>/xdg/air   subscriptions.json (src/agents/usage/index.ts `configFile`)
#   AIR_STATE_DIR   -> <tmp>/state     serve.log, serve.lock, manual ledger (src/agents/usage/index.ts `stateDir`)
#   TMUX_TMPDIR     -> <tmp>/tmux      air's private tmux socket (`tmux -L air`), so it never shares a tmux
#                                      server or session with a real `air serve` (src/tmux/env.ts `clientEnv`)
#   workspace_root  -> <tmp>/workspaces (config.toml)
# Overriding XDG_CONFIG_HOME would also move gh's config, so GH_CONFIG_DIR is first set explicitly to gh's real
# directory and exported; gh (and git's `gh auth git-credential` helper below) keep using the real login.
# git credentials for the clone are supplied for this process only, via GIT_CONFIG_* env vars (your git config
# is not modified).
set -euo pipefail

REPO=asinghvi17/ai-requests-sandbox
OWNER_LOGIN=asinghvi17
TITLE_PREFIX='air smoke test'
TMP_BASE=${SMOKE_TMP:-/tmp}
LAST_ISSUE_FILE=$TMP_BASE/air-smoke-last-issue
SERVE_TIMEOUT=${SMOKE_TIMEOUT:-600}

die() { echo "smoke: $*" >&2; exit 1; }
say() { printf '\n== %s\n' "$*"; }

# gh's real config dir, resolved BEFORE XDG_CONFIG_HOME is overridden below.
export GH_CONFIG_DIR=${GH_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/gh}

command -v gh >/dev/null || die "gh not found"
gh auth status >/dev/null 2>&1 || die "gh is not logged in (GH_CONFIG_DIR=$GH_CONFIG_DIR): run 'gh auth login'"
LOGIN=$(gh api user --jq .login)
[ "$LOGIN" = "$OWNER_LOGIN" ] || [ "${SMOKE_ANY_USER:-}" = 1 ] || die "gh is logged in as '$LOGIN', expected $OWNER_LOGIN (set SMOKE_ANY_USER=1 to override)"

# ---------------------------------------------------------------------------------------------- cleanup
if [ "${1:-}" = "--cleanup" ]; then
  N=${2:-}
  [ -n "$N" ] || { [ -f "$LAST_ISSUE_FILE" ] && N=$(cat "$LAST_ISSUE_FILE"); } || true
  [[ "$N" =~ ^[0-9]+$ ]] || die "no issue number: pass one ('--cleanup N') or run the smoke test first"
  T=$(gh issue view "$N" --repo "$REPO" --json title --jq .title)
  case "$T" in "$TITLE_PREFIX"*) ;; *) die "#$N is titled '$T', not a smoke-test issue; refusing to close it" ;; esac
  gh issue close "$N" --repo "$REPO" --reason "not planned"
  echo "closed https://github.com/$REPO/issues/$N (nothing else was changed)"
  exit 0
fi
[ $# -eq 0 ] || die "usage: $0 [--cleanup [ISSUE]]"

# ---------------------------------------------------------------------------------------------- preflight
AIR_SRC=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
[ -f "$AIR_SRC/src/cli/main.ts" ] || die "run this from a checkout of main (src/cli/main.ts not found next to scripts/)"
for c in node git tmux; do command -v "$c" >/dev/null || die "$c not found"; done
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 26 ] || die "node >= 26 required (found $(node -v))"
air() { node "$AIR_SRC/src/cli/main.ts" "$@"; }

if command -v timeout >/dev/null; then
  with_timeout() { local s=$1; shift; timeout "$s" "$@"; }
elif command -v gtimeout >/dev/null; then
  with_timeout() { local s=$1; shift; gtimeout "$s" "$@"; }
else
  # macOS has no timeout(1): SIGALRM survives exec and kills the command after $1 seconds.
  with_timeout() { local s=$1; shift; perl -e 'alarm shift; exec @ARGV or die "exec: $!"' "$s" "$@"; }
fi

# ---------------------------------------------------------------------------------------------- local setup
WORK=$(mktemp -d "$TMP_BASE/air-smoke.XXXXXX")
mkdir -p "$WORK/xdg/air" "$WORK/state" "$WORK/tmux" "$WORK/workspaces" "$WORK/bin"
export XDG_CONFIG_HOME=$WORK/xdg
export AIR_CONFIG_DIR=$WORK/xdg/air
export AIR_STATE_DIR=$WORK/state
export TMUX_TMPDIR=$WORK/tmux
# Credentials for air's `git clone` of the sandbox (env only; the user's git config is untouched).
export GIT_CONFIG_COUNT=2
export GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0=
export GIT_CONFIG_KEY_1=credential.helper GIT_CONFIG_VALUE_1='!gh auth git-credential'
trap 'tmux -L air kill-server >/dev/null 2>&1 || true' EXIT   # only the private server under $TMUX_TMPDIR

SOCK="$TMUX_TMPDIR/tmux-$(id -u)/air"
[ "${#SOCK}" -lt 100 ] || die "tmux socket path too long (${#SOCK} chars): set SMOKE_TMP to a short directory such as /tmp"

say "local workspace: $WORK  (gh config: $GH_CONFIG_DIR)"

# The fake agent. air starts it as: <command> --session-id <uuid> --model <model> "<instruction>" in the workspace.
cat > "$WORK/bin/fake-agent.sh" <<'EOF'
#!/usr/bin/env bash
# Stand-in for `claude`: no AI, no quota. Reads AIR_TASK.md, writes out/REPORT.md, then creates AIR_DONE.
set -eu
cd "${AIR_WORKSPACE:?AIR_WORKSPACE not set}"
echo "fake-agent: args: $*"
[ -s AIR_TASK.md ] || { echo "fake-agent: AIR_TASK.md missing" >&2; exit 1; }
head -n 5 AIR_TASK.md
sleep 3
mkdir -p out
printf 'hello\n' > out/REPORT.md
touch AIR_DONE
echo "fake-agent: done"
EOF
chmod +x "$WORK/bin/fake-agent.sh"

# Keys per src/setup/config.ts. [subscriptions.smoke] must share its name with the manual entry in subscriptions.json.
cat > "$XDG_CONFIG_HOME/air/config.toml" <<EOF
repo = "$REPO"
workspace_root = "$WORK/workspaces"
max_jobs = 1
tick_seconds = 5

[subscriptions.smoke]
harness = "claude"
scale = 1
reserve = 0

[agents.claude]
command = ["$WORK/bin/fake-agent.sh"]
EOF

# A MANUAL subscription (src/agents/usage/manual.ts): no 'claude -p /usage' call. 100 percent budget, nothing spent: an XS
# request costs 1 point.
cat > "$AIR_CONFIG_DIR/subscriptions.json" <<'EOF'
[{"name": "smoke", "harness": "manual", "reset": {"every": "weekly", "day": 0}, "budget": {"percent": 100}}]
EOF

say "config check (config.toml parses; air usage reads the manual subscription)"
node --input-type=module -e '
  const { loadConfig, configPath } = await import(process.argv[1] + "/src/setup/config.ts");
  const c = loadConfig(configPath());
  if (c.repo !== process.argv[2] || !c.agents.claude || !c.subscriptions.smoke) { console.error("config did not parse as intended"); process.exit(1); }
  console.log(configPath(), "->", JSON.stringify({ repo: c.repo, root: c.workspace_root, subs: c.subscriptions, agents: c.agents }));
' "$AIR_SRC" "$REPO"
air usage

# ---------------------------------------------------------------------------------------------- the request
say "looking up $REPO default branch and HEAD"
BRANCH=$(gh api "repos/$REPO" --jq .default_branch)
SHA=$(gh api "repos/$REPO/commits/$BRANCH" --jq .sha)
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || die "could not read HEAD SHA of $REPO@$BRANCH"
echo "$BRANCH @ $SHA"

STAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
TITLE="$TITLE_PREFIX $STAMP"
cat > "$WORK/body.md" <<EOF
---
air: 0
effort: XS
harness: [claude]
model: small
repos:
  - url: https://github.com/$REPO.git
    ref: "$SHA"
    path: sandbox
deliver: comment
timeout: 10m
---

## Task

Smoke test. Reply with the word hello.

## Done when

- The report says hello.

## Context

\`repo/sandbox/\` is a checkout of this sandbox repository. Nothing in it needs to be read or changed.
EOF

say "air lint of the request body"
air lint "$WORK/body.md"

say "making sure only our issue is open with the ai-request label"
if ! gh label list --repo "$REPO" --limit 200 --json name --jq '.[].name' | grep -qx 'ai-request'; then
  gh label create ai-request --repo "$REPO" --description "air request" --color 1d76db
fi
OTHERS=$(gh issue list --repo "$REPO" --label ai-request --state open --limit 100 --json number --jq '.[].number' | tr '\n' ' ')
if [ -n "${OTHERS// /}" ]; then
  HINT=""
  for o in $OTHERS; do HINT="$HINT
  bash $0 --cleanup $o"; done
  die "open ai-request issues already exist (${OTHERS% }): air serve would claim the oldest one.
Close them first. For smoke-test issues left by an earlier run (titles starting \"$TITLE_PREFIX\"):$HINT
Close any other issue by hand, or use another repo."
fi

say "filing the test issue"
URL=$(gh issue create --repo "$REPO" --title "$TITLE" --body-file "$WORK/body.md" --label ai-request)
N=${URL##*/}
echo "$N" > "$LAST_ISSUE_FILE"
echo "issue: $URL"
[[ "$N" =~ ^[0-9]+$ ]] || die "could not read the issue number from '$URL'"

# GitHub's issue list (and its label index) lags a just-created issue: wait until air would see it.
say "waiting for #$N to show up in the open ai-request list (timeout ${SMOKE_LIST_TIMEOUT:-120}s)"
LIST_END=$(( $(date +%s) + ${SMOKE_LIST_TIMEOUT:-120} ))
until gh issue list --repo "$REPO" --label ai-request --state open --limit 100 --json number --jq '.[].number' | grep -x "$N" >/dev/null; do
  [ "$(date +%s)" -lt "$LIST_END" ] || die "#$N did not show up in the open ai-request list within ${SMOKE_LIST_TIMEOUT:-120}s. Close it with: bash $0 --cleanup $N"
  sleep 3
done
echo "#$N is listed"

# ---------------------------------------------------------------------------------------------- serve
say "air serve --once (timeout ${SERVE_TIMEOUT}s)"
set +e
with_timeout "$SERVE_TIMEOUT" node "$AIR_SRC/src/cli/main.ts" serve --once
RC=$?
set -e
echo "air serve exited $RC"

# ---------------------------------------------------------------------------------------------- verify
say "result for $URL"
gh issue view "$N" --repo "$REPO" --json state,labels,assignees --jq '"state: \(.state)\nlabels: \([.labels[].name] | join(", "))\nassignees: \([.assignees[].login] | join(", "))"'
echo
gh issue view "$N" --repo "$REPO" --comments

say "serve log ($AIR_STATE_DIR/serve.log)"
cat "$AIR_STATE_DIR/serve.log" 2>/dev/null || true

LABELS=$(gh issue view "$N" --repo "$REPO" --json labels --jq '[.labels[].name] | join(" ")')
if [ "$RC" -eq 0 ] && [[ " $LABELS " == *" air:done "* ]]; then
  echo; echo "SMOKE OK: $URL has air:done. Close it with: bash $0 --cleanup"
else
  say "air debug panes (what tmux reports and which jobs air sees)"
  air debug panes || true
  echo; echo "SMOKE FAILED (serve exit $RC, labels: $LABELS). Local files kept in $WORK. Close the issue with: bash $0 --cleanup $N"
  exit 1
fi
echo "Local files (config, workspace, logs): $WORK  (safe to delete)"
