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
- [x] Wire-format translation — OpenAI (request + streaming/non-streaming + thinking injection)
- [x] Field stripping — metadata/billing-header/cache_control/dedup for upstream cache stability
- [x] Key encryption — AES-256-GCM (`$aes256gcm:`, scrypt KDF, `--encrypt-key`)
- [x] Circuit breaker — CLOSED/OPEN/HALF_OPEN, 429-immune, probe recovery
- [x] Session momentum — provider preference reordering
- [x] Canary rollout state machine — COLD/WARMING/ACTIVE
- [x] Health + Prometheus metrics — `/health`, `/metrics`
- [x] Friendly errors — E012 fallback-exhausted responses
- [x] Spend tracking + request logging — per-provider token counts + USD cost
- [x] CLI — `--version`, `--lint-config`, `--dry-run`, `--encrypt-key`, `launch`
- [x] Launcher — spawns Claude Code against the in-process proxy
- [ ] Gemini wire format (1 dead-end provider: `noAutoFallback`, no configs)
- [ ] Thinking/reasoning caches, dashboard, notifications

## Build

    go build ./cmd/defiant-claude

## Run

    defiant-claude launch -b ds           # start proxy + spawn Claude Code
    defiant-claude launch --no-spawn      # proxy only, prints PORT:<n>

## Test

    go test ./...
