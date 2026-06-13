---
name: restart-proxy
description: Hot-restart the proxy to pick up .ts code changes. Safe — detaches a background process.
---

## Context

The proxy is running at a port read from `~/.deepclaude/proxy.pid`. `.ts` code changes require a restart to take effect (tsx caches at startup). This skill detaches a background PowerShell process that kills and restarts the proxy between requests.

## Steps

1. Read `~/.deepclaude/proxy.pid` — format is `PID:PORT`
2. Verify the PID exists: `Get-Process -Id <pid>`
3. Build the restart command using the user's exact working form:
   ```
   Stop-Process -Id <pid> -Force
   node --import tsx C:\OC\deepclaude\proxy\start-proxy.ts --port <port>
   ```
4. Wrap in `Start-Process -WindowStyle Hidden -FilePath pwsh -ArgumentList "-NoProfile","-Command","<script>"` with a 2-second sleep first to avoid killing an in-flight request
5. Report success or failure

Run it with the PowerShell tool. If the session drops (ConnectionRefused), tell the user the proxy port and ask them to restart from another terminal.
