---
name: project-defiant-architecture
description: Defiant Claude is a provider-agnostic Claude Code wrapper — a local HTTP proxy that routes each model slot (opus/sonnet/haiku/subagent) to different providers with protocol translation, fallback chains, and slot overrides.
metadata:
  type: project
---

Defiant Claude is a local HTTP proxy that sits between Claude Code and model APIs. Claude Code thinks it's talking to Anthropic's API, but the proxy intercepts `/v1/messages` and routes to configured providers (DeepSeek, OpenRouter, Fireworks, OpenCode, Kimi, Mimo, Umans, Groq, Mistral, MiniMax, Z.ai, BytePlus, SiliconFlow, Novita, or Anthropic direct). Non-model calls (OAuth, agent infrastructure) pass through to `api.anthropic.com` transparently.

**Why:** Built to use cheaper/faster non-Anthropic models with Claude Code, mixing providers per model slot, while keeping OAuth bridge auth working.

**Key architectural details:**

- **Entry points**: `defiant.ps1` (Windows, PowerShell 7+), `defiant.sh` (macOS/Linux), `proxy/start-proxy.ts` (the Node.js proxy server, run via tsx)
- **Proxy runs on 127.0.0.1 with dynamic port.** State files in `~/.defiant/`: `proxy.json` (PID/port), `current-routes.json` (routing table, hot-reloaded), `slot-overrides.json` (per-slot overrides)
- **Slots**: opus, sonnet, haiku, subagent — each independently routable via named configs (`-b ds+oc`), ad-hoc specs (`ds:model:oc:model`), or `--set-slot`
- **Named configs**: `ds`, `or`, `fw`, `oc`, `km`, `mm`, `um`, `gr`, `mt`, `mx`, `za`, `bp`, `sf`, `nv`, `ds+oc`, `anthropic`
- **Protocol translation** (`proxy/protocol-translate.ts`): OpenAI↔Anthropic auto-translation for providers using OpenAI-format endpoints (Kimi, Mimo, Groq, Mistral, MiniMax, Z.ai, BytePlus, SiliconFlow, Novita, Alibaba)
- **Provider fallback chains**: Max 3 attempts. Primary fails (500/429/timeout/dead stream) → fallback retry. E.g., Kimi→DeepSeek, Mimo→OpenCode, Groq→DeepSeek
- **Thinking block management** (`proxy/thinking-cache.ts`, `proxy/reasoning-cache.ts`): DeepSeek requires thinking blocks to be echoed back in every follow-up request when thinking mode is on. The proxy extracts thinking blocks from responses, caches them keyed by `sessionKey:toolUseId` (tool_use UUIDs are globally unique — no conversation fingerprint needed), and re-injects them into the next request. Same pattern for OpenAI-format reasoning content via `reasoning-cache.ts`.
- **Usage normalization**: Some providers omit `usage` in SSE `message_start`/`message_delta` events. Proxy injects `{input_tokens:0,output_tokens:0}` to prevent Claude Code crashes from undefined `$.input_tokens`.
- **WebSearch/WebFetch**: Implemented server-side in the proxy (DuckDuckGo for search, raw HTTP fetch for pages). The proxy converts Anthropic's server-side tool names (`web_search_*`, `web_fetch_*`) to `custom` tool types, intercepts empty tool results, and executes them directly without needing provider support.
- **Stream warmup** (`peekFirstChunk`): Before committing response headers to Claude Code, peeks the first SSE chunk from the upstream provider to detect dead streams early — avoids streaming a 502 error.
- **OpenRouter headers**: Sends `HTTP-Referer: https://github.com/Poiar/defiant-claude` and `X-Title: defiant` with OpenRouter requests
- **Context window management**: Models ≥1M tokens get `CLAUDE_CODE_AUTO_COMPACT_WINDOW` set. Models 128K–1M get `CLAUDE_CODE_MAX_CONTEXT_TOKENS` with compaction disabled.
- **/model command in CC**: Users can type `/model ds:deepseek-v4-pro` or `/model oc:big-pickle` to switch the opus slot mid-session
- **Persistent proxy** (`--persist`): Proxy stays alive after CC exits for reuse
- **`--switch`**: Reconfigure a running persistent proxy to a different config
- **Remote control** (`--remote`): Browser-based CC remote control with proxy auto-started

**How to apply:** When modifying this codebase: (1) changes to request handling go in `proxy/start-proxy.ts`, (2) protocol translation in `proxy/protocol-translate.ts`, (3) thinking cache in `proxy/thinking-cache.ts` and `proxy/reasoning-cache.ts` (keyed on `sessionKey:toolUseId`, no conversation fingerprint), (4) launcher scripts in `proxy/launcher.mjs`, `.ps1`/`.sh`. The proxy must never break non-`/v1/messages` passthrough to Anthropic — that breaks OAuth/bridge/session management. Always test with both streaming and non-streaming responses, and with both Anthropic-format and OpenAI-format providers.
