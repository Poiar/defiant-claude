---
name: peer-all
description: Broadcast a message to all other running Claude Code sessions. Triggers: "broadcast", "all sessions", "tell everyone", "peer all", "notify all".
---

# Peer Broadcast

Send the same message to all other Claude Code sessions in one parallel batch. Each recipient sees their own name after the arrow, all sharing one broadcast `#N`.

## Steps

**1. Self** — `~/.claude/scripts/peer-id.ps1` to get your `{uuid, name, msgN}`.

**2. Targets** — `list_tabs`, collect all tabs with `claude.exe` except your own UUID. Use the 8-char UUID as the name. Don't invent short names.

**3. Allocate** — `~/.claude/scripts/peer-next.ps1` returns the next msgId. One shared `#N` for the broadcast.

**4. Send** — All targets in a single parallel batch:

```
send_to_tab <tab-uuid> "/peer-msg <your-uuid> → <their-uuid> #<N>: <msg>"
send_to_tab <tab-uuid> "/peer-msg <your-uuid> → <their-uuid> #<N>: <msg>"
...
```

`submit: true` for all.

**5. Log** — `$env:USERPROFILE\.claude\scripts\peer-log.ps1` per target (one entry each, same msgId).

Replies come back individually via normal peer-msg flow — not broadcast.
