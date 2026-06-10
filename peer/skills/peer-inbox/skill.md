---
name: peer-inbox
description: Check recent peer-to-peer messages between Claude Code sessions. Triggers: "check inbox", "peer inbox", "any messages", "show messages from other sessions", "did anyone message me", "inbox".
---

# Peer Inbox

Read recent messages from the shared JSONL log.

Run `~/.claude/scripts/peer-inbox.ps1` (optionally with `-Tail 50` for more history). Shows messages to/from you with `→` (sent) / `←` (received) markers and thread IDs.

To reply, use `/peer-msg` with the sender's name.
