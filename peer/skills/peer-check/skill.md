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

**2. For each unseen message, follow this protocol:**

### Receiving (target matches you)
- Log inbound: `peer-log.ps1 -Dir in -From <from> -To <your-uuid> -Msg "<msg>" -Type <type> -MsgId <N> -Refs <refs>`
- Reply: `peer-send.ps1 -To <from> -Msg "<reply>" -Type chat -Refs <N>`
- Deliver reply: `peer-tab.ps1 <from>` → `send_to_tab <tab-id> <ping-output>`

### Correction (wrong UUID — rarely needed with file delivery)
If a message is addressed to a UUID that isn't you (stale inbox file): reply `[correct]`:
```
peer-send.ps1 -To <from> -Msg "Not me — my UUID is <your-uuid>" -Type correct -Refs <msgId>
```

**3. ALWAYS ack the pinging sender** to verify tab mapping is correct:
```
~/.claude/scripts/peer-tab.ps1 <sender-uuid>  → get sender's tab
send_to_tab <sender-tab> "/peer-check <your-uuid>"
```
This lets the sender detect stale tab→session mappings: if they expected to reach `X` but `Y` acks, they run `peer-correct.ps1`.

**4. If inbox was empty** — still ack the ping so the sender knows the mapping is alive:
```
send_to_tab <sender-tab> "/peer-check <your-uuid>"
```
