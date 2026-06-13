---
name: response-metadata-translation
description: "Response metadata translation: server_tool_use, cache tokens, feature parity across 4 code paths"
metadata: 
  node_type: memory
  type: project
  originSessionId: 9f9f2af1-f236-4553-a009-b035982a8172
---

# Response Metadata Translation

Claude Code reads several `usage` fields from Anthropic-format responses to populate UI displays. When the proxy translates or passes through non-Anthropic provider responses, these fields were missing or wrong.

## 4 code paths

Every response goes through exactly one of these:

| Path | Wire format | Mode | Translation |
|------|-----------|------|-------------|
| Non-streaming OpenAI | `wireFormat: "openai"` | `stream: false` | `translateResponse()` in protocol-translate.ts |
| Streaming OpenAI | `wireFormat: "openai"` | `stream: true` | StreamTransformer in protocol-translate.ts |
| Non-streaming Anthropic | `wireFormat: "anthropic"` | `stream: false` | Response body post-processed in forward.ts:635-658 |
| Streaming Anthropic | `wireFormat: "anthropic"` | `stream: true` | Passthrough + interceptor (see below) |

## server_tool_use — "Did N searches" display

**What it does**: Claude Code reads `usage.server_tool_use.web_search_requests` to set `searchCount` in `toolUseResult`. That number drives the "Did N searches in Xs" display.

**How Anthropic provides it**: Real Anthropic API counts web_search/fetch tool calls in the response and reports them in `usage.server_tool_use`.

**How DeepSeek gets it wrong**:
- OpenAI path: DeepSeek doesn't know about `server_tool_use` — it only returns `prompt_tokens`/`completion_tokens`.
- Anthropic path: DeepSeek's `/anthropic` endpoint returns `server_tool_use: {web_search_requests: 0, web_fetch_requests: 0}` always zero.

**Fixes applied** (2026-06-12):
- `translateResponse()`: counts `web_search`/`web_fetch` tool_use blocks and injects `server_tool_use` into usage
- `finishStream()`: tracks counts in TransformerState, injects into `message_delta.usage`
- `forward.ts:635-658`: counts blocks in Anthropic non-streaming response body, injects `server_tool_use`
- `createAnthropicStreamInterceptor()`: new lightweight SSE Transform that counts `content_block_start` events and patches `message_delta.usage` for the streaming Anthropic path
- `start-proxy.ts:736-763`: `convertServerTools` now runs BEFORE stripping web tools — so `web_search_*` converts to `{type: "custom", name: "web_search"}` and reaches DeepSeek instead of being stripped silently

## cache tokens — field name mismatch

**What DeepSeek returns**:
- OpenAI format: `prompt_cache_hit_tokens`, `prompt_cache_miss_tokens`
- Anthropic format: `cache_read_input_tokens`, `cache_creation_input_tokens`

**How Anthropic names them**: `cache_read_input_tokens`, `cache_creation_input_tokens`

**Fix applied**: forward.ts now tries OpenAI names first, then Anthropic names at all 3 extraction points. translateResponse and streaming transformer map OpenAI→Anthropic names.

## Known limitation (unfixable)

`message_start.usage` on the OpenAI streaming path shows `input_tokens: 0` because upstream only reports token counts in the **last** SSE chunk, but `message_start` must be emitted first. Real values arrive in `message_delta` at stream end. Claude Code reads the final count from `message_delta` so this doesn't cause user-visible issues.

## Wire order matters for web_search

The old order in start-proxy.ts (strip web tools → convert remaining) meant `web_search_*` tools were deleted before `convertServerTools` could convert them to `{type: "custom", name: "web_search"}`. DeepSeek never saw them, so it never requested searches. The proxy's `populateToolResults` (which executes searches server-side when tool results are empty) was a fallback that only worked for non-empty tool definitions that survived stripping. The fix: convert FIRST, then strip only unconverted stragglers.

See also: [[anthropic-protocol-reference]], [[protocol-translation-architecture]], [[protocol-translation-issues]]
