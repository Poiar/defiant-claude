---
name: peer-msg
description: Send a message to another running Claude Code session. Triggers: "send a message to", "tell the other session", "message tab", "notify", "ask the session in tab", "peer msg", "send to tab".
---

# Peer Messaging — File-Based Delivery

Messages are written to per-session inbox files. Only a tiny `/peer-check <uuid>` ping
travels through stdin via `send_to_tab`. No message bodies in stdin — no queue bottleneck.

## Setup (automatic)

```
~/.claude/scripts/peer-id.ps1
```

## Sending

**1. Write message to target's inbox file + get ping:**
```
$ping = ~/.claude/scripts/peer-send.ps1 -To <their-8char-uuid> -Msg "<msg>" -Type <type> [-Refs <N>]
```
This writes to `peer-inbox-<target>.jsonl` and returns `/peer-check <your-uuid>`.

**2. Look up target's tab:**
```
~/.claude/scripts/peer-tab.ps1 <their-8char-uuid>
```
If empty, they're unregistered — ping all tabs with `claude.exe`.

**3. Deliver the ping via `send_to_tab`:**
```
send_to_tab <target-tab-uuid> $ping     # mode: paste, submit: true
```

**Done.** The message body never touched stdin.

## Receiving

When you see `/peer-check <sender-uuid>`:

**1. Read unseen messages from YOUR inbox file:**
```
~/.claude/scripts/peer-id.ps1
~/.claude/scripts/peer-inbox.ps1 -Unseen -Json
```

**2. Process each message:**
- If `to` matches you → log + reply (see below)
- If `to` doesn't match you → reply with `[correct]`:
  ```
  peer-send.ps1 -To <from> -Msg "Wrong UUID — my UUID is <your-uuid>" -Type correct -Refs <msgId>
  ```
  (Rare — only happens if someone has a stale inbox file for your UUID.)

**3. Replying to a message:**
```
$pong = ~/.claude/scripts/peer-send.ps1 -To <from> -Msg "<reply>" -Type chat -Refs <N>
$tab = ~/.claude/scripts/peer-tab.ps1 <from>
send_to_tab $tab $pong
```

**4. ALWAYS ack the pinger** (even if inbox was empty):
```
$stab = ~/.claude/scripts/peer-tab.ps1 <sender-uuid>
send_to_tab $stab "/peer-check <your-uuid>"
```
This verifies the tab→session mapping. If the sender expected `X` but `Y` responds,
they know the mapping is stale and run `peer-correct.ps1`.

## Receiving a correction

When you receive `[correct]`:
```
~/.claude/scripts/peer-correct.ps1 -WrongUuid <your-target> -CorrectUuid <their-real-uuid>
```
Then re-send your original message.
