---
name: model-trust-for-server-tool-use
description: Claude Code ignores server_tool_use unless the response model starts with claude-
metadata: 
  node_type: memory
  type: project
  originSessionId: 29107800-8199-420c-a341-f3ee92452d0b
---

Claude Code only reads `usage.server_tool_use` (which drives the "Did N searches in Xs" display) when the response model field starts with `claude-`. Non-Claude models (e.g., `deepseek-v4-flash`) silently have their `server_tool_use` dropped.

**Fix applied (4526c75)**: The proxy rewrites the response model back to the CC model in two paths:
- `proxy/forward.ts` (non-streaming): rewrites `resp.model` after injecting `server_tool_use`
- `proxy/protocol-translate.ts` (SSE interceptor): rewrites `message_start.message.model` and strips slot prefix (`haiku:claude-haiku-4-5-20251001` → `claude-haiku-4-5-20251001`)

**Guard**: Only rewrites when upstream model is NOT already `claude-*` (Anthropic-native responses don't need it). Slot prefix stripping uses `/^[a-z]+:(.+)$/`.

**Tests**: 3 new tests in `protocol-translate.test.ts` cover: rewrite non-claude upstream, don't rewrite claude-prefixed, don't rewrite without originalModel (backward compat).

**Related**: `createAnthropicStreamInterceptor` and `translateOpenAiResponse` both inject `server_tool_use`. The interceptor takes an optional `originalModel` parameter for rewriting.
