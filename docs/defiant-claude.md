# defiant-claude Go rewrite — project map & state

A from-scratch Go rewrite of the TypeScript `defiant-claude` proxy — a
provider-agnostic Claude Code proxy that routes Anthropic Messages API calls
to whatever provider you configure, with fallback chains and tier-matched
model rewrites.

## Layout

- Go module `github.com/Poiar/defiant-claude` at `C:\projects\defiant-claude`
  (pushed to GitHub `Poiar/defiant-claude`).
- Source of truth for the port: TS repo at `C:\projects\defiant-claude-old`
  (pushed to `Poiar/defiant-claude-old`). Read
  `proxy/providers.json` (provider registry), `proxy/routing.ts`
  (resolveTarget), `proxy/protocol-translate.ts` (wire translation),
  `proxy/protocol-types.ts` (PROVIDER_CONSTRAINTS, SSE helpers),
  `proxy/stats.ts` (circuit breaker), `proxy/canary.ts`, `proxy/momentum.ts`,
  `proxy/launcher.mjs` (Claude Code env), `proxy/start-proxy.ts` (server).

## Packages

- `internal/config` — `providers.json` → typed structs, embedded default,
  `~/.defiant-claude/providers.json` override, `Lint()`,
  `LoadSlotOverrides` (slot-overrides.json).
- `internal/routing` — pure resolver: slot detection, aliases, provider
  prefixes, tier-matched fallback chains. Unit-tested.
- `internal/proxy` — HTTP server: model rewrite, forward, SSE streaming,
  fallback loop, `/health` + `/metrics`, friendly E012 errors.
- `internal/wire` — anthropic↔openai translation (request + streaming +
  non-streaming + thinking injection) plus field stripping (metadata /
  billing-header / cache_control / dedup).
- `internal/crypto` — AES-256-GCM key encryption (`$aes256gcm:`, scrypt KDF),
  byte-compatible with the TS.
- `internal/resilience` — circuit breaker, session momentum, canary state
  machine, session-key hashing.
- `internal/envutil` — env lookup with Windows `HKCU\Environment` registry
  fallback: `Get(name)` (env → registry) and `Hydrate(names)` (bulk copy into
  the process env). Used by servertools (search config) and the CLI (provider
  API keys).
- `internal/servertools` — web_search/web_fetch execution: SearXNG (opt-in) +
  Brave + DDG + keyless ring (Exa/Parallel/Keenable/Wikipedia public free
  tiers, parallel fan-out + consensus merge) via an MCP JSON-RPC client; config
  via `envutil.Get`.
- `internal/ssrf` — outbound URL validation (private/loopback/link-local/CGNAT/
  metadata ranges; DNS-rebinding defense by pinning connections to validated
  IPs).

## Status

Feature parity reached for everything that applies to the Go design. Ported
and tested: config + slot overrides, routing, proxy, OpenAI wire translation
(request/stream/non-stream/thinking), field stripping, AES-256-GCM encryption,
circuit breaker + momentum + canary, health/metrics, friendly errors, launcher,
hot-reload (atomic snapshot swap), stream guards (first-byte / idle / 500MB
cap), per-provider retry + backoff/jitter, spend tracking + request logging,
concurrency limiting (25 chat / 8 subagent pools), prompt-router (tier
classification + max_tokens caps + cheap-model tier routing; CODE stays on the
primary), transport-error classification, server-side tools (web_search/
web_fetch with SSRF-safe https fetch; search chain SearXNG (opt-in) → keyless
ring [Exa/Parallel/Keenable/Wikipedia, parallel fan-out + consensus merge] →
Brave → DDG, in internal/ssrf + internal/servertools), and the launcher's
compaction-window env
(CLAUDE_CODE_AUTO_COMPACT_WINDOW).

Deliberately skipped (with reasons): Gemini wire format (dead-end gm provider);
thinking/reasoning/response caches (DeepSeek disk cache covers the main cost);
rate limiting (loopback-only, single tenant); header sanitizer + hot-swap
headers (Go builds fresh upstream requests, no restart-forward lifecycle);
pre-exec-validate/model-trust/skill-filter/truncate (deeper Claude Code-specific
behaviors); dashboard + notifications (/health + /metrics cover observability);
user-editable routes.json (routing consolidated into providers.json);
--status/--logs/--persist (needs a persistent proxy + log file).

Provider API keys are read by `routing.keyFromEnv` via `os.Getenv`; the CLI
hydrates the process env from `HKCU\Environment` at startup
(`hydrateEnvFromRegistry` in main.go/doctor.go) so keys stored as Windows User
env vars still authenticate from a stale shell (the same reason search config
uses the registry fallback).

## Provider wire formats (20 providers)

- `anthropic` pass-through: ds, fw, oc, um, an.
- `openai` (translated): or, oa, gr, xa, km, mm, mt, mx, za, bp, sf, nv, lo, al.
- `gemini` (not translated): gm — dead-end, skipped.

The default backend `ds` (DeepSeek) is anthropic pass-through.

## Build / test

    go build ./...
    go vet ./...
    go test ./...
    CGO_ENABLED=0 go build -o defiant-claude.exe ./cmd/defiant-claude   # static binary

CLI: `--version`, `--lint-config`, `--dry-run` (shows the resolved fallback
chain for model specs), `--encrypt-key`, `launch -b <backend> [--no-spawn]`
(spawns Claude Code against the in-process proxy by default).

## Search backends (internal/servertools)

Search is a fallback chain — each stage tried only when the previous returns
empty: SearXNG (opt-in) → keyless ring (parallel fan-out + merge) → Brave →
DDG instant-answer.

- **Keyless ring** (default, no key): the same public anonymous free tiers
  Hermes uses, ported from Hermes `plugins/web/keyless_mcp.py`, plus Wikipedia.
  All vendors run CONCURRENTLY (`keylessFanout`, 12s cap); results are deduped
  by normalized URL and ranked by cross-source consensus (more sources
  agreeing = higher, then per-source weight), capped to 5:
  - Exa `https://mcp.exa.ai/mcp` — MCP JSON-RPC `tools/call`, tool
    `web_search_exa`, args `{query, numResults}`; response is `---`-separated
    `Title:/URL:/Highlights:` text blocks.
  - Parallel `https://search.parallel.ai/mcp` — MCP `web_search`, args
    `{objective, search_queries, session_id}`; response JSON
    `{"results":[{"url","title","excerpts"}]}`.
  - Keenable `https://api.keenable.ai` — REST `POST /v1/search/public`
    `{query, max_results}`, header `X-Keenable-Title`.
  - Wikipedia `https://en.wikipedia.org/w/api.php` — MediaWiki `list=search`,
    no key.
  Firecrawl's keyless cloud is LATENT (code preserved, not in the ring): its
  `/v2/search` 403s anonymously (requires an API key). Re-add
  `{"firecrawl", firecrawlSearchKeyless}` to `keylessRing` if it recovers.
  Disable the whole ring with `DEFIANT_CLAUDE_KEYLESS_SEARCH=0`.
- **MCP call shape**: POST `{"jsonrpc":"2.0","method":"tools/call","params":
  {"name","arguments"}}`; response is plain JSON or SSE `data:` lines; extract
  the first `result.content[].text`; `error` and `result.isError` are failures.
- **Config is read from the Windows registry** via `envutil.Get` (env
  first, then `HKCU\Environment`). `DEFIANT_CLAUDE_SEARXNG_URL` is a FULL
  search prefix ending in `...q=` — append the query directly, do NOT append
  `/search?format=json&q=` again (the TS treated it as a full prefix; doubling
  the path breaks the URL).
- SearXNG is opt-in: `searchSearXNG` only runs when `DEFIANT_CLAUDE_SEARXNG_URL`
  is set (the three hardcoded public instances were removed — flaky + added
  latency). Opting in requires the SearXNG Docker image to be started and
  reachable (e.g. `searxng/searxng` on :8888) — the URL alone does nothing if
  the container is down; the stage returns empty and search falls through to
  the keyless ring, which is the reliable no-key path.

## Git

- Identity `poiarnoia <poiarnoia@proton.me>`; LF via `.gitattributes`
  (`* text=auto eol=lf`).
Pushed to GitHub `Poiar/defiant-claude`.
