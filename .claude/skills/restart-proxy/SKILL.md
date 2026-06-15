---
name: restart-proxy
description: Hot-swap proxies — run the restart script, old forwards traffic and dies when connections drain.
---

# Proxy Hot-Swap

**NEVER kill the proxy. NEVER `Stop-Process`. NEVER `taskkill`.** Killing the proxy kills your Claude Code session instantly with "connection refused."

## How it works

1. Run `node scripts/restart-proxy.mjs`
2. Script writes `~/.deepclaude/next-proxy.port` with the new port
3. Script starts a NEW proxy on that port (detached, `--port <NEW_PORT>`)
4. The OLD proxy detects the signal file and enters forwarding mode
5. Old proxy forwards all traffic to the new proxy
6. When all active connections drain (user restarts CC), the old proxy exits

**No timers. No silent death. The old proxy exits when connections hit zero.**

## Steps (automated by script)

```
node C:\OC\deepclaude\scripts\restart-proxy.mjs
```

The script:
1. Reads current port from `~/.deepclaude/proxy.port`
2. Picks new port (current + 1)
3. Writes `~/.deepclaude/next-proxy.port` signal file
4. Starts new proxy detached with correct `--routes`, `--overrides`, `--providers` flags
5. Waits up to 10s for new proxy `/health` to respond
6. Prints: "New proxy on port <N> is ready. Restart CC to pick it up."

If you must run manually, the launch args are:
- `--routes %USERPROFILE%/.deepclaude/current-routes.json`
- `--overrides %USERPROFILE%/.deepclaude/slot-overrides.json`
- `--providers C:\OC\deepclaude\proxy\providers.json`
- `--thinking-overrides %USERPROFILE%/.deepclaude/thinking-overrides.json` (if exists)

## What NOT to do

- **DO NOT kill the old proxy** — it handles the transition
- **DO NOT kill the new proxy** — that's the one you're switching TO
- **DO NOT forget `--port`** on the new proxy — the old proxy won't find it
- **DO NOT** use `$pid` or `$port` as PowerShell variable names (reserved)
