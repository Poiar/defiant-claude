---
name: safe-proxy-restart
description: "Never kill the active proxy — spawn new, swap CC over, kill old"
metadata: 
  node_type: memory
  type: project
  originSessionId: 05421d94-2b91-477c-8caf-eef543d46a4b
---

**The only safe way to restart the proxy from within a CC session:**

1. Start a NEW proxy on a fresh port:
   ```
   npx tsx proxy/start-proxy.ts --routes ~/.deepclaude/current-routes.json --port <new_port>
   ```
2. Update CC's `ANTHROPIC_BASE_URL` env var to point to the new port
3. Kill the old proxy

**Why the old approach fails:** Killing the proxy mid-request severs the API connection and kills the session. Starting a fresh proxy on a different port avoids this — the new proxy accepts connections independently.

**Why swap-first-then-kill works:** CC sends requests to whatever `ANTHROPIC_BASE_URL` points at. Change that first, wait for the current request to complete, then kill the old proxy. No in-flight request is severed.

**Related:** [[project-never-kill-proxy]]
