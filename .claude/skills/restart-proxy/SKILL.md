---
name: restart-proxy
description: Safe hot-restart of the proxy to pick up .ts code changes. Detached background process — never kills an in-flight request.
---

## Context

The proxy is running — PID and port in `~/.deepclaude/proxy.pid` (format: `PID:PORT`). `.ts` code changes require a restart (tsx compiles at startup). This skill spawns a **detached background process** that:
1. Sleeps 3s (avoids killing the current in-flight request)
2. Kills the old proxy
3. Starts a new proxy on the **same port**
4. CC's retry loop detects the port is alive again and reconnects

**Why this works:** CC retries the same port on ConnectionRefused. The new proxy starts on the same port within ~2 seconds, so CC picks it up on the next retry (typically takes 1-2 retry cycles, ~20s total downtime).

## Steps

1. Read `~/.deepclaude/proxy.pid` to get the current PID and PORT:
   ```
   $content = Get-Content "$env:USERPROFILE\.deepclaude\proxy.pid" -Raw
   $proxyPid, $proxyPort = $content.Trim() -split ':'
   ```
   **IMPORTANT:** Use `$proxyPid` / `$proxyPort` — `$pid` is a PowerShell reserved variable and will silently fail.

2. Get the launch args from the running process (so you reuse the same routes/overrides/providers paths):
   ```
   $cmd = (Get-WmiObject Win32_Process -Filter "ProcessId=$proxyPid").CommandLine
   ```
   Extract `--routes`, `--overrides`, `--providers`, `--thinking-overrides` values from the command line. These paths are stable between sessions. If WMI fails, use the defaults:
   - `--routes $env:USERPROFILE/.deepclaude/current-routes.json`
   - `--overrides $env:USERPROFILE/.deepclaude/slot-overrides.json`
   - `--providers $PSScriptRoot/../proxy/providers.json` (relative to repo root)
   - `--thinking-overrides $env:USERPROFILE/.deepclaude/thinking-overrides.json`

3. Spawn the restart as a **detached background job**:
   ```powershell
   $script = @"
   Start-Sleep -Seconds 3
   Stop-Process -Id $proxyPid -Force -ErrorAction SilentlyContinue
   npx tsx C:\OC\deepclaude\proxy\start-proxy.ts --routes '$routes' --overrides '$overrides' --providers '$providers' --thinking-overrides '$thinking' --port $proxyPort
   "@
   Start-Process -WindowStyle Hidden -FilePath pwsh -ArgumentList @("-NoProfile","-Command",$script)
   ```
   This returns immediately. The background pwsh sleeps 3s (to let the current CC request complete), then kills and restarts.

4. Check the new proxy comes up:
   ```
   Start-Sleep -Seconds 6
   curl http://127.0.0.1:${proxyPort}/health
   ```

## What happens

- CC sends current request → completes normally
- Background pwsh: sleep 3s → kill old proxy → start new on same port (~2s)
- CC on next request: sees port is dead → retries → port is now alive → recovers
- Total downtime: ~5 seconds, handled by CC's built-in retry loop

## What NOT to do

- Do NOT kill the proxy before starting the new one
- Do NOT use a different port — CC can't switch ports mid-session
- Do NOT run the restart synchronously — it will kill the session
- Do NOT use `$pid` as a variable name in PowerShell — it's reserved

If the session does drop (proxy takes >10s to start), tell the user to restart CC from their terminal.
