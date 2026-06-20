---
name: proxy-stale-process-herd
description: Dozens of stale proxy instances survive CC restarts — how to clean up
metadata: 
  node_type: memory
  type: project
  originSessionId: 19f80c61-b25a-4865-80f2-0645cef54d4a
---

# Stale Proxy Process Herd

## The problem

The proxy (`start-proxy.ts`) runs as a persistent daemon on `localhost:0` (OS-assigned port). It writes its PID:PORT to `~/.defiant/proxy.pid`. CC sessions connect to it via `ANTHROPIC_BASE_URL=http://127.0.0.1:$port`.

**Closing a CC terminal does NOT kill the proxy.** Each new CC session may reuse an existing proxy or start a new one. Over hours/days, dozens of stale proxy processes accumulate — some 10+ hours old — all running different code versions.

When you `git push` a fix and expect it to work, the running proxy is still the old code. `Stop-Process` on one PID often leaves others alive. The session reconnects to a different stale instance.

## How to detect

```powershell
# Find proxy processes by command line
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | 
  Where-Object { $_.CommandLine -match 'start-proxy' } |
  Select-Object ProcessId, CreationDate
```

## Clean restart procedure

```powershell
# 1. Kill ALL proxy processes
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'start-proxy' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

# 2. Delete stale PID file
Remove-Item ~/.defiant/proxy.pid -Force

# 3. CC auto-starts fresh proxy on next request
```

**Why:** Without step 1, CC finds an old proxy via port scan and reuses it. Without step 2, CC tries the stale PID and either reconnects to old code or fails.

## Related

- [[project-never-kill-proxy]] — why `Stop-Process` on the current proxy kills your CC session
- [[protocol-translation-architecture]] — the two code paths (streaming vs non-streaming)
