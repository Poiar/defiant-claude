---
name: safe-proxy-restart
description: "Killing the proxy kills the session. CC does NOT auto-recover."
metadata: 
  node_type: memory
  type: project
  originSessionId: 05421d94-2b91-477c-8caf-eef543d46a4b
---

## CRITICAL: Killing the proxy = dead session

**Verified 2026-06-14:** When the proxy dies, CC just retries the same dead
port. No auto-recovery. The only way back is restarting the launcher (`dc`).

## What happened

User tested this live. I killed the proxy on port 64865. CC showed:
```
Unable to connect to API (ConnectionRefused)
Retrying in 16s · attempt 6/10
```
It never recovered on its own. The user had to restart `dc`, which spawned
a fresh proxy on a new port.

## Smooth restart (avoid sesion death)

From an external terminal:
1. Start new proxy: `npx tsx proxy/start-proxy.ts --routes ... --port <port>`
2. Kill old proxy — CC dies
3. Restart CC — it picks up the new proxy

## What definitely doesn't work

- Killing the proxy from within CC — instant session death
- `export ANTHROPIC_BASE_URL=...` in `!` — runs in subshell, doesn't propagate
- CC auto-recovery — it doesn't exist, CC retries the same port forever

**Related:** [[project-never-kill-proxy]]
