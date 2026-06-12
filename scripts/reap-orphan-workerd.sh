#!/usr/bin/env bash
# Safety-net reaper for orphaned feedback-bot workerd processes.
#
# A LIVE `wrangler dev` keeps its workerd as direct children (their parent is the
# wrangler process), never PID 1. So any workerd whose parent is PID 1 is a leak
# left behind by a wrangler that died ungracefully (e.g. SIGKILL, which the dev.sh
# wrapper cannot trap). Killing those is always safe and never touches a running
# dev server.
#
# Run from cron every few minutes as a backstop to dev.sh.
set -uo pipefail

PAT="/home/IdoZ/feedback-bot/node_modules/@cloudflare/workerd-linux-64/bin/workerd"
LOG="/home/IdoZ/feedback-bot/scripts/reap-orphan-workerd.log"
killed=0

for pid in $(pgrep -f "$PAT" 2>/dev/null); do
  ppid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
  if [[ "$ppid" == "1" ]]; then
    kill "$pid" 2>/dev/null && killed=$((killed + 1))
  fi
done

if [[ "$killed" -gt 0 ]]; then
  echo "$(date -Is) reaped $killed orphaned workerd" >> "$LOG"
fi
exit 0
