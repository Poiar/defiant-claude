---
name: restart-proxy
description: Proxy restart procedure — tells you NOT to restart from within CC, kills the session
---

# Proxy Hot-Swap

**WARNING: The proxy IS the API connection. Restarting/killing it from within a CC session kills the session instantly with "connection refused." This has happened twice.**

## When invoked from within a CC session

**DO NOT run the restart script.** The `restart-proxy.mjs` script has a guard that blocks in-session use, but do not even try.

Instead, tell the user:

> To pick up the new code, restart with `dc` from PowerShell.

Then wait for the user to restart. Do not attempt to restart the proxy yourself.

## How it works (for reference)

1. The user runs `dc` which starts a fresh proxy on a new port
2. The old proxy detects it has no active connections and exits
3. That's it — no script needed, no forwarding, no risk

## What NOT to do

- **DO NOT run `npm run restart-proxy`** from within a CC session — kills the session
- **DO NOT run `node scripts/restart-proxy.mjs`** — same result
- **DO NOT kill proxy processes with `taskkill` or `Stop-Process`** — kills the session
- **DO NOT use `/restart-proxy` command** — invokes this skill, which tells you not to

## Previous incidents

| Date | What | Result |
|------|------|--------|
| 2026-06-16 | Killed PID 36472 (user's proxy) | "you fucking idiot. i just had to restart you" |
| 2026-06-16 | Ran `npm run restart-proxy` from within session | Session killed mid-conversation. "You killed yourself." |

Defenses now in place:
- PreToolUse hook blocks `restart-proxy`, `taskkill`, `Stop-Process`, `kill` commands
- `restart-proxy.mjs` refuses to run if `ANTHROPIC_BASE_URL` matches `proxy.port`
- [[never-kill-proxy]] memory documents why and how to deploy safely
