---
name: deepseek-caching
description: "How DeepSeek's automatic disk cache and Anthropic API endpoint caching work"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 8e92a888-2e95-454b-8003-f580a0b19336
---

# DeepSeek Caching

## Anthropic-Compatible Endpoint (`/anthropic`)

- **`cache_control` is NOT supported** — marked as "Ignored" on every content type (text blocks, tool_use, tool_result, tools)
- When an unsupported model is passed, it auto-maps to `deepseek-v4-flash`
- Thinking mode works natively via `thinking: {type: "enabled", budget_tokens: N}` — no protocol translation needed

## Automatic Disk Cache (KV Cache)

- **Enabled by default for all users** — no code changes, no `cache_control` markers needed
- Each request triggers construction of a **hard disk cache**
- A cache hit requires **full matching** of a "cache prefix unit" — identical prefix overlap with prior requests
- Cache prefix units are persisted at: (1) end of input, (2) end of output, (3) common prefixes across requests, (4) fixed token intervals for long inputs
- **Persistence:** hours to days (auto-clears when unused)
- Output is always computed fresh — cache only affects input prefix, randomness preserved
- Check via `usage.prompt_cache_hit_tokens` / `usage.prompt_cache_miss_tokens`

## Comparison with Anthropic Prompt Caching

| | Anthropic | DeepSeek |
|---|---|---|
| Trigger | Explicit `cache_control` markers | Automatic prefix detection |
| Scope | Per-block | Whole request prefix |
| Persistence | 5 minutes | Hours to days |
| V4 Pro cache hit price | N/A | $0.0036/M (50× cheaper than miss) |
| V4 Pro cache miss price | N/A | $0.435/M |

## Implications for Defiant

- No need to inject/strip `cache_control` markers — DeepSeek ignores them and caches automatically
- The `compactionWindow` of 950K tokens for DeepSeek models preserves cache hits by delaying compaction (compaction rewrites history → invalidates prefix → cache miss)
- Typical cache hit rate is 98% at $0.0036/M vs $0.435/M miss — a 50× discount

## Empirically Verified (2026-06-12)

Two identical requests to `/anthropic/v1/messages` with deepseek-v4-flash, 917 input tokens:

| | input_tokens | cache_read | cache_creation |
|---|---|---|---|
| Cold | 917 | 0 | 0 |
| Warm (10s later) | 21 | 896 | 0 |

**896/917 = 97.7% hit rate.** The automatic disk cache works identically through the `/anthropic` endpoint — no endpoint switching needed, no `cache_control` markers required.
