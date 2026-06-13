---
name: claude-code-websearch-provider-failure
description: "Root cause of WebSearch 400 on DeepSeek — thinking block fingerprint cache bug, and the fix"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 66be148d-924b-48b4-be21-54004614e9d7
---

## Symptoms

When using a non-Anthropic provider (DeepSeek, etc.) through DeepClaude, the built-in `WebSearch` tool fails with:
```
All AI providers are currently unavailable (tried: ds). Last error: HTTP 400
```

Meanwhile, `WebFetch` works fine, and the DeepSeek API itself is healthy.

## Root cause (confirmed 2026-06-12)

**DeepSeek's thinking mode requires `thinking` content blocks to be echoed back in every subsequent request.** When thinking is enabled and a previous assistant response contained `[thinking, tool_use]`, the next request MUST include the thinking block alongside the tool_use. DeepSeek returns: `"The content[].thinking in the thinking mode must be passed back to the API."` (HTTP 400).

The proxy has a **thinking cache** (`proxy/thinking-cache.ts`) designed to extract thinking blocks from responses and re-inject them into the next request. It was broken by a **fingerprint mismatch bug**.

### The fingerprint bug

The cache key was `sessionKey:fingerprint:toolUseId`. The fingerprint was a hash of the **last 3 messages**. During extraction (from response), the last 3 messages are `[N-2, N-1, N]`. During injection (into next request), they shift to `[N, N+1, N+2]` — fingerprints don't match → cache miss → thinking blocks not re-injected → DeepSeek 400.

### The fix (applied 2026-06-12)

Removed the fingerprint from the cache key in both `thinking-cache.ts` and `reasoning-cache.ts`. The `firstToolUseId` is already a unique UUID per tool call, so the fingerprint was redundant. Cache key is now `sessionKey:toolUseId`.

Files changed:
- `proxy/thinking-cache.ts` — `store()` and `retrieve()` key on `sk:toolUseId`, ignore fp
- `proxy/reasoning-cache.ts` — same fix
- `proxy/__tests__/reasoning-cache.test.ts` — updated test from "does not reinject" to "re-injects even with mismatched fp"
- `proxy/start-proxy.ts` — added debug body logging for non-retryable failures (8KB truncation)

Both `computeFingerprint` functions are now dead code (still called, params ignored). Safe cleanup for later.

### Verification

Reproduced the error directly against DeepSeek API:
1. Send request with tools + thinking enabled → DeepSeek responds with `[thinking, tool_use]`
2. Strip thinking block, send follow-up with `[tool_use, tool_result]` → **Error 400**

With thinking block injected back → works fine. Fix committed in `2f90a05`.

## Architecture note

Claude Code's WebSearch tool calls the configured LLM provider for result synthesis — that's where the 400 occurred. The Brave Search API key was never the issue.

**Status: RESOLVED** — fingerprint cache miss was the root cause. Fixed by removing fingerprint from cache keys in `thinking-cache.ts` and `reasoning-cache.ts`.
