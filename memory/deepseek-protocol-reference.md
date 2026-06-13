---
name: deepseek-protocol-reference
description: "Full DeepSeek API protocol reference (OpenAI-compatible) — message format, streaming, tool use, thinking/reasoning"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 1c51f724-0f57-4689-987d-afb9695f111a
---

# DeepSeek API Protocol (OpenAI-compatible)

**Endpoint**: `POST /v1/chat/completions`
**Base URL**: `https://api.deepseek.com` (also `/beta` for prefix completion)

## Message Format
Flat string-based messages (OpenAI style):
- `{"role": "system", "content": "You are helpful."}`
- `{"role": "user", "content": "Hello"}`
- `{"role": "assistant", "content": "Hi!", "tool_calls": [...], "reasoning_content": "..."}`
- `{"role": "tool", "tool_call_id": "call_...", "content": "result"}`

## Tool Definitions
OpenAI-style function definitions:
```json
{"type": "function", "function": {"name": "...", "description": "...", "parameters": {"type": "object", "properties": {...}}}}
```
- `tool_choice`: `"none"`, `"auto"`, `"required"`, or `{"type": "function", "function": {"name": "x"}}`
- Supports `strict: true` for schema enforcement

## Thinking/Reasoning
- **Request**: `thinking: {"type": "enabled"}` (or `"disabled"`, default is `"enabled"`)
- **Request**: `reasoning_effort: "high"` or `"max"` (default `"high"`)
- **Response**: `reasoning_content` string field on the assistant message (separate from `content`)
- **Streaming**: `delta.reasoning_content` field in SSE chunks
- **Multi-turn**: `reasoning_content` MUST be passed back on subsequent assistant messages (API ignores it but it's needed for context). Each turn's reasoning is independent.

## Streaming SSE Format
Simple SSE chunks: `data: {"id": "...", "choices": [{"delta": {"content": "...", "reasoning_content": "...", "role": "assistant"}, "finish_reason": null}], ...}`
- Terminated by `data: [DONE]`
- `stream_options: {"include_usage": true}` adds a final usage chunk
- Tool calls stream via `delta.tool_calls` array with incremental `function.name` and `function.arguments`

## Stop Reasons (finish_reason)
`stop`, `tool_calls`, `length`, `content_filter`, `insufficient_system_resource`

## Prompt Caching
- DeepSeek has automatic disk cache (not configurable via breakpoints)
- `usage.prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` in response
- Cache hit: ~$0.0036/M vs miss: $0.435/M (98% typical)
- DeepSeek V4 Pro context: 1M tokens

## Key Differences from Anthropic Protocol
- Content is flat strings, not structured blocks
- Tool calls are function-call arrays with JSON-string arguments (need JSON.parse), not parsed objects
- Reasoning is a message-level string field, not a content block type
- No cryptographic signature for reasoning content
- Streaming is simple delta chunks, not multi-event structured stream
- System prompt is a message role, not a top-level field
- No `cache_control` breakpoints — automatic disk caching instead
