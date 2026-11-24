#!/bin/bash
# TEMPORARY diagnostic: the startJob chain N times with placeholder $1; $3 = kill (each window killed at once) or keep.
ptys() { ls /dev/ttys* /dev/pts/* 2>/dev/null | wc -l | tr -d ' '; }
orph() { ps -axo ppid=,tty=,args= | awk -v c="$1" '$1 == 1 && $2 != "??" && $2 != "?" && index($0, c)' | wc -l | tr -d ' '; }
s=stress-$$-$RANDOM n=$2 fails=0 errs=$(mktemp)
tmux -L $s new-session -d -s p 'sleep 1000'
before=$(ptys)
for i in $(seq $n); do
  t=tmp$i
  if ! w=$(tmux -L $s new-window -d -P -F '#{window_id}' -t p: -n $t -- $1 \; set-option -w -t p:=$t remain-on-exit on \; respawn-pane -k -t p:=$t -- sleep 999 \; rename-window -t p:=$t job$i 2>>"$errs"); then
    fails=$((fails+1))
  fi
  w=$(printf '%s\n' "$w" | grep -m1 '^@')
  [ "$3" = keep ] || { [ -n "$w" ] && tmux -L $s kill-window -t "$w" 2>/dev/null; }
done
during=$(ptys)
tmux -L $s kill-server; sleep 2
echo "[$1 / $3] $n starts, $fails failed, ptys $before -> $during -> $(ptys), orphan placeholders $(orph "$1"), orphan jobs $(orph 'sleep 999')"
sort "$errs" | uniq -c | sed 's/^/    /'
