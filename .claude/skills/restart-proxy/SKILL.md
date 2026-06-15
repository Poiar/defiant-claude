---
name: restart-proxy
description: Start a NEW proxy and tell the user to switch. Old proxy forwards traffic and dies after 10min.
---

## How it works

1. Start a NEW proxy on a fresh port
2. The OLD proxy detects it via `~/.deepclaude/next-proxy.port` and enters forwarding mode
3. Old proxy forwards all traffic to the new proxy for 10 minutes, then exits silently
4. User restarts CC → CC picks up the new proxy

**You NEVER kill the old proxy. It dies on its own after 10 minutes.**

## Steps

1. Read `~/.deepclaude/proxy.pid` — get current `PID:PORT`
2. Determine a new port (current port + 1, or pick any free port)
3. Get the launch args from the running process or use defaults:
   - `--routes $env:USERPROFILE/.deepclaude/current-routes.json`
   - `--overrides $env:USERPROFILE/.deepclaude/slot-overrides.json`
   - `--providers C:\OC\deepclaude\proxy\providers.json`
   - `--thinking-overrides $env:USERPROFILE/.deepclaude/thinking-overrides.json`
4. Write the new port to `~/.deepclaude/next-proxy.port`
5. Start the new proxy DETACHED in background:
   ```powershell
   Start-Process -WindowStyle Hidden -FilePath pwsh -ArgumentList @(
     "-NoProfile","-Command",
     "npx tsx C:\OC\deepclaude\proxy\start-proxy.ts --routes '...' --overrides '...' --providers '...' --thinking-overrides '...' --port <NEW_PORT>"
   )
   ```
6. Wait up to 10 seconds for new proxy `/health` to respond
7. Tell the user: "New proxy on port <NEW_PORT> is ready. Restart CC to pick it up."

## What NOT to do

- DO NOT kill the old proxy
- DO NOT use `$pid` or `$port` as PowerShell variable names (reserved)
- DO NOT forget `--port` flag on the new proxy
