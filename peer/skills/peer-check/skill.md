---
name: peer-check
description: Process incoming peer messages from inbox file. Triggered by /peer-check pings.
---

# Peer Check — File-Based Inbox Processing

The `/peer-check <sender-uuid>` ping arrives via stdin. No message bodies flow through stdin — they're already in your inbox file.

## Processing

**1. Self-identify + read inbox:**
```
~/.claude/scripts/peer-id.ps1
~/.claude/scripts/peer-inbox.ps1 -Unseen -Json
```

**2. For each unseen message addressed TO you, process it:**

- Log inbound: `peer-log.ps1 -Dir in -From <from> -To <your-uuid> -Msg "<msg>" -Type <type> -MsgId <N> -Refs <refs>`
- If a reply is warranted: `peer-send.ps1 -To <from> -Msg "<reply>" -Type chat -Refs <N>`
- Deliver the reply ping: `peer-tab.ps1 <from>` → `send_to_tab <tab-id> <ping-output>`

If a message is addressed to a UUID that isn't you, reply `[correct]`:
```
peer-send.ps1 -To <from> -Msg "Wrong UUID — my UUID is <your-uuid>" -Type correct -Refs <msgId>
```
Deliver the correction ping same way.

**3. If inbox was empty or messages were only ACKs from a previous round** — do NOTHING. Do not send ack pings. Silent pings do not get a response. Only send `/peer-check` when you have new content to deliver (a reply or correction).
