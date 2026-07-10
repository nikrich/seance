#!/usr/bin/env bash
# Séance heartbeat — the only code in the system.
# usage: heartbeat.sh <workspace-dir>
set -u
WS="${1:?usage: heartbeat.sh <workspace-dir>}"
cd "$WS" || exit 1
mkdir -p logs
# agents wake us on exit by killing our `sleep` child (see manager skill)
echo $$ > .heartbeat.pid
RL_SLEEP=0
while true; do
  claude -p "Invoke the seance-manager skill and run exactly one manager tick." \
    --dangerously-skip-permissions \
    --model "$(grep -E '^\s*manager:' config.yaml | awk '{print $2}' | head -1)" \
    >> logs/manager.log 2>&1
  if tail -5 logs/manager.log | grep -qiE "rate.?limit|usage limit|overloaded"; then
    RL_SLEEP=$(( RL_SLEEP == 0 ? 900 : RL_SLEEP * 2 ))
    echo "[heartbeat] rate-limited, sleeping ${RL_SLEEP}s" >> logs/heartbeat.log
    sleep "$RL_SLEEP"
    continue
  fi
  RL_SLEEP=0
  SLEEP="$(cat next-sleep 2>/dev/null || echo 60)"
  case "$SLEEP" in (*[!0-9]*|"") SLEEP=60;; esac
  sleep "$SLEEP"
done
