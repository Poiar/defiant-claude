---
name: protocol-translation-issues
description: "Gap analysis: Anthropic-to-OpenAI protocol translation issues found in deepClaude's proxy/protocol-translate.ts"
metadata: 
  node_type: memory
  type: project
  originSessionId: 1c51f724-0f57-4689-987d-afb9695f111a
---

# Protocol Translation Issues in deepClaude

The proxy translates between Anthropic's Messages API and OpenAI-compatible chat completions. Analysis identified these gaps. Issues #1-3 were fixed on 2026-06-12.

## Fixed Issues

### ✅ 1. No thinking config injection for OpenAI-format providers (FIXED)
**Files**: `proxy/start-proxy.ts` (OpenAI path), `proxy/protocol-translate.ts` (OpenAIRequestBody type)

The thinking config from `providers.json` was only injected for `target.format === 'anthropic'`. Now OpenAI-format providers also get `thinking: {type: "enabled", reasoning_effort: "high"}` injected into the request body after `translateRequest()`.

**Fix**: Added `thinking` field to `OpenAIRequestBody` type. Added injection block in start-proxy.ts after translateRequest returns, using the same `matchThinkingModel()` helper.

### ✅ 2. `tool_choice: {type: "none"}` maps to `"auto"` (FIXED)
**File**: `proxy/protocol-translate.ts:translateToolChoice()`

Added `if (obj.type === 'none') return 'none';` before the fallback `return 'auto'`.

### ✅ 3. Model name mismatch for thinking config lookup (FIXED)
**Files**: `proxy/start-proxy.ts`

Third-party providers prefix model names (e.g. `deepseek/deepseek-v4-pro`, `accounts/fireworks/models/deepseek-v4-pro`) but thinking config keys are bare (`deepseek-v4-pro`). Added `matchThinkingModel()` helper that tries exact match first, then falls back to last path segment.

**Fix**: Replaced `state.thinkingConfig[upstreamModel]` with `matchThinkingModel(upstreamModel, state.thinkingConfig)` in both the Anthropic-format and OpenAI-format thinking injection paths.

## Unfixed / Inherent

### 4. Signature is always empty on thinking blocks [LOW, unavoidable]
**File**: `proxy/protocol-translate.ts:337, 416-419, 515`

Anthropic's protocol expects a `signature` field on thinking blocks. DeepSeek doesn't provide signatures. The proxy emits `""`. Claude Code tolerates this. Cannot be fixed without server-side support from DeepSeek.

## Architectural Observations (not bugs)

### Content flattening is lossy
Anthropic's rich content arrays (interleaved text, images, tool_use, tool_result, thinking blocks) are flattened to flat strings for OpenAI format. This is expected.

### System prompt `cache_control` breakpoints lost
Anthropic's prompt caching hints are dropped during translation. DeepSeek has its own automatic caching, so not a practical issue.

### DeepSeek /anthropic endpoint avoids most issues
The direct DeepSeek provider (`ds`) uses `https://api.deepseek.com/anthropic` with `wireFormat: "anthropic"`. This path avoids ALL translation issues.
