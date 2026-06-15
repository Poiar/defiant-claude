---
name: safe-proxy-restart
description: "Hot-swap: start new proxy, old forwards until connections drain. Never kill."
metadata: 
  node_type: memory
  type: project
  originSessionId: 05421d94-2b91-477c-8caf-eef543d46a4b
---

## CRITICAL: NEVER kill the proxy from within CC

Killing the proxy = killing your session. Verified multiple times.

## Hot-swap mechanism

1. Write new port to `~/.deepclaude/next-proxy.port`
2. Start new proxy on that port (detached, with `--port <NEW_PORT>`)
3. Old proxy polls every 5s, detects signal, verifies new proxy `/health`
4. Old proxy enters forwarding mode — all requests proxy to new instance
5. Old proxy exits when `activeConnections` reaches 0 (no timer needed)

**The old proxy dies naturally when all clients disconnect — no 10-minute timer.**

**Related:** [[project-never-kill-proxy]]
