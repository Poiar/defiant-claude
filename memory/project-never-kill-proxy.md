---
name: never-kill-proxy
description: Critical rule — killing the proxy kills your own Claude Code session
metadata: 
  node_type: memory
  type: project
  originSessionId: 9e2ee87a-b8de-408c-bfe8-8963765f8002
---

# NEVER kill the proxy from within a Claude Code session

**The proxy IS our API connection.** Every Claude Code session routes through the proxy (`ANTHROPIC_BASE_URL=http://127.0.0.1:<port>`). Killing the proxy mid-session severs the API connection — the session dies immediately with "connection refused."

**Why this keeps happening:**
- Running `Stop-Process` on `node.exe` processes matching `start-proxy` kills ALL proxy instances
- Starting a new proxy is useless if the old one dies — the session's env still points to the old port
- Even "background" restarts kill us because our process tree includes the proxy

**Safe proxy restart procedure:**
Do it from ANOTHER terminal tab — never from within a Claude Code session:
```
deepclaude --stop-proxy    # kills old proxy
dc                          # starts fresh with latest config
```
Then restart THIS Claude Code session manually.

**Why hot-reload exists:** providers.json hot-reload (`24c17de`) was built specifically to avoid this problem. Edit the file, wait 1 second, done. No restart needed for provider metadata changes (wireFormat, endpoint, fallback, extraHeaders).

**When restart IS needed:**
- Compiled code changes (.ts files — tsx caches at startup)
- New CLI flags (--providers was added after the running proxy started)
- Those are rare. 95% of config changes work via hot-reload.

**Reference:** proxy is at `~/.deepclaude/proxy.json` (PID, port); routes at `~/.deepclaude/current-routes.json`.
