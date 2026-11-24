#!/bin/bash
# TEMPORARY diagnostic: the startJob chain N times with placeholder $1, each window killed at once.
ptys() { ls /dev/ttys* /dev/pts/* 2>/dev/null | wc -l | tr -d ' '; }
orph() { ps -axo ppid=,tty=,args= | awk -v c="$1" '$1 == 1 && $2 != "??" && $2 != "?" && index($0, c)' | wc -l | tr -d ' '; }
stress() {
  local s=stress-$$-$RANDOM n=$2 fails=0 out w
  tmux -L $s new-session -d -s p 'sleep 1000'
  local before=$(ptys)
  for i in $(seq $n); do
    out=$(tmux -L $s new-window -d -P -F '#{window_id}' -t p: -n tmp -- $1 \; set-option -w -t p:=tmp remain-on-exit on \; respawn-pane -k -t p:=tmp -- sleep 999 \; rename-window -t p:=tmp job 2>&1) || { fails=$((fails+1)); last=$out; }
    w=$(echo "$out" | head -1)
    [ "$3" = keep ] || tmux -L $s kill-window -t "$w" 2>/dev/null
  done
  tmux -L $s kill-server; sleep 2
  echo "[$1 / $3] $n starts, $fails failed (${last:-}), ptys $before -> $(ptys), orphan placeholders $(orph "$1"), orphan jobs $(orph 'sleep 999')"
}
stress "$1" "$2" "$3"
