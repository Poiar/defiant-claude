# Competitor Analysis — Claude Code Proxy/Router Projects

> **Date**: 2026-06-21
> **Scope**: Open-source projects that let Claude Code use non-Anthropic models by intercepting/routing API calls.
> **Excluded**: Manifest (known competitor, excluded per request).

---

## 1. Free Claude Code — `github.com/Alishahryar1/free-claude-code`

| Field | Detail |
|---|---|
| Language | Python (FastAPI) |
| License | MIT |
| GitHub Stars | ~1k+ (growing rapidly, trended on GitHub) |
| Scope | Multi-client proxy (Claude Code CLI, VS Code extension, Codex CLI, JetBrains ACP) |

### What It Does

A FastAPI proxy server that exposes Anthropic-compatible endpoints (`/v1/messages`, `/v1/models`) and an OpenAI Responses endpoint (`/v1/responses`). Claude Code sends Anthropic-style Messages requests; Codex sends OpenAI Responses via SSE. The proxy converts these into internal requests, routes them through provider adapters that translate between protocols, and streams responses back.

### Provider Support (17 backends)

| Provider | Access | Notes |
|---|---|---|
| NVIDIA NIM | Cloud API | `nvidia_nim/` prefix |
| OpenRouter | Cloud API | `open_router/` prefix |
| Google AI Studio (Gemini) | Cloud API | `gemini/` prefix |
| DeepSeek | Anthropic-compat endpoint | `deepseek/` prefix |
| Mistral La Plateforme | Cloud API | `mistral/` prefix |
| Mistral Codestral | Cloud API | `mistral_codestral/` prefix |
| OpenCode Zen | Curated gateway | `opencode/` prefix |
| OpenCode Go | Subscription gateway | `opencode_go/` prefix |
| Wafer | Anthropic-compat endpoint | `wafer/` prefix |
| Kimi (Moonshot) | Anthropic-compat endpoint | `kimi/` prefix |
| Cerebras | OpenAI-compat API | `cerebras/` prefix |
| Groq | OpenAI-compat API | `groq/` prefix |
| Fireworks AI | Anthropic-compat API | `fireworks/` prefix |
| Z.ai | Anthropic-compat API | `zai/` prefix |
| LM Studio | Local server | `lmstudio/` prefix |
| llama.cpp | Local server | `llamacpp/` prefix |
| Ollama | Local server | `ollama/` prefix |

### Key Features

- **Admin Web UI** at `/admin` for configuring providers, validating keys, managing settings
- **Per-model-tier routing**: route Opus, Sonnet, Haiku to different providers
- **Streaming + tool use + reasoning/thinking blocks**
- **Discord/Telegram bot wrappers** for remote sessions
- **Voice-note transcription** via local Whisper or NVIDIA NIM
- **Model picker integration** for both Claude Code and Codex CLIs
- **Two launcher scripts** (`fcc-claude`, `fcc-codex`) that set env vars pointing the real CLI at the local proxy

### What It Doesn't Do

- ❌ No circuit breakers or health-based failover
- ❌ No per-request routing logic (only static tier→provider mapping)
- ❌ No streaming metrics or quality detection
- ❌ No DeepSeek-specific thinking-cache optimization
- ❌ No Prometheus metrics / observability
- ❌ No provider-level spend tracking or daily budgets
- ❌ No slot-override mechanism (per-provider, per-model granularity)
- ❌ No hot-reload config
- ❌ No SSRF protection
- ❌ No concurrency management / rate limiting per provider

---

## 2. Claude Code Router (CCR) — `github.com/musistudio/claude-code-router`

| Field | Detail |
|---|---|
| Language | TypeScript/Node.js |
| License | MIT |
| Scope | Claude Code only |

### What It Does

A middleware proxy (default `http://127.0.0.1:3456`) that sits between Claude Code and various LLMs. It intercepts requests and routes them to a configured provider/model based on user-defined rules with request/response transformers.

### Provider Support

- OpenRouter, DeepSeek, Ollama, Gemini, Volcengine, SiliconFlow, and others via transformer plugins

### Key Features

- **Dynamic `/model` command** — switch models mid-session inside Claude Code
- **Custom routing logic** — write JavaScript functions for advanced routing decisions based on request content (e.g., route by file extension, task type)
- **Web UI** (`ccr ui`) + **CLI** (`ccr model`) for configuration
- **Request/response transformers** — adapter layer for provider-specific API formats
- **Preset system** — export/share configuration presets with sanitized API keys
- **GitHub Actions support** — non-interactive mode for CI/CD pipelines
- **Environment variable interpolation** in config for secure key management

### What It Doesn't Do

- ❌ No circuit breakers or health-based failover
- ❌ No pre-execution web search (DDG/SearXNG/Brave intercept)
- ❌ No streaming metrics or quality detection
- ❌ No DeepSeek thinking-cache optimization
- ❌ No Prometheus metrics
- ❌ No spend tracking / daily budgets
- ❌ No multi-client support (Claude Code only)
- ❌ No SSRF protection
- ❌ Only ~7 documented providers vs Defiant's 18
- ❌ No hot-reload (config changes require restart)
- ❌ Test coverage is minimal

---

## 3. AnthroRouter — *Reddit-only, no public GitHub found*

| Field | Detail |
|---|---|
| Author | UselessParadox (Reddit/GitHub username) |
| Visibility | Reddit post only (r/ClaudeAI) |

Based on limited information from Reddit:
- A lightweight proxy script for using non-Anthropic models with Claude Code
- Minimal documentation and no public repository found
- Likely a simpler approach than Defiant or the other competitors

---

## 4. LiteLLM — *General-purpose model gateway*

| Field | Detail |
|---|---|
| GitHub | `github.com/BerriAI/litellm` |
| Scope | 100+ provider model gateway (NOT Claude-Code-specific) |

### What It Does

A general-purpose proxy that standardizes API calls across 100+ LLM providers using an OpenAI-compatible interface. It can technically sit in front of Claude Code but wasn't designed for it.

### What It Doesn't Do (for Claude Code specifically)

- ❌ No Claude-Code-specific optimizations (thinking blocks, tool-use protocol translation)
- ❌ No pre-execution search intercept
- ❌ No slot-based routing (Opus/Sonnet/Haiku)
- ❌ No streaming metrics tailored to Claude session UX
- ❌ Using it with Claude Code requires manual configuration and doesn't handle Anthropic-specific protocol nuances

---

## Feature Comparison Matrix

| Feature | **Defiant** | **Free CC** | **CCR** | **LiteLLM** |
|---|---|---|---|---|
| Claude Code–specific | ✅ | ✅ | ✅ | ❌ |
| Provider count | **18** | 17 | ~7 | 100+ |
| Per-slot routing (Opus/Sonnet/Haiku) | ✅ | ✅ | ✅ | ❌ |
| Circuit breakers / failover | ✅ | ❌ | ❌ | ⚠️ partial |
| Heatlh-based auto-failover | ✅ | ❌ | ❌ | ❌ |
| Pre-execution web search | ✅ (DDG/SearXNG/Brave) | ❌ | ❌ | ❌ |
| DeepSeek thinking cache | ✅ | ❌ | ❌ | ❌ |
| Protocol translation (Anthropic↔OpenAI/Gemini) | ✅ | ✅ | ✅ | ✅ |
| Dynamic model switching mid-session | ❌ | ❌ | ✅ | N/A |
| Streaming metrics | ✅ | ❌ | ❌ | ❌ |
| Spend tracking + daily budgets | ✅ | ❌ | ❌ | ✅ |
| Prometheus metrics | ✅ | ❌ | ❌ | ✅ |
| Hot-reload config | ✅ | ❌ | ❌ | ✅ |
| Admin/Web UI | Dashboard | Admin UI | Web UI + CLI | Admin UI |
| SSRF protection | ✅ | ❌ | ❌ | ❌ |
| Rate limiting | ✅ | ❌ | ❌ | ✅ |
| Multi-client (VS Code, JetBrains, Codex) | ❌ | ✅ | ❌ | ✅ |
| CI/CD / headless mode | ❌ | ❌ | ✅ | ✅ |
| Local model support (Ollama, LM Studio) | ❌ | ✅ | ✅ | ✅ |
| Tests | **~1668 tests** | Minimal | Minimal | Moderate |

---

## Recommendations for Defiant

### P0 — High Value, Low Effort

1. **Dynamic model switching mid-session** (CCR has this)
   - Add a `/model` or `/switch` mechanism that lets users change a slot's provider without restarting
   - Could be implemented as a hot-reload of the slot config + a `POST /switch` endpoint

2. **Local model support** (Free CC has this, users ask for it)
   - Add Ollama, LM Studio, and llama.cpp providers to `providers.json`
   - This would let people use Defiant for free locally, expanding the user base significantly
   - Protocol translation already exists — just needs provider definitions + smoke tests

### P1 — Medium Value, Medium Effort

3. **Improve the full-post fetch on search results**
   - Current `old.reddit.com` fetch works well when it works, but Cloudflare occasionally blocks it
   - Add retry with different User-Agent rotation and a secondary fallback (e.g., fetching via textise dot iitty)

4. **Admin/Web UI for configuration**
   - Dashboard exists for metrics but not for config editing
   - A simple web form for slot overrides, budget setting, and provider key management would reduce friction

5. **CI/CD / headless mode** (CCR has this)
   - Allow Defiant to be used in automated pipelines without a TTY
   - Useful for the GitHub Actions crowd

### P2 — Nice to Have

6. **Multi-client support** (VS Code extension, JetBrains)
   - Defiant currently only supports the CC CLI
   - The protocol translation layer already works for CC; extending to IDE extensions would broaden reach

7. **Custom routing logic** (CCR's killer feature)
   - Let users write simple JS rules: "route `grep` calls to cheap model, route architectural questions to Opus"
   - This is the #1 feature Defiant lacks that competitors have

8. **Voice transcription** (Free CC)
   - Low priority but would be novel for a coding proxy

### Competitive Advantages to Maintain

- ✅ **Circuit breakers + health probes** — no competitor has these at the same level
- ✅ **Pre-execution web search** — unique to Defiant, major UX win
- ✅ **DeepSeek thinking cache** — 50× discount, nobody else optimizes this
- ✅ **Streaming metrics + quality detection** — crucial for reliability at scale
- ✅ **SSRF protection + security hardening** — enterprise-friendly
- ✅ **Test coverage** — 1668 tests is a moat; competitors have minimal tests

---

## Summary

**Free Claude Code** is the closest competitor — similar provider count, Python-based, growing fast on GitHub. Its main advantages are local model support and the Admin UI. Its main weaknesses are no circuit breakers, no metrics, and no web search intercept.

**Claude Code Router (CCR)** has the best dynamic switching and custom routing logic but lags in provider count, reliability features, and testing.

**Defiant** leads in reliability (circuit breakers, health probes, metrics), cost optimization (DeepSeek cache), and security (SSRF, hardening). The biggest gaps to close are **local model support** and **dynamic model switching**.
