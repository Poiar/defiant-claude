---
name: restart-proxy
description: Per-session proxies — exit CC and re-run to get a fresh proxy.
---

# ⛔ FUCKING DON'T KILL THE PROXY. YOU WILL FUCKING KILL YOUR OWN CLAUDE CODE SESSION.

**The proxy IS your API connection.** If you kill it, your session dies instantly with "connection refused." The proxy is your lifeline. Don't touch it.

## Per-session proxy design

Each `deepclaude` invocation starts its own isolated proxy on a unique port. The proxy lives only as long as the CC session — when CC exits, the proxy is killed.

There is no shared proxy, no PID lock, no hot-swap, and no `--persist`/`--switch`/`--stop-proxy` flags.

## To restart your proxy

**Exit Claude Code and re-run `deepclaude`.** The new session gets a fresh proxy on a new port.

**If you need to change proxy configuration mid-session:**
- Edit `proxy/providers.json` — the proxy hot-reloads it every 15 seconds
- Use `/model providerKey:modelId` in CC to switch opus/fable models
- Use `deepclaude --set-slot SLOT MODEL` to switch sonnet/haiku/subagent

## What NOT to do

- **DO NOT kill the proxy. DO NOT `Stop-Process`. DO NOT `taskkill`. DO NOT touch it at all.**
- DO NOT run a second `deepclaude` from within CC expecting it to switch anything — it starts a NEW proxy on a DIFFERENT port, but your session's `ANTHROPIC_BASE_URL` still points to the old one
