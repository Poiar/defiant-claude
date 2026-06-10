---
name: peer-msg
description: Send a message to another running Claude Code session. Triggers: "send a message to", "tell the other session", "message tab", "notify", "ask the session in tab", "peer msg", "send to tab".
---

# Peer Messaging

Format: `/peer-msg X → Y #N: msg` (new) or `re: N: reply` (reply).

Names are the 8-char UUID from `CLAUDE_CODE_SESSION_ID`. No invented names.
Registration is **automatic** — tab ID is detected from `TABBY_AGENT_CHAT_TAB_ID`.

## Setup (automatic)

Run this once — caches your identity and auto-registers your tab:
```
~/.claude/scripts/peer-id.ps1
```

## Sending a message

**1. Look up target's tab** — `~/.claude/scripts/peer-tab.ps1 <their-8char-uuid>`. If empty, they haven't registered yet — send a discovery ping to all tabs with `claude.exe`.

**2. Get next msgId** — `~/.claude/scripts/peer-next.ps1`

**3. Send** — ALWAYS `mode: paste, submit: true`:
```
send_to_tab <target-tab-uuid> "/peer-msg <your-uuid> → <their-uuid> #<N>: <msg>"
```

**4. Log** — `~/.claude/scripts/peer-log.ps1 -Dir out -From <your-uuid> -To <their-uuid> -Msg "<msg>" -Type <type> -MsgId <N>`

## Receiving a message

When you see `/peer-msg X → Y` in your prompt:

**1. Check target** — If Y != your UUID, run this and STOP:
```
~/.claude/scripts/peer-next.ps1 | set $n
~/.claude/scripts/peer-log.ps1 -Dir in -From X -To Y -Msg "Not me — my UUID is <your-uuid>" -Type correct -MsgId $n
send_to_tab <sender-tab-uuid> "/peer-msg <your-uuid> → X re: <their-msgId> [correct] my UUID is <your-uuid>. Resend to me."
```

CRITICAL: The reply MUST contain "my UUID is <your-uuid>" so the sender can correct their registry.
Do NOT echo the original message. Do NOT process the message further.
The sender will run `~/.claude/scripts/peer-correct.ps1 -WrongUuid Y -CorrectUuid <your-uuid>` and re-send.

**2. Look up sender's tab** — `~/.claude/scripts/peer-tab.ps1 <sender-uuid>`

**3. Get next msgId** — `~/.claude/scripts/peer-next.ps1`

**4. Reply** — ALWAYS `mode: paste, submit: true`:
```
send_to_tab <sender-tab-uuid> "/peer-msg <your-uuid> → <sender-uuid> re: <original-N>: <reply>"
```

**5. Log** — `~/.claude/scripts/peer-log.ps1 -Dir in -From <sender-uuid> -To <your-uuid> -Msg "<msg>" -Type <type> -MsgId <N> [-Refs <original-N>]`

## Receiving a correction

When you receive `[correct]: Wrong UUID — my UUID is xxx`:

**MANDATORY — fix BEFORE anything else:**

```
~/.claude/scripts/peer-correct.ps1 -WrongUuid <your-target> -CorrectUuid <their-real-uuid>
```

Then re-send your original message to the corrected UUID.
