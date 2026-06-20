---
name: protocol-translation-architecture
description: "How Defiant's proxy translates between Anthropic Messages API and OpenAI Chat Completions API"
metadata: 
  node_type: memory
  type: project
  originSessionId: 1c51f724-0f57-4689-987d-afb9695f111a
---

# Protocol Translation Architecture

## Two Code Paths

### Path 1: Anthropic-to-Anthropic (DeepSeek /anthropic endpoint)
- **Provider**: `ds` (wired to `https://api.deepseek.com/anthropic`)
- **wireFormat**: `"anthropic"`
- **What happens**: Direct passthrough. The proxy:
  1. Injects `thinking: {type, budget_tokens}` from `providers.json` → `start-proxy.ts:841-853`
  2. Calls `injectThinkingBlocks()` to prepend cached thinking blocks to assistant messages → `start-proxy.ts:939-948`
  3. Forwards request without protocol translation
- **Translation needed**: None. DeepSeek's /anthropic endpoint natively speaks Anthropic's protocol.

### Path 2: Anthropic-to-OpenAI (OpenRouter, Kimi, Mistral, Groq, etc.)
- **wireFormat**: `"openai"`
- **What happens**: Full protocol translation.
  1. `translateRequest()` converts: Anthropic body → OpenAI body
     - System prompt → `role: "system"` message
     - Content blocks → strings
     - Tool defs → OpenAI function format
     - `tool_choice` mapped
  2. `createStreamTransformer()` converts SSE stream: OpenAI deltas → Anthropic events
     - `reasoning_content` → `thinking_delta`
     - `content` → `text_delta`
     - `tool_calls` → `tool_use` content blocks
  3. `translateResponse()` converts non-streaming: OpenAI response → Anthropic format
  4. Thinking blocks stripped, `reasoning_content` re-injected from cache → `start-proxy.ts:949-966`

## Key Files
- `proxy/protocol-translate.ts` — All translation logic (types, `translateRequest`, `translateResponse`, `createStreamTransformer`)
- `proxy/thinking-cache.ts` — Caches Anthropic thinking blocks for multi-turn tool conversations (30min TTL, 1000 entries)
- `proxy/reasoning-cache.ts` — Caches DeepSeek `reasoning_content` strings for re-injection (30min TTL, 1000 entries)
- `proxy/forward.ts` — Streaming pipeline, SSE parsing, thinking extraction, response handling
- `proxy/start-proxy.ts` — Request routing, provider selection, thinking config injection, fallback handling

## Data Flow: Multi-Turn Tool Conversation

1. **(Turn N)** DeepSeek response has `reasoning_content` + `tool_calls`
2. `translateResponse()` converts to Anthropic: `thinking` block + `tool_use` blocks
3. `extractThinkingBlocks()` or `extractReasoningContent()` caches reasoning by session key
4. Claude Code receives clean Anthropic response (thinking filtered out)
5. **(Turn N+1)** Claude Code sends Anthropic request with `tool_use` in assistant message history
6. For Anthropic targets: `injectThinkingBlocks()` prepends cached thinking blocks
7. For OpenAI targets: thinking blocks stripped, `reinjectReasoningContent()` adds `reasoning_content` field
8. DeepSeek gets its own reasoning context back, can continue coherent tool chain

## Known Limitations
See [[protocol-translation-issues]] for the full gap analysis.
