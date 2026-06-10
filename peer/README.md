# Peer Messaging System

Cross-session messaging between Claude Code instances via Tabby terminal tabs.

**Source of truth:** this directory. Edit here, then deploy:
```
.\peer\install.ps1           # copy to ~/.claude/
.\peer\install.ps1 -DryRun   # preview what changed
```

## Architecture

```
Session A ──send_to_tab──→ Tabby ──stdin inject──→ Session B
    │                       │                           │
    │   peer-send.ps1       │    MCP tabby-agent-chat   │   /peer-msg handler
    │   peer-log.ps1        │                           │   peer-id.ps1
    │                       │                           │   peer-log.ps1
    └── peer-messages.jsonl ────────────────────────────┘
         peer-tabs.json          (shared state)
         peer-status.jsonl
```

## Scripts

| Script | Purpose |
|---|---|
| `peer-id.ps1` | Resolve session identity. Auto-detects tab via `TABBY_AGENT_CHAT_TAB_ID`. |
| `peer-send.ps1` | Format and log an outbound message. Returns `/peer-msg` text for `send_to_tab`. |
| `peer-log.ps1` | Append a message entry to `peer-messages.jsonl`. |
| `peer-next.ps1` | Atomic increment for per-session message counter. |
| `peer-inbox.ps1` | Read recent messages to/from this session. Supports `-Unseen`, `-Type`, `-SinceMinutes`. |
| `peer-tab.ps1` | Look up a session's Tabby tab UUID from the shared registry. |
| `peer-correct.ps1` | Fix a wrong tab→session mapping after receiving a `[correct]` reply. |
| `peer-cleanup.ps1` | Purge dead sessions (no heartbeat in 30 min). |
| `peer-dash.ps1` | Fleet dashboard: status board + inbox + artifacts in one call. |
| `peer-hook.ps1` | Stop hook: count unread messages and write alert for statusline. |
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

## Self-correcting protocol

When a message arrives at the wrong session:

```
Wrong session → [correct]: Wrong UUID — my UUID is <real-uuid>
Sender → peer-correct.ps1 -WrongUuid <old> -CorrectUuid <real>
Sender → re-sends to correct UUID
```

## Skills

| Skill | Trigger |
|---|---|
| `peer-msg` | Send/receive messages between sessions |
| `peer-inbox` | Check recent messages |
| `peer-sessions` | Discover other running sessions |
| `peer-all` | Broadcast to all sessions |
