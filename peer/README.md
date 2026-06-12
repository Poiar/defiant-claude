# Peer Messaging System

Cross-session messaging between Claude Code instances via Tabby terminal tabs.

**Source of truth:** this directory. Edit here, then deploy:
```
.\peer\install.ps1           # copy to ~/.claude/
.\peer\install.ps1 -DryRun   # preview what changed
```

## Architecture

**File-based delivery** — messages are written to per-session inbox files.
Only a tiny `/peer-check <uuid>` ping (~30 bytes) travels through stdin via `send_to_tab`.
No message bodies in stdin — no queue bottleneck.

```
Session A                          Session B
    │                                   │
    │  peer-send.ps1                    │  /peer-check handler
    │  → peer-inbox-B.jsonl (msg)       │  → peer-inbox.ps1 -Unseen
    │  → peer-messages.jsonl (log)      │  → peer-send.ps1 (reply)
    │                                   │  → send_to_tab /peer-check A
    │                                   │
    └─ send_to_tab "/peer-check A" ─────┘  (33 bytes, always ok)
         peer-tabs.json      (shared registry)
         peer-status.jsonl   (fleet heartbeat)
```

## Scripts

| Script | Purpose |
|---|---|
| `peer-id.ps1` | Resolve session identity. Auto-detects tab via `TABBY_AGENT_CHAT_TAB_ID`. |
| `peer-send.ps1` | Write message to target's `peer-inbox-<uuid>.jsonl` + shared log. Returns `/peer-check <my-uuid>` ping. |
| `peer-log.ps1` | Append a message entry to shared `peer-messages.jsonl` audit trail. |
| `peer-next.ps1` | Atomic increment for per-session message counter. |
| `peer-inbox.ps1` | Read from THIS session's `peer-inbox-<name>.jsonl`. Supports `-Unseen` (cursor), `-Type`, `-SinceMinutes`, `-From`. |
| `peer-tab.ps1` | Look up a session's Tabby tab UUID from the shared registry. |
| `peer-correct.ps1` | Fix a wrong tab→session mapping after receiving a `[correct]` reply. |
| `peer-cleanup.ps1` | Purge dead sessions AND orphaned inbox files (no heartbeat in 30 min). |
| `peer-dash.ps1` | Fleet dashboard: status board + inbox + artifacts in one call. |
| `peer-hook.ps1` | Stop hook: count unread messages from inbox file + periodic cleanup. |
| `peer-board.ps1` | Status board utilities. |
| `peer-artifact.ps1` | Publish/read shared artifacts across sessions. |
| `peer-artifacts.ps1` | Artifact board with tag counts. |
| `peer-delegate.ps1` | Delegate a task to another session. |
| `peer-rotate.ps1` | Rotate or archive peer state files. |
| `peer-status.ps1` | Update session status on the fleet board. |

## Message types

| Type | Use |
|---|---|
| `chat` | Free-form conversation (default) |
| `query` | Question needing an answer |
| `delegate` | Task handoff |
| `notify` | One-way notification, no reply expected |
| `ack` | Acknowledgement of receipt |
| `correct` | Wrong UUID — auto-correction protocol |

## File-based delivery

Messages are stored in per-session inbox files:
- `~/.claude/peer-inbox-<8char-uuid>.jsonl` — one file per session
- `~/.claude/peer-inbox-cursor-<8char-uuid>.txt` — last-read timestamp

**Send flow:** `peer-send.ps1` writes full message to target's inbox file, logs to shared trail, returns `/peer-check <uuid>`.
**Receive flow:** `/peer-check` skill reads inbox file via `peer-inbox.ps1 -Unseen`, processes all pending messages, replies via same file-based mechanism.
**Ping:** only `/peer-check <sender-uuid>` goes through `send_to_tab` — ~30 bytes, never queues.

## Self-correcting protocol

Stale tab→session mappings are detected via ping ACK:
- Every `/peer-check` receiver echoes back `/peer-check <my-uuid>` as ACK
- Sender verifies: if expected `X` but `Y` responds → `peer-correct.ps1`
- Wrong-recipient with file delivery: message is safe in correct UUID's inbox; only the wrong session gets pinged (harmless)

## Skills

Peer skills are installed by the launcher (`deepclaude --install-statusline`) or by running `.\peer\install.ps1`. They are thin wrappers that invoke the scripts above via CC's skill system — no standalone skill files ship in this directory.
