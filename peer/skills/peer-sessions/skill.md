---
name: peer-sessions
description: Discover what other running Claude Code sessions are working on. Triggers: "what are other sessions doing", "peer sessions", "other claude tabs", "check other tabs", "who else is working", "tab context", "what's running in other tabs", "show other sessions".
---

# Peer Session Discovery

Show what other Claude Code sessions are running — without interrupting them.
Registration is **automatic** via `TABBY_AGENT_CHAT_TAB_ID`. No manual setup.

**1. Self** — `~/.claude/scripts/peer-id.ps1` to get your UUID + auto-register your tab. Exclude yourself.

**2. List** — `list_tabs`. For each tab with `claude.exe` that isn't you, report:
- Short name (first 8 chars of UUID, from `peer-tabs.json` or `peer-id-*.txt`)
- Project (inferred from process cmdlines: e.g. `C:\OC\<X>\node_modules\...` → `C:\OC\<X>`)
- Registered tab (from `peer-tabs.json`)

**3. Fleet** — `~/.claude/scripts/peer-dash.ps1` for the status board (which sessions are alive, their status, project, task).

**4. Cleanup** — `~/.claude/scripts/peer-cleanup.ps1` to prune dead sessions. Run periodically.

To message a discovered session, use `/peer-msg` with the short name.
