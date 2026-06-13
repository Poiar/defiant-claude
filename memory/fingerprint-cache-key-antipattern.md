---
name: fingerprint-cache-key-antipattern
description: "Don't use last-N-message fingerprints as cache keys — they shift between turns, causing cache misses"
metadata: 
  node_type: memory
  type: project
  originSessionId: 66be148d-924b-48b4-be21-54004614e9d7
---

Conversation-spanning caches that key on a hash of the last N messages have an inherent mismatch: the extraction side computes the fingerprint at turn T (sending messages [N-2, N-1, N]), but the injection side computes it at turn T+1 (messages shifted to [N, N+1, N+2]). The fingerprints don't match → cache miss.

## Affected files (fixed 2026-06-12)

- `proxy/thinking-cache.ts` — `store()`/`retrieve()` used `sk:fp:toolUseId`. Removed fp.
- `proxy/reasoning-cache.ts` — same bug, same fix.

## Why it was redundant

`firstToolUseId` (or `firstToolCallId`) is already a UUID unique to each tool call. No two conversations produce the same tool_use ID. The fingerprint added no real disambiguation — just bugs.

## Residual dead code

Both files still have `computeFingerprint()` functions. They're called but their return values are ignored (params renamed to `_fp`). Safe to remove when cleaning up.

## Design rule for new caches

When caching per-conversation state across turns in the proxy:
- `sessionKey` (SHA-256 of first user message + system prompt prefix) + a **unique event ID** (UUID from the API response) is sufficient
- **Do not** add message-window fingerprints, turn counters, or message-content hashes — these drift between extraction and injection time
- If you need to prevent cross-turn contamination, use `messageCount` properly (both extraction and injection must pass the same count), not a fingerprint

## Safe modules (no fingerprint issues)

- `momentum.ts` — keys on `sessionKey` only, no fingerprint
- `canary.ts` — `bodyHash` is a pure function of request body, deterministic, no cross-turn caching
- `server-tools.ts` — search cache keys on raw query string, not conversation context
