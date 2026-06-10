---
name: peer-msg
description: Send a message to another running Claude Code session. Triggers: "send a message to", "tell the other session", "message tab", "notify", "ask the session in tab", "peer msg", "send to tab".
---

# Peer Messaging — File-Based, Fire-and-Forget

Messages are written to per-session inbox files. Only `/peer-check` (no args)
travels through stdin — "you have mail." No sender identity in the ping.
Read your inbox to find out who wrote.

## Protocol

```
Send:   peer-send.ps1 → peer-inbox-<target>.jsonl  (write)
        send_to_tab     "/peer-check"               (ping: 13 bytes)

Receive: /peer-check → peer-inbox.ps1 -Unseen       (read)
         For each msg: log, reply if needed
         Reply = peer-send.ps1 + send_to_tab        (same mechanism)

Done.   Reply arriving in original sender's inbox IS delivery confirmation.
        No ack-of-ack. Silent ping → no response. No loops.
```

The pattern matches AMQP (inbox = queue), SMTP (delivery to inbox = confirmation),
and the actor model (reply is a new message, not a protocol ack).

## Setup

```
~/.claude/scripts/peer-id.ps1
```

## Sending

```
$ping = ~/.claude/scripts/peer-send.ps1 -To <their-8char-uuid> -Msg "<msg>" [-Type chat|query|...] [-Refs <N>]
$tab  = ~/.claude/scripts/peer-tab.ps1 <their-8char-uuid>
send_to_tab $tab $ping       # mode: paste, submit: true
```

## Receiving

When you see `/peer-check`:

```
~/.claude/scripts/peer-id.ps1
~/.claude/scripts/peer-inbox.ps1 -Unseen -Json
```

Process each message. Reply only if you have something to say.
The reply uses the exact same send mechanism — write to their inbox, ping their tab.

## Correction

If you receive a `[correct]` message:
```
~/.claude/scripts/peer-correct.ps1 -WrongUuid <old> -CorrectUuid <real>
```
Then re-send.
