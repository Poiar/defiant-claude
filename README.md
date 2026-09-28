# defiant-claude (Go)

Provider-agnostic proxy for Claude Code — routes Anthropic Messages API calls to
whatever model provider you configure (DeepSeek, OpenRouter, Groq, xAI, Ollama,
OpenCode, …), with automatic fallback chains and tier-matched model rewrites.

A from-scratch Go rewrite of the TypeScript `defiant-claude` proxy, with **zero
external dependencies** (pure stdlib) and a single static binary.

## Status

Foundation + proxy core done:

- [x] Config model — `providers.json` → typed structs + loader + lint
- [x] Routing resolver — slot detection, aliases, provider prefixes, tier-matched fallback chains
- [x] Proxy server — model rewrite, forwarding, SSE streaming, fallback loop
- [x] CLI — `--version`, `--lint-config`, `--dry-run` (shows fallback chain), `launch`
- [x] Wire-format translation — OpenAI (request + SSE streaming); Gemini pending
- [ ] Key encryption (AES-256-GCM)
- [ ] Caches, momentum, circuit breaker, canary
- [ ] Metrics, dashboard, notifications, statusline
- [ ] Launcher (spawn Claude Code with the proxy env)

## Build

    go build ./cmd/defiant-claude

## Run

    defiant-claude launch -b ds     # prints PORT:<n>

## Test

    go test ./...
