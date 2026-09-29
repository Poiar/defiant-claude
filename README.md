# defiant-claude (Go)

Provider-agnostic proxy for Claude Code — routes Anthropic Messages API calls to
whatever model provider you configure (DeepSeek, OpenRouter, Groq, xAI, Ollama,
OpenCode, …), with automatic fallback chains and tier-matched model rewrites.

A from-scratch Go rewrite of the TypeScript `defiant-claude` proxy, with one
external dependency (`golang.org/x/crypto` for scrypt key derivation — matching
the TS encrypted-key format) and a single static binary.

## Status

Near parity with the TypeScript proxy:

- [x] Config model — `providers.json` → typed structs + loader + lint
- [x] Routing resolver — slot detection, aliases, provider prefixes, tier-matched fallback chains
- [x] Slot overrides — `~/.defiant-claude/slot-overrides.json`
- [x] Hot reload — watches `providers.json` + `slot-overrides.json`, swaps config atomically
- [x] Proxy server — model rewrite, forwarding, SSE streaming, fallback loop
- [x] Stream guards — first-byte timeout, idle watchdog (180s), 500MB body cap
- [x] Retry — per-provider retry with exponential backoff + full jitter
- [x] Concurrency limiting — per-slot in-flight caps (25 chat / 8 subagent)
- [x] Prompt router — tier classification, `max_tokens` caps, cheap-model routing (CODE stays on primary)
- [x] Transport-error classification — DNS/TLS/timeout labels in logs
- [x] Server-side tools — web_search/web_fetch + SSRF-safe fetch; search = SearXNG → keyless ring (Exa/Parallel/Firecrawl/Keenable) → Brave → DDG
- [x] Wire-format translation — OpenAI (request + streaming/non-streaming + thinking injection)
- [x] Field stripping — metadata/billing-header/cache_control/dedup for upstream cache stability
- [x] Key encryption — AES-256-GCM (`$aes256gcm:`, scrypt KDF, `--encrypt-key`)
- [x] Circuit breaker — CLOSED/OPEN/HALF_OPEN, 429-immune, probe recovery
- [x] Session momentum — provider preference reordering
- [x] Canary rollout state machine — COLD/WARMING/ACTIVE
- [x] Health + Prometheus metrics — `/health`, `/metrics`
- [x] Friendly errors — E012 fallback-exhausted responses
- [x] Spend tracking + request logging — per-provider token counts + USD cost
- [x] CLI — `--version`, `--lint-config`, `--dry-run`, `--doctor`, `--encrypt-key`, `launch`
- [x] Launcher — spawns Claude Code against the in-process proxy
- [x] Compaction window — sets `CLAUDE_CODE_AUTO_COMPACT_WINDOW` to preserve DeepSeek's disk cache

## Not ported (deliberate)

- **Gemini wire format** — the `gm` provider is a dead end (`noAutoFallback`, no configs).
- **Thinking / reasoning / response caches** — marginal for a single-user proxy; DeepSeek's free disk cache already covers the main cost.
- **Rate limiting** — the proxy binds to loopback only (single tenant), so per-IP limits are moot.
- **Header sanitizer / hot-swap headers** — the proxy builds fresh upstream requests and never forwards client headers (beta headers are already stripped), and there is no restart-forward lifecycle.
- **Pre-exec-validate / model-trust / skill-filter / truncate** — deeper Claude Code-specific behaviors (native web_search result-format validation, tool-use trust gating, skill filtering, body-log truncation).
- **Dashboard / notifications** — `/health` + `/metrics` cover observability.
- **User-editable `routes.json`** — the TS used a separate `routes.json` for model→provider mapping; the Go rewrite consolidates that into `providers.json` (configs/aliases/slots). Tier-routing defaults are hardcoded (disable via `DEFIANT_CLAUDE_PROMPT_ROUTER=0`).
- **`--status` / `--logs` / `--persist`** — needs a persistent proxy + log file; the proxy runs in-process with `launch`.

## Build

    go build ./cmd/defiant-claude

## Run

    defiant-claude launch -b ds           # start proxy + spawn Claude Code
    defiant-claude launch --no-spawn      # proxy only, prints PORT:<n>

## Test

    go test ./...
