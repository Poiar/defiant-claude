---
name: restart-proxy
description: Hot-swap proxies — start a new one, old forwards traffic and dies when connections drain.
---

# Proxy Hot-Swap

**NEVER kill the proxy. NEVER `Stop-Process`. NEVER `taskkill`.** Killing the proxy kills your Claude Code session instantly with "connection refused."

## How it works

1. Write the new port to `~/.deepclaude/next-proxy.port`
2. Start a NEW proxy on that port (detached, with `--port <NEW_PORT>`)
3. The OLD proxy detects the signal file and enters forwarding mode
4. Old proxy forwards all traffic to the new proxy
5. When all active connections drain (user restarts CC), the old proxy exits

**No timers. No silent death. The old proxy exits when connections hit zero.**

## Steps

1. Read the current proxy port from `~/.deepclaude/proxy.port`
2. Pick a new port (current port + 1, or any free port)
3. Get the launch args — you can get them from the running process or use defaults:
   - `--routes %USERPROFILE%/.deepclaude/current-routes.json`
   - `--overrides %USERPROFILE%/.deepclaude/slot-overrides.json`
   - `--providers C:\OC\deepclaude\proxy\providers.json`
   - `--thinking-overrides %USERPROFILE%/.deepclaude/thinking-overrides.json`
4. Write the new port to `~/.deepclaude/next-proxy.port`
5. Start the new proxy DETACHED in background:
   ```powershell
   Start-Process -WindowStyle Hidden -FilePath pwsh -ArgumentList @(
     "-NoProfile","-Command",
     "npx tsx C:\OC\deepclaude\proxy\start-proxy.ts --port <NEW_PORT> --routes '<ROUTES>' --overrides '<OVERRIDES>' --providers '<PROVIDERS>' --thinking-overrides '<THINKING>'"
   )
   ```
6. Wait for the new proxy `/health` to respond (up to 10 seconds)
7. Tell the user: "New proxy on port <NEW_PORT> is ready. Restart CC to pick it up."
8. The old proxy will forward traffic and exit when connections drain

## What NOT to do

- **DO NOT kill the old proxy** — it handles the transition
- **DO NOT kill the new proxy** — that's the one you're switching TO
- **DO NOT forget `--port`** on the new proxy — without it, the old proxy can't find it
- **DO NOT** use `$pid` or `$port` as PowerShell variable names (reserved)
