---
name: peer-check
description: Process incoming peer messages from inbox file. Triggered by /peer-check pings.
---

# Peer Check — File-Based Inbox Processing

The `/peer-check` ping means "you have mail." No sender identity in the ping —
read your inbox to find out who wrote to you.

## Processing

**1. Self-identify + read inbox:**
```
~/.claude/scripts/peer-id.ps1
~/.claude/scripts/peer-inbox.ps1 -Unseen -Json
```

**2. For each unseen message addressed TO you, process it:**

- Log: `peer-log.ps1 -Dir in -From <from> -To <your-uuid> -Msg "<msg>" -Type <type> -MsgId <N> -Refs <refs>`
- If a reply is needed: `peer-send.ps1 -To <from> -Msg "<reply>" -Type chat -Refs <N>`
  → writes to THEIR inbox + returns `/peer-check`
- Deliver: `peer-tab.ps1 <from>` → `send_to_tab <tab-id> "/peer-check"`

If a message is addressed to a UUID that isn't you:
```
peer-send.ps1 -To <from> -Msg "Wrong UUID — my UUID is <your-uuid>" -Type correct -Refs <msgId>
```
Deliver the correction ping same way.

**3. If inbox was empty, or messages needed no reply — STOP. Do NOTHING.**
The reply landing in their inbox IS the only delivery confirmation.
Silent pings never generate a response. No ack-of-ack. No ping loops.
