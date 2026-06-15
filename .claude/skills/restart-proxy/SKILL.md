---
name: restart-proxy
description: Tell the user how to restart the proxy from an external terminal. You cannot do it yourself.
---

## CRITICAL: You cannot restart the proxy from within CC

Killing the proxy kills YOUR session. "Detached background processes" don't
work — CC retries the same dead port forever and never recovers. This has been
tested twice and failed both times.

## What to do

Read the current proxy info and tell the user to run this from ANOTHER TERMINAL:

```
# Kill old proxy
taskkill /PID <pid> /F

# Start new one (same args)
npx tsx C:\OC\deepclaude\proxy\start-proxy.ts --routes %USERPROFILE%\.deepclaude\current-routes.json --overrides %USERPROFILE%\.deepclaude\slot-overrides.json --providers C:\OC\deepclaude\proxy\providers.json --thinking-overrides %USERPROFILE%\.deepclaude\thinking-overrides.json

# Then restart CC
dc
```

## Steps for you (Claude)

1. Read `~/.deepclaude/proxy.pid` to get the PID
2. Get the routes/overrides/providers/thinking paths from the running process
3. Print the two commands above with the actual values filled in
4. Stop. Do NOT try to run them yourself.
