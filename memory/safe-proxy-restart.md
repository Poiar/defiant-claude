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

## Per-session proxy design

Each `deepclaude` invocation starts its own isolated proxy on a unique port. The proxy lives only as long as the CC session — when CC exits, the proxy is killed.

**To "restart" the proxy:** exit CC and re-run `deepclaude`. The new session gets a fresh proxy.

**Related:** [[project-never-kill-proxy]]
