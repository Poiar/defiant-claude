---
name: anthropic-protocol-reference
description: "Full Anthropic Messages API protocol reference — message format, streaming, tool use, thinking"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 1c51f724-0f57-4689-987d-afb9695f111a
---

# Anthropic Messages API Protocol

**Endpoint**: `POST /v1/messages`
**Header**: `anthropic-version: 2023-06-01`

## Message Format
Messages are content block arrays, not flat strings:
- `{"role": "user", "content": [{"type": "text", "text": "..."}, {"type": "image", "source": {...}}]}`
- `{"role": "assistant", "content": [{"type": "text", "text": "..."}, {"type": "tool_use", "id": "toolu_...", "name": "...", "input": {...}}]}`
- Tool results: user message with `{"type": "tool_result", "tool_use_id": "toolu_...", "content": "..."}` blocks

## Tool Definitions
Separate `tools` array: `[{"name": "...", "description": "...", "input_schema": {"type": "object", ...}}]`
- `tool_choice`: `"auto"`, `"any"`, `{"type": "tool", "name": "x"}`, `{"type": "none"}`

## Thinking/Reasoning
- Opus 4.6: `thinking: {"type": "adaptive"}` (recommended) or `{"type": "enabled", "budget_tokens": N}` (deprecated)
- Fable 5 / Opus 4.7 / 4.8: `thinking: {"type": "adaptive"}` ONLY. `budget_tokens` returns 400.
- `effort`: `"low"` | `"medium"` | `"high"` | `"xhigh"` | `"max"` (inside `output_config`)
- Response: `thinking` content blocks with `thinking` (text) + `signature` (cryptographic signature)
- Stream: `thinking_delta` + `signature_delta` events

## Streaming SSE Events
1. `message_start` — metadata (id, model, role)
2. `content_block_start` — new content block (type: text/thinking/tool_use)
3. `content_block_delta` — incremental update (text_delta, thinking_delta, input_json_delta)
4. `content_block_stop` — block complete
5. `message_delta` — stop_reason + usage
6. `message_stop` — end of stream

## Stop Reasons
`end_turn`, `tool_use`, `max_tokens`, `refusal`, `stop_sequence`

## System Prompt
Top-level `system` field — string or array of `{"type": "text", "text": "...", "cache_control": {"type": "ephemeral"}}` blocks.

## Prompt Caching
- Breakpoints via `cache_control: {"type": "ephemeral"}` on content blocks
- Minimum cacheable prefix: 4096 tokens on Opus 4.8/4.7/4.6
- Cache read: ~0.1× base price; Cache write: 1.25× base price

## Key Differences from OpenAI Protocol
- Content is structured arrays, not flat strings
- Tool calls are content blocks with parsed JSON objects, not string arguments
- Thinking is separate content block with signature, not a message-level string field
- Streaming has 6 distinct event types, not simple delta chunks
- System prompt is a top-level field, not a message role
