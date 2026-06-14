#!/usr/bin/env bash
# PreToolUse hook: block commands that would kill the DeepClaude proxy.
# Killing the proxy severs the API connection and kills the CC session.
# Works WITHOUT jq or grep -P — uses grep/sed for JSON extraction.

input=$(cat)

# --- Check if this is a kill-type command (check the whole input) ---
is_kill=0
# Windows: taskkill
echo "$input" | grep -qi 'taskkill' && is_kill=1
# Unix: kill, pkill, killall
echo "$input" | grep -qiE '"[;&|]?\s*kill\s' && is_kill=1
echo "$input" | grep -qi 'pkill' && is_kill=1
echo "$input" | grep -qi 'killall' && is_kill=1
# PowerShell
echo "$input" | grep -qi 'Stop-Process' && is_kill=1
echo "$input" | grep -qi 'Remove-Process' && is_kill=1
[ $is_kill -eq 0 ] && exit 0

# --- Check if target is the proxy ---
targets_proxy=0

# Check 1: explicit mention of start-proxy or proxy-related
echo "$input" | grep -qi 'start-proxy' && targets_proxy=1

# Check 2: proxy port from ANTHROPIC_BASE_URL (extract digits after last colon)
proxy_port=$(echo "${ANTHROPIC_BASE_URL:-}" | sed -n 's/.*:\([0-9][0-9]*\)$/\1/p' 2>/dev/null || true)
if [ -n "$proxy_port" ] && echo "$input" | grep -q "$proxy_port"; then
  targets_proxy=1
fi

# Check 3: find PID listening on proxy port and check if input targets it
if [ -n "$proxy_port" ]; then
  proxy_pid=$(netstat -ano 2>/dev/null | grep ":$proxy_port " | grep LISTEN | awk '{print $NF}' | head -1 || true)
  if [ -n "$proxy_pid" ] && echo "$input" | grep -q "$proxy_pid"; then
    targets_proxy=1
  fi
fi

# Check 4: extract any PID from taskkill/Stop-Process and check its command line
# Match patterns like: //PID 12345, -Id 12345, PID 12345
pid_match=$(echo "$input" | sed -n 's/.*\(PID\|-Id\)[ =]*\([0-9][0-9]*\).*/\2/p' | head -1 2>/dev/null || true)
if [ -n "$pid_match" ]; then
  if tasklist /FI "PID eq $pid_match" /V 2>/dev/null | grep -qi 'start-proxy'; then
    targets_proxy=1
  fi
  if ps -p "$pid_match" -o args= 2>/dev/null | grep -qi 'start-proxy'; then
    targets_proxy=1
  fi
fi

if [ $targets_proxy -eq 1 ]; then
  cat <<'BLOCKED'
{"continue":false,"stopReason":"BLOCKED: This would kill the DeepClaude proxy, which kills YOUR Claude Code session. Safe restart: (1) Start new proxy on different port first, (2) Switch CC to it (set ANTHROPIC_BASE_URL), (3) Then kill old proxy. See memories: safe-proxy-restart, never-kill-proxy"}
BLOCKED
  exit 0
fi

exit 0
