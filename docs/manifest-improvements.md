# Manifest Features Missing from DeepClaude — Prioritized Improvements

**Date**: 2026-06-16  
**Source**: `docs/manifest-comparison.md` (full comparison)

---

## Priority Legend

- 🔴 **P0 — Critical gap**: Actively hurts users or blocks use cases
- 🟠 **P1 — High impact**: Significant UX/capability improvement, moderate effort
- 🟡 **P2 — Nice to have**: Clear win but not urgent
- 🟢 **P3 — Future**: Long-term aspiration, high effort or low urgency

---

## Category: Observability & UI

### 🟠 P1 — Full analytics dashboard

**What Manifest has**: SolidJS SPA with cost/token/message analytics, agent overview, sparklines, time-series charts, filtering.

**What DeepClaude has**: 381-line embedded HTML dashboard (SSE every 2s). Shows health + recent requests + spend. No historical analytics.

**Why it matters**: Users can't see spending trends, per-model breakdowns, or agent-level usage. The embedded dashboard is functional for live health but useless for understanding costs over time.

**Suggested approach**:
1. Add a lightweight analytics page to the embedded dashboard (no framework — keep the zero-dep philosophy)
2. Parse `requests.log` for historical data
3. Read `cc-spend-*.json` files for per-session aggregation
4. Add simple uPlot or Chart.js from CDN for time-series charts
5. Add per-model cost breakdown and daily/weekly trends

**Effort**: Medium (3-5 days)  
**Risk**: Low — read-only aggregation of existing data

---

### 🟡 P2 — Savings tracking

**What Manifest has**: Shows cost vs. "what the most expensive model would have charged" — quantified savings.

**What DeepClaude has**: Shows spend. No comparison baseline.

**Why it matters**: The primary value prop of model routing is cost savings. Users can't see what they're saving.

**Suggested approach**: For each request, compute the cost if routed to the most expensive configured provider for that slot. Store the delta. Show cumulative savings in dashboard and `--cost`.

**Effort**: Small (1-2 days)  
**Risk**: Low — purely additive

---

### 🟡 P2 — Message log viewer

**What Manifest has**: Paginated message table with filtering, request/response inspection, cost attribution.

**What DeepClaude has**: `requests.log` JSONL file (viewable via `--logs`/`--tail`). No UI for browsing.

**Why it matters**: Debugging failed requests requires grepping a JSONL file. A simple log viewer in the dashboard would be much more accessible.

**Suggested approach**: Add a `/api/requests?page=N&limit=M` endpoint that reads and paginates the JSONL log. Add a simple table to the dashboard.

**Effort**: Medium (2-3 days)  
**Risk**: Low — read-only, existing data source

---

## Category: Authentication & Multi-Tenancy

### 🟢 P3 — Agent API key management

**What Manifest has**: `mnfst_`-prefixed agent keys with scrypt hashing, LRU cache, encryption at rest. Per-agent routing configs. User → Tenant → Agent hierarchy.

**What DeepClaude has**: Single API key per provider in `providers.json` or env var. No agent concept. Single-user only.

**Why it matters**: DeepClaude is fundamentally single-user local. This is a design choice, not a gap — adding multi-tenancy would be a different product. However, encrypted API key storage with a master secret is already partially implemented.

**Suggested approach**: Not recommended for now. DeepClaude's single-user local model is simpler and appropriate for its use case. If team features are ever needed, consider the Manifest model.

**Effort**: Very high (2-4 weeks)  
**Risk**: High — fundamental architecture change

---

### 🟡 P2 — Better API key encryption UX

**What Manifest has**: Seamless key encryption via `MANIFEST_ENCRYPTION_KEY`. Keys stored encrypted, decrypted on use.

**What DeepClaude has**: `crypto.ts` with AES-256-GCM + scrypt. `encrypt-key.ts` CLI tool. Manual setup required.

**Why it matters**: The encryption exists but requires manual CLI steps. Most users probably store keys in plaintext env vars.

**Suggested approach**:
1. On startup, check if `DEEPCLAUDE_MASTER_SECRET` is set
2. If yes, offer to encrypt any plaintext keys in `providers.json`
3. Add `--encrypt-keys` flag for explicit encryption
4. Document the flow in README

**Effort**: Small (1 day)  
**Risk**: Low — encryption code already exists

---

## Category: Provider Coverage

### 🟠 P1 — OpenAI direct provider

**What Manifest has**: Direct OpenAI API support (gpt-5, gpt-5-mini, o4, o4-mini).

**What DeepClaude has**: OpenAI models only via OpenRouter. No direct OpenAI API.

**Why it matters**: OpenAI is the largest provider. Users with OpenAI API keys can't use them directly — they must go through OpenRouter (which adds latency and cost). This is DeepClaude's most glaring provider gap.

**Suggested approach**: Add `oa` provider to `providers.json`. Wire format is `openai` (already supported). Auth is `bearer`. Add to context limits. This is mostly config + testing.

**Effort**: Small (few hours)  
**Risk**: Low — OpenAI format already fully supported via protocol translation

---

### 🟡 P2 — Local model support (Ollama)

**What Manifest has**: Ollama, LM Studio, llama.cpp — local models with no API key.

**What DeepClaude has**: No local model support. All providers are cloud APIs.

**Why it matters**: Offline usage, zero cost, privacy. Some users want to run coding models locally.

**Suggested approach**: Add `lo` provider for Ollama (`http://localhost:11434/v1/chat/completions`). OpenAI-compatible wire format. No auth needed. Add to context limits. The main challenge is quality — local models may not handle tool use well.

**Effort**: Medium (1-2 days)  
**Risk**: Medium — local model quality/compatibility varies; may need special handling for tool use

---

### 🟢 P3 — Subscription provider support

**What Manifest has**: OAuth-based ChatGPT Plus/Pro/Team, Claude Max/Pro, Copilot, Kimi Coding, MiniMax Coding, MiMo Token, GLM Coding, BytePlus, OpenCode Go subscriptions.

**What DeepClaude has**: API keys only. No subscription provider support.

**Why it matters**: Users paying for ChatGPT Plus or Claude Pro could use those subscriptions instead of paying for API tokens.

**Suggested approach**: Not recommended for now. OAuth flows are complex, require browser interaction, and the subscription provider APIs are undocumented/internal. DeepClaude's target user has API keys.

**Effort**: Very high (weeks, reverse-engineering)  
**Risk**: High — subscription APIs are unofficial and can break

---

### 🟡 P2 — xAI / Grok provider

**What Manifest has**: xAI (grok-4, grok-3, grok-code-fast).

**What DeepClaude has**: No xAI support.

**Why it matters**: Grok is gaining popularity for coding tasks. Easy to add since it's OpenAI-compatible.

**Suggested approach**: Add `xa` provider. Wire format: `openai`. Endpoint: `https://api.x.ai/v1`. Auth: `bearer`. Standard addition.

**Effort**: Trivial (minutes)  
**Risk**: Low

---

### 🟢 P3 — Provider auto-discovery

**What Manifest has**: `model-discovery/` module that fetches available models from each provider's API.

**What DeepClaude has**: Static `providers.json` — manual updates required.

**Why it matters**: New models appear frequently. Auto-discovery keeps the catalog fresh without manual updates.

**Suggested approach**: Add a `/v1/models` poll for OpenAI-compatible providers. Cache results. Show in `--models`. Not critical — provider model lists change slowly.

**Effort**: Medium (2-3 days)  
**Risk**: Low

---

## Category: Routing Intelligence

### 🟡 P2 — Richer request complexity scoring

**What Manifest has**: 28+ dimensions: keyword matching (trie-based), structural analysis (code blocks, length, nesting), conversation depth, momentum, formal logic indicators. Sigmoid normalization for confidence-calibrated tier assignment.

**What DeepClaude has**: 5 simple categories (TRIVIAL/CHAT/CODE/TOOL/HEAVY) based on character count + code block detection + tool count.

**Why it matters**: Better scoring = better routing = more cost savings without quality loss. DeepClaude's scoring is adequate but coarse.

**Suggested approach**:
1. Add keyword trie for domain detection (coding, math, creative, analysis)
2. Add conversation depth tracking (message count, turn complexity)
3. Add structural scoring (nesting depth, tool use chains)
4. Keep it lightweight — no ML dependencies
5. Expose scoring decisions in `--dry-run` and dashboard

**Effort**: Medium-High (3-5 days)  
**Risk**: Medium — scoring changes affect routing; needs A/B testing

---

### 🟡 P2 — Specificity detection (task-type routing)

**What Manifest has**: Detects task types from message content: coding, web browsing, data analysis, image/video generation, social media, email/calendar, trading.

**What DeepClaude has**: No task-type detection.

**Why it matters**: Different tasks benefit from different models. A coding-optimized model for code, a reasoning model for analysis. DeepClaude's slot-based routing partially addresses this but doesn't adapt to task type within a slot.

**Suggested approach**: Add lightweight keyword-based task detection. Expose as an optional routing dimension. Could integrate with prompt-router.

**Effort**: Medium (2-3 days)  
**Risk**: Low — optional, additive

---

### 🟢 P3 — Header-based routing

**What Manifest has**: Custom HTTP headers (`X-Manifest-Tier`, etc.) can override routing per-request.

**What DeepClaude has**: No header-based routing. Routing is configured statically or via prompt analysis.

**Why it matters**: Useful for agent frameworks that want control over model selection. Less relevant for Claude Code which uses slot names.

**Suggested approach**: Not a priority — Claude Code's slot system already provides this capability. Could be useful if DeepClaude ever serves non-CC clients.

**Effort**: Small (1 day)  
**Risk**: Low

---

## Category: Operations & Deployment

### 🟠 P1 — Docker support

**What Manifest has**: Multi-stage distroless Docker (node:24-alpine build → distroless nonroot runtime), Docker Compose with Postgres, one-line install script.

**What DeepClaude has**: No Docker support. Local Node.js only.

**Why it matters**: Docker is the standard deployment method. Users on Linux/Mac who don't have Node.js can't easily run DeepClaude. A Docker image would also enable cloud/VPS deployment.

**Suggested approach**:
1. Create a simple two-stage Dockerfile (build → slim runtime)
2. No database needed — just Node.js + proxy
3. Expose the proxy port
4. Mount `~/.deepclaude` for config persistence
5. Add `docker-compose.yml` for easy setup
6. Consider a one-line install: `bash <(curl ...)` like Manifest

**Effort**: Medium (2-3 days)  
**Risk**: Low — stateless, no DB dependencies

---

### 🟡 P2 — One-line installer

**What Manifest has**: `bash <(curl -sSL https://raw.githubusercontent.com/mnfst/manifest/main/docker/install.sh)`.

**What DeepClaude has**: Manual `npm install` + `npm link` setup. No installer.

**Why it matters**: Lower barrier to entry. Currently requires Node.js, npm, git clone, npm install, npm link.

**Suggested approach**: Write an install script that: checks Node.js >= 18, clones repo, runs npm install, links `deepclaude`/`dc` to PATH. Or publish to npm.

**Effort**: Medium (2 days)  
**Risk**: Low

---

### 🟡 P2 — Publish to npm

**What Manifest has**: Not on npm (monorepo, self-hosted). But Manifest is a server, not a CLI.

**What DeepClaude has**: Not published to npm. Manual clone + link.

**Why it matters**: `npm install -g deepclaude` would be dramatically simpler than the current setup. This is how CLI tools are distributed in the Node ecosystem.

**Suggested approach**: Add `bin` field to `package.json`, publish to npm. Automate with GitHub Actions on release.

**Effort**: Medium (1-2 days for setup + CI)  
**Risk**: Low

---

### 🟢 P3 — Changeset-based versioning

**What Manifest has**: Changesets for automatic semver management + changelog generation.

**What DeepClaude has**: Manual version bumps.

**Why it matters**: Cleaner release process. Not critical for a small project.

**Suggested approach**: Add `@changesets/cli`, configure GitHub Actions to publish on merge to main.

**Effort**: Small (few hours)  
**Risk**: Low

---

## Category: Alerting & Notifications

### 🟡 P2 — Budget alert notifications

**What Manifest has**: Threshold-based email alerts for token count, cost, error rate. Configurable rules. Email delivery via Resend/Mailgun/SendGrid.

**What DeepClaude has**: Budget caps (`DEEPCLAUDE_DAILY_BUDGET`, `--max-spend`) that reject requests. No notifications.

**Why it matters**: Users hit budget caps silently — requests just fail. A notification before hitting the cap would let them adjust.

**Suggested approach**:
1. Add configurable warning thresholds (already partially implemented via `DEEPCLAUDE_BUDGET_WARNING`)
2. On threshold breach, send desktop notification (simple, no email dependency)
3. Optionally: email via a configured SMTP provider
4. Show warning in statusline

**Effort**: Small (1-2 days)  
**Risk**: Low — desktop notifications via `node:child_process` + `notify-send`/`osascript`

---

### 🟢 P3 — Email alert delivery

**What Manifest has**: Full email notification pipeline with Resend/Mailgun/SendGrid integration.

**What DeepClaude has**: No email capability.

**Why it matters**: Only useful for unattended/CI usage. The statusline already provides live feedback for interactive use.

**Suggested approach**: Low priority. Desktop notifications + statusline cover the primary use case.

**Effort**: Medium (2-3 days)  
**Risk**: Low but adds dependency on email provider

---

## Category: Testing & Quality

### 🟡 P2 — E2E test suite

**What Manifest has**: Dedicated `test/` directory with e2e tests using supertest (HTTP-level testing of the NestJS app).

**What DeepClaude has**: Integration test (`integration.test.ts`) that tests the proxy end-to-end. Good but limited.

**Why it matters**: Catches regressions in the full request lifecycle. The current integration test is solid but could cover more scenarios.

**Suggested approach**:
1. Expand integration test with more provider format combinations
2. Add streaming-specific integration tests (SSE parsing, thinking block injection)
3. Add error recovery tests (provider failure → fallback)
4. Add canary state machine tests

**Effort**: Medium (2-3 days)  
**Risk**: Low

---

### 🟢 P3 — Codecov integration

**What Manifest has**: Codecov with per-package flags (backend/frontend/shared), 5% patch coverage target.

**What DeepClaude has**: Jest coverage (unpublished).

**Why it matters**: Coverage tracking in CI catches regressions. Nice to have.

**Suggested approach**: Add Codecov to GitHub Actions. Set modest targets.

**Effort**: Small (few hours)  
**Risk**: Low

---

## Category: Documentation

### 🟠 P1 — Comprehensive CLAUDE.md

**What Manifest has**: 40KB, 1700+ line CLAUDE.md covering: what the project is, full tech stack, directory walkthrough, dev setup (isolated DB per session), testing procedures, env var reference, API endpoint reference, auth architecture, multi-tenancy model, DB migration workflow, deployment, troubleshooting.

**What DeepClaude has**: ~100 line CLAUDE.md with key files, test commands, and quick reference. Good but not comprehensive.

**Why it matters**: The CLAUDE.md is the primary onboarding document for Claude Code. Manifest's version is the best I've seen — it's a complete development manual that makes the codebase instantly navigable.

**Suggested approach**: Expand CLAUDE.md with:
1. Architecture overview (data flow diagram in text)
2. Full directory walkthrough with file responsibilities
3. Protocol translation deep-dive
4. Cache key design rationale
5. Configuration reference (every env var, every config field)
6. Troubleshooting guide (common failure modes)
7. Development workflow (how to test a provider change, how to debug streaming)

**Effort**: Medium (1-2 days of writing)  
**Risk**: Low — documentation only

---

### 🟡 P2 — Contributing guide + security policy

**What Manifest has**: CONTRIBUTING.md, SECURITY.md, CODE_OF_CONDUCT.md.

**What DeepClaude has**: None of these.

**Why it matters**: Required for open-source maturity. Signals that the project is serious about community contributions and responsible disclosure.

**Suggested approach**: Write standard CONTRIBUTING.md and SECURITY.md based on Manifest's templates.

**Effort**: Small (few hours)  
**Risk**: Low

---

## Category: Configuration & DX

### 🟡 P2 — Config validation UI

**What Manifest has**: Config validation via NestJS class-validator decorators. Errors returned in API responses.

**What DeepClaude has**: `config-lint.ts` CLI tool (444 lines, 7 validation categories). Excellent but CLI-only.

**Why it matters**: The config linter is good. Adding a `/validate-config` endpoint and showing results in the dashboard would catch issues earlier.

**Suggested approach**: Expose `validateConfig()` result via `/health/config` endpoint. Show in dashboard.

**Effort**: Small (few hours)  
**Risk**: Low

---

### 🟡 P2 — Structured `.env.example`

**What Manifest has**: 93-line `.env.example` with every variable documented, grouped by category, with setup instructions and warnings.

**What DeepClaude has**: Env vars documented via `--help` and inline code. No `.env.example`.

**Why it matters**: Users setting up DeepClaude for the first time need to discover what env vars are available without reading source code.

**Suggested approach**: Create `.env.example` with all `DEEPCLAUDE_*` vars, grouped: required, provider keys, budget, behavior, debugging.

**Effort**: Small (1 hour)  
**Risk**: Low

---

### 🟢 P3 — Interactive setup wizard

**What Manifest has**: Multi-step agent setup wizard in the frontend.

**What DeepClaude has**: Manual config file editing. `--doctor` checks setup but doesn't guide it.

**Why it matters**: Lower barrier for first-time users. But DeepClaude's audience is technical.

**Suggested approach**: Add `deepclaude --setup` with interactive prompts for: provider API keys, slot model choices, budget limits. Writes `providers.json` and `slot-overrides.json`.

**Effort**: Medium (2-3 days)  
**Risk**: Low

---

## Category: Real-Time Features

### 🟢 P3 — SSE event bus for external clients

**What Manifest has**: `IngestEventBusService` + SSE at `/api/v1/events` for live dashboard updates.

**What DeepClaude has**: SSE at `/health/stream` (dashboard only). No external event bus.

**Why it matters**: Would allow external monitoring tools to consume DeepClaude events. Not critical — Prometheus metrics already serve this need.

**Suggested approach**: Expose a structured SSE endpoint at `/events` with typed events (request_start, request_end, circuit_breaker_change, budget_warning).

**Effort**: Medium (1-2 days)  
**Risk**: Low

---

## Summary: Top 10 Actions

| # | Priority | Action | Effort | Category |
|---|----------|--------|--------|----------|
| 1 | 🔴 P1 | **Add OpenAI direct provider** | Hours | Providers |
| 2 | 🔴 P1 | **Docker support** | 2-3 days | Deployment |
| 3 | 🔴 P1 | **Expand CLAUDE.md** | 1-2 days | Docs |
| 4 | 🟠 P1 | **Analytics dashboard** | 3-5 days | Observability |
| 5 | 🟡 P2 | **Savings tracking** | 1-2 days | Observability |
| 6 | 🟡 P2 | **Better key encryption UX** | 1 day | Auth |
| 7 | 🟡 P2 | **Add xAI provider** | Minutes | Providers |
| 8 | 🟡 P2 | **Budget alert notifications** | 1-2 days | Alerting |
| 9 | 🟡 P2 | **One-line installer + npm publish** | 2 days | Deployment |
| 10 | 🟡 P2 | **Message log viewer** | 2-3 days | Observability |

---

## What DeepClaude Should NOT Adopt from Manifest

These are Manifest features that are intentionally out of scope:

1. **Multi-tenant architecture** — DeepClaude is a local single-user tool. Adding users/tenants/agents would make it a different product.
2. **PostgreSQL/TypeORM** — File-based persistence is simpler and appropriate for local use. No DB to manage.
3. **NestJS framework** — Manifest is a server; DeepClaude is a CLI-spawned proxy. The zero-dependency approach is correct.
4. **Full SPA frontend** — The embedded dashboard serves debugging needs. A full SPA would be over-engineering.
5. **Subscription provider OAuth** — Complex, fragile, and targets a different user segment.
6. **OTLP ingestion** — DeepClaude doesn't collect agent telemetry; it's the telemetry source (Prometheus).
7. **Changesets** — Nice but unnecessary overhead for a single-package project.
