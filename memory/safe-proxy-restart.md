---
name: safe-proxy-restart
description: "Hot-swap: start new proxy, old forwards for 10min then dies. Never kill."
metadata: 
  node_type: memory
  type: project
  originSessionId: 05421d94-2b91-477c-8caf-eef543d46a4b
---

## CRITICAL: NEVER kill the proxy from within CC

Killing the proxy = killing your session. Verified twice.

## Hot-swap procedure (the right way)

The proxy supports self-superseding via `~/.deepclaude/next-proxy.port`:

1. Write the new port to `~/.deepclaude/next-proxy.port`
2. Start a new proxy on that port (detached, background)
3. The OLD proxy detects `next-proxy.port`, verifies the new proxy is healthy,
   and enters **forwarding mode**: all requests proxy through to the new instance
4. Old proxy sets a 10-minute timer and then exits silently
5. User restarts CC → CC picks up the new proxy directly

**No process is ever killed.** The old proxy dies on its own schedule.

## What CC sees

- During the 10-minute grace period: requests work normally (forwarded transparently)
- After user restarts CC: CC connects directly to new proxy
- If user doesn't restart within 10 minutes: old proxy exits, CC sees
  ConnectionRefused, user must restart anyway

**Related:** [[project-never-kill-proxy]]
