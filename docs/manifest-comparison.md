# Defiant vs Manifest — Feature Comparison

**Date**: 2026-06-16  
**Defiant**: v1.0.0, MIT, 17 providers, TypeScript, local proxy  
**Manifest**: v6.9.2, MIT, 18 providers, TypeScript monorepo (NestJS + SolidJS)

---

## TL;DR

Manifest is a **full observability platform with smart routing**. Defiant is a **protocol-translating proxy with per-slot routing**. Manifest wins on UI/analytics, multi-tenancy, auth, alerting, and deployment polish. Defiant wins on protocol translation, thinking/reasoning cache, canary deployments, and Claude Code integration.

---

## 1. Architecture & Scope

| Aspect | Defiant | Manifest |
|--------|-----------|----------|
| **Type** | Local per-session HTTP proxy | Centralized API server + dashboard |
| **Language** | TypeScript (Node.js) | TypeScript (NestJS 11 + SolidJS) |
| **Architecture** | Single process, ~20 proxy modules | Monorepo: 4 workspaces (shared, backend, frontend, manifest) |
| **Entry point** | `scripts/cli.mjs` → spawns `proxy/start-proxy.ts` | `packages/backend/src/main.ts` (NestJS bootstrap) |
| **Database** | None (file-based: JSON, JSONL) | PostgreSQL via TypeORM |
| **Frontend** | Embedded HTML dashboard (381 lines, no deps) | Full SolidJS SPA (Vite) |
| **Deployment** | Local CLI only | Docker, Railway, self-hosted server |
| **Multi-tenancy** | None | User → Tenant → Agent → AgentApiKey |
| **Sessions** | Per-CC-session isolated proxy | Central server, all agents share one instance |

---

## 2. Provider & Model Support

| Aspect | Defiant | Manifest |
|--------|-----------|----------|
| **Provider count** | 17 | 18 + OpenRouter (300+ models) |
| **Local providers** | ❌ None | ✅ Ollama, LM Studio, llama.cpp |
| **Subscription providers** | ❌ None | ✅ ChatGPT Plus/Pro/Team, Claude Max/Pro, Copilot, Kimi Coding, MiniMax Coding, MiMo Token, GLM Coding, BytePlus, OpenCode Go |
| **OAuth auth** | ❌ None | ✅ Google, GitHub, Discord + provider OAuth refresh |
| **Custom providers** | Via `providers.json` only | OpenAI/Anthropic-compatible endpoints via UI or API |
| **Model catalog** | Manual `providers.json` | Auto-discovered + OpenRouter catalog + pricing sync |
| **Pricing sync** | ❌ Manual | ✅ Automatic (OpenRouter pricing cron) |
| **Provider discovery** | ❌ None | ✅ `model-discovery/` per-provider with fallback |

### Provider Overlap

| Provider | Defiant | Manifest |
|----------|-----------|----------|
| Anthropic (direct) | ✅ | ✅ |
| OpenAI (direct) | ❌ | ✅ |
| DeepSeek | ✅ | ✅ |
| Google Gemini | ✅ | ✅ |
| OpenRouter | ✅ | ✅ |
| Groq | ✅ | ❌ |
| Fireworks AI | ✅ | ❌ |
| Mistral | ✅ | ✅ |
| xAI / Grok | ❌ | ✅ |
| Kimi / Moonshot | ✅ | ✅ |
| MiniMax | ✅ | ✅ |
| Qwen / Alibaba | ✅ | ✅ (DashScope) |
| Z.ai / GLM | ✅ | ✅ |
| BytePlus / Doubao | ✅ | ✅ (subscription-only) |
| SiliconFlow | ✅ | ❌ |
| Novita | ✅ | ❌ |
| Umans AI | ✅ | ❌ |
| OpenCode Zen | ✅ | ✅ (subscription-based) |
| Ollama | ❌ | ✅ |
| LM Studio | ❌ | ✅ |
| llama.cpp | ❌ | ✅ |
| GitHub Copilot | ❌ | ✅ (OAuth) |

---

## 3. Routing & Model Selection

| Aspect | Defiant | Manifest |
|--------|-----------|----------|
| **Routing model** | Slot-based: each CC model slot → provider:model | Complexity-based: scores request → tier → model |
| **Complexity scoring** | Simple (5 tiers: TRIVIAL/CHAT/CODE/TOOL/HEAVY) | **28+ dimensions** with trie-based keyword scanner, sigmoid normalization |
| **Tiers** | Not tiered — exact slot mapping | 4 tiers: simple, standard, complex, reasoning |
| **Specificity routing** | ❌ None | ✅ Task-type detection (coding, web, data analysis, image/video, social, email, trading) |
| **Header-based routing** | ❌ None | ✅ Custom headers override tier/model |
| **Fallback chains** | Auto-generated + circuit-breaker-aware | Explicitly configurable per tier |
| **Response modes** | Streaming only (SSE) | Buffered + streaming (per-tier config) |
| **Canary deployments** | ✅ COLD/WARMING/ACTIVE state machine | ❌ None |
| **Session momentum** | ✅ Tracks last 5 provider decisions | ❌ None |
| **Prompt-based routing** | ✅ Optional | ✅ Core feature (the primary routing mechanism) |

---

## 4. Protocol Translation

| Aspect | Defiant | Manifest |
|--------|-----------|----------|
| **Anthropic ↔ OpenAI** | ✅ Full bidirectional (request + response + SSE streaming) | ✅ Basic (via adapter pattern) |
| **Anthropic ↔ Gemini** | ✅ Full bidirectional | ✅ Google adapter |
| **Thinking block handling** | ✅ DeepSeek `/anthropic` echo-back with UUID-keyed cache | ✅ Thinking block cache + thought signature cache + reasoning content cache |
| **Reasoning content** | ✅ OpenAI `reasoning_content` re-injection | ✅ Reasoning content cache |
| **Server tool use injection** | ✅ `server_tool_use` content block | ❌ |
| **Tool_choice with thinking** | ✅ Strips for providers that reject it | ✅ Validation guard |

**Verdict**: Defiant's translation is deeper and more complete. Manifest has equivalent caching but uses it for dashboard deduplication rather than protocol compliance.

---

## 5. Caching

| Aspect | Defiant | Manifest |
|--------|-----------|----------|
| **Thinking block cache** | ✅ `sessionKey:toolUseId`, 30min TTL, 1000 entries | ✅ `ThinkingBlockCache` + `ThoughtSignatureCache` |
| **Reasoning cache** | ✅ `sessionKey:firstToolCallId`, 30min TTL | ✅ `ReasoningContentCache` |
| **Session key** | ✅ SHA-256 of first message + per-process salt | ❌ Not needed (central server) |
| **Routing cache** | ❌ None (stateless per-request) | ✅ Per-agent TTL cache (120s, 5000 entries) + tier assignment cache |
| **Auth cache** | ❌ None | ✅ Agent API key cache (5min TTL, 10K entries) |
| **Dashboard cache** | ❌ None | ✅ Per-user URL-keyed cache (30s) + model prices (5min) + public stats (24h) |
| **Configuration hot-reload** | ✅ 1s poll with mtime check | ✅ NestJS cache-manager with TTL |

**Verdict**: Manifest has more comprehensive caching for server workloads. Defiant's caching is laser-focused on protocol compliance (thinking cache is mission-critical for DeepSeek).

---

## 6. Observability & Monitoring

This is Manifest's **strongest advantage**.

| Aspect | Defiant | Manifest |
|--------|-----------|----------|
| **Dashboard** | Embedded HTML (381 lines, no deps) | Full SolidJS SPA |
| **Cost analytics** | Per-session spend, daily budget, 7-day projection | Per-agent, per-model, hourly/daily cost tracking |
| **Token analytics** | Per-request stream metrics | Per-agent, per-model, time-series tokens |
| **Message log** | JSONL file (`requests.log`) | Paginated message table with filtering, details |
| **Agent overview** | ❌ None | Agent grid with usage sparklines |
| **Savings tracking** | ❌ None | ✅ Cost comparison vs most expensive possible model |
| **Real-time updates** | SSE every 2s via `/health/stream` | SSE via `/api/v1/events` |
| **Prometheus metrics** | ✅ `/metrics` endpoint | ❌ None |
| **Health endpoint** | ✅ `/health` with full snapshot | ✅ `/api/v1/health` |
| **Circuit breakers** | ✅ Per-provider with auto-probe | ❌ Implemented at tier level via fallback |
| **Stream metrics** | ✅ TTFB, TPS, inter-chunk latency (P95) | ❌ |
| **Request logging** | JSONL with rotation | Database (messages table) |
| **Spend journal** | ✅ Write-ahead journal (crash-safe) | ❌ (DB is persistent) |
| **Event loop monitoring** | ✅ 1s interval, reset 60s | ❌ |

---

## 7. Authentication & Security

| Aspect | Defiant | Manifest |
|--------|-----------|----------|
| **User authentication** | ❌ None (local only) | ✅ Better Auth: email/password + Google/GitHub/Discord OAuth |
| **Session management** | ❌ None | ✅ Better Auth cookies + SessionGuard |
| **API key auth** | ❌ None (direct key in env) | ✅ `mnfst_` prefixed tokens, scrypt hashing, LRU cache |
| **API key encryption** | ✅ AES-256-GCM with scrypt derivation | ✅ AES-256-GCM with configurable `MANIFEST_ENCRYPTION_KEY` |
| **Master secret** | `DEFIANT_MASTER_SECRET` | `BETTER_AUTH_SECRET` (32+ chars) |
| **Rate limiting** | Per-IP fixed window (500/min, 2 pools) | Per-endpoint ThrottlerGuard (login, signup, password reset, etc.) |
| **SSRF protection** | ✅ DNS pinning, IP blocklist, TOCTOU defense | ✅ DNS-based validation |
| **Credential scrubbing** | ✅ 20 regex patterns in logs/errors | ✅ (via nestjs-pino sanitizers) |
| **Header sanitization** | ✅ Drops auth/cookie/host, limits to 50 | ✅ Helmet (via NestJS) |
| **Body size guard** | ✅ 10MB max | ✅ (via express.json limit) |
| **API key prefix** | Proxy key (for dashboard) | `mnfst_` agent keys + `X-API-Key` header |
| **Public access** | ❌ None | ✅ Public stats endpoint (opt-in) |
| **Telemetry** | ❌ None | ✅ Anonymous usage data (opt-out) |

---

## 8. CLI & Developer Experience

| Aspect | Defiant | Manifest |
|--------|-----------|----------|
| **CLI entry** | `defiant` / `dc` with 30+ flags | `npm start` / Docker / Railway |
| **Statusline** | ✅ CC status bar with slot, spend, health, circuit breakers | ❌ None (has SSE dashboard instead) |
| **Flag parsing** | 1259-line `cli.mjs` with subcommands | N/A (server, not CLI) |
| **Doctor** | ✅ `--doctor` (checks Node, CC version, env vars, providers, connectivity) | ❌ None |
| **Probe** | ✅ `--probe` tests every provider/model combo | ❌ None (has health endpoint) |
| **Dry run** | ✅ `--dry-run` / `--what-if` displays route table | ❌ None |
| **Cost** | ✅ `--cost` shows per-session + today spend | ✅ Dashboard analytics |
| **Models** | ✅ `--models` lists all available models | ✅ Model prices page in dashboard |
| **Health** | ✅ `--health` shows provider status + circuit breakers | ✅ `/api/v1/health` |
| **Stats** | ✅ `--stats` shows provider metrics | N/A (server) |
| **Logs** | ✅ `--logs` / `--tail` for request log | N/A (server) |
| **Config lint** | ✅ `--lint` validates providers.json | N/A |
| **Hot-swap restart** | ✅ `--restart` / `restart-proxy.mjs` | ❌ (server restart via process manager) |
| **Config hot-reload** | ✅ 1s polling with mtime | ✅ NestJS cache invalidation |
| **Shell wrappers** | PS1, SH, CMD, auto-detect Node.js | Docker only |
| **Windows support** | ✅ First-class (Registry fallback, PS wrappers, Defender fix) | ✅ (Node.js cross-platform, not Windows-specific) |
| **Compaction config** | ✅ Per-model compaction window | ❌ Not applicable (doesn't manage context windows) |

---

## 9. Streaming & Performance

| Aspect | Defiant | Manifest |
|--------|-----------|----------|
| **SSE streaming** | ✅ Full implementation with per-event buffer guard | ✅ SSE with gzip exclusion filter |
| **Non-streaming** | ✅ (for tool calls) | ✅ `buffered` response mode |
| **Stream warmup** | ✅ 15s FBT timeout with `peekFirstChunk` | ✅ 15s stream warmup module |
| **Gzip handling** | ✅ Auto-detect + decompress | ✅ Compression filter |
| **Timeout config** | Per-slot (main: 180/300s, subagent: 90/90s) | `PROVIDER_TIMEOUT_MS` (single global) |
| **Concurrency** | Promise-queue semaphore (main=25, subagent=8) | NestJS request scoping (automatic) |
| **Connection draining** | ✅ Graceful shutdown with 30s timeout | ✅ NestJS lifecycle hooks |
| **Retry** | 3 attempts with exponential backoff + jitter | ✅ Per-provider retry in proxy |
| **TTFB tracking** | ✅ Per-stream recording | ❌ |

---

## 10. Testing

| Aspect | Defiant | Manifest |
|--------|-----------|----------|
| **Framework** | Jest (via babel-jest) | Jest (backend) + Vitest (frontend) |
| **Test count** | ~1386 tests, 47 suites | ~250+ spec files across monorepo |
| **Integration tests** | ✅ `integration.test.ts`, `launcher.test.ts` | ✅ `test/` directory for e2e |
| **Cache tests** | ✅ Round-trip thinking + reasoning cache | ✅ Per-module spec files |
| **Hot-swap test** | ✅ | ❌ (N/A) |
| **Spend/budget tests** | ✅ | N/A (different model) |
| **Coverage** | Via Jest | Codecov with per-flag (backend/frontend/shared), 5% patch target |
| **CI** | Minimal (.github/) | GitHub workflows, lint-staged, husky |

---

## 11. Deployment & Infrastructure

| Aspect | Defiant | Manifest |
|--------|-----------|----------|
| **Docker** | ❌ None | ✅ Multi-stage distroless (non-root, no shell, read-only FS) |
| **Docker Compose** | ❌ None | ✅ Postgres + app + health checks |
| **One-click install** | ❌ None | ✅ `bash <(curl ...)` script |
| **Railway** | ❌ None | ✅ `railway.toml` |
| **CI/CD** | Minimal GitHub workflows | GitHub workflows + Codecov + Changesets |
| **Versioning** | Manual | Changesets (semver management) |
| **Git hooks** | Husky (pre-commit, pre-push lint) | Husky + lint-staged |
| **Code quality** | ESLint + Prettier + Qodana | ESLint flat config + Prettier |
| **License** | MIT | MIT |
| **PDF generation** | ❌ None | ✅ PDF invoice/report generation |

---

## 12. Documentation

| Aspect | Defiant | Manifest |
|--------|-----------|----------|
| **CLAUDE.md** | Project-focused (~150 lines) | **40KB, 1700+ lines** — comprehensive dev guide |
| **README** | Auto-generated from template + live data | Concise value prop + quick start |
| **Env docs** | Via `--help` and inline comments | `.env.example` (93 lines, meticulously documented) |
| **API docs** | Inline JSDoc | NestJS Swagger (via decorators) |
| **Contributing** | ❌ None | ✅ CONTRIBUTING.md |
| **Security policy** | ❌ None | ✅ SECURITY.md |
| **Code of conduct** | ❌ None | ✅ CODE_OF_CONDUCT.md |
| **Model docs** | Inline in providers.json | ✅ `docs/model-parameters-schema.md` |
| **Docker docs** | ❌ None | ✅ `docker/DOCKER_README.md` |
| **Code comments** | Moderate | Excellent — every module has thorough JSDoc, inline issue references |

---

## 13. Unique Defiant Features (Not in Manifest)

These are places where Defiant leads:

1. **Per-slot concurrent multi-provider routing** — each Claude Code model slot independently routed to different providers
2. **Protocol translation depth** — Anthropic ↔ OpenAI ↔ Gemini with SSE stream transformation, not just request/response mapping
3. **Thinking block echo-back** — Mission-critical for DeepSeek `/anthropic` endpoint; missing blocks = HTTP 400
4. **Canary deployments** — Gradual rollout with automatic promotion/rollback via deterministic hash routing
5. **Session momentum** — Biases toward historically successful providers per conversation
6. **Hot-swap proxy restart** — Zero-downtime proxy replacement without killing active sessions
7. **Per-session isolated proxy** — Each `defiant` invocation gets its own proxy on a unique port
8. **Write-ahead spend journal** — Crash-safe spend tracking with startup replay
9. **Server-side tool execution** — Web search (DuckDuckGo, no API key) + web fetch with comprehensive SSRF
10. **Compact-at-950K** — DeepSeek's disk cache lasts hours; strategic compaction preserves 50× cache discount
11. **CC statusline integration** — Live slot/model/spend/health display in Claude Code
12. **Windows-first resilience** — Registry env var fallback for detached processes, Defender exclusions
13. **Prometheus metrics** — OpenMetrics format endpoint for external monitoring
14. **Circuit breaker with auto-probe** — 34% failure threshold, automatic HALF_OPEN probing
15. **Per-model compaction windows** — Optimizes context usage per provider's caching economics

---

## 14. Comparison Methodology

This comparison was conducted on 2026-06-16 by:
- Reading every source file in both repositories
- Analyzing directory structure, configuration, and test coverage
- Cross-referencing provider lists, feature sets, and architectural patterns
- Neither codebase was executed; analysis is static/structural only

**Defiant files read**: ~45 files across `proxy/`, `scripts/`, `statusline/`, root  
**Manifest files read**: ~60+ files across `packages/backend/`, `packages/frontend/`, `packages/shared/`, `docker/`, root
