# Rewriting a codebase in Go

## When to Use

Trigger when rewriting/porting an existing codebase to Go (a TypeScript/Node or
Python service), or continuing the defiant-claude Go rewrite. The port is
driven by an existing source of truth, not a green-field spec.

## Workflow

1. **Scaffold zero-dependency** — `go mod init <module>`; stay on the stdlib
   (`net/http`, `encoding/json`, `io`) rather than frameworks. Payoff: a single
   static binary and no module graph to maintain.
2. **Port layer-by-layer in dependency order**, testing each layer before the
   next: config (parse + lint) → pure logic (routing/resolution) → I/O
   (server, forwarding, streaming).
3. **Keep the resolution/routing layer pure** (no network I/O) so it is
   unit-testable in isolation — env-var key lookup is fine, network is not.
   This is what makes cheap regression tests possible.
4. **Verify each layer end-to-end before moving on**, not just unit tests. For
   a proxy: start it and hit it with curl (unresolvable model → 400, resolvable
   model → forward + stream). A real upstream 401 still proves routing +
   forwarding + streaming all work.
5. **Review and rework as you go** (standing user preference): do not port
   verbatim — make it smarter up front (e.g. `http.Transport` connection
   pooling instead of the source's manual keep-alive; `strings.Cut` instead of
   hand-rolled splitting), and redo anything that can be better. When the
   source has a fragile sub-feature (HTML scraping with bot-evasion workarounds,
   or a hack its own notes say broke), do NOT copy it — find the cleaner
   equivalent or the public mechanism underneath and build that instead.
6. **Read the reference source before declaring a feature not-portable.** A
   "keyless"/"free-tier" capability may look like it needs credentials you
   lack, but the source often reveals it is just a public anonymous endpoint.
   Verify the mechanism in the source instead of concluding "needs a key — skip."

## Go idioms

- **Embed static config/data with `go:embed`**, plus a user-override file (e.g.
  `~/.defiant-claude/providers.json`) read only when present.
- **JSON with `_comment` string keys** (metadata that does not fit typed maps):
  strip them with a recursive pass that descends only into JSON objects.
  PITFALL: check the first non-whitespace byte is `{` before recursing —
  `json.Unmarshal` into `map[string]json.RawMessage` turns a `null` value into
  `{}` on re-marshal, which then fails to unmarshal into a pointer field.
- **SSE streaming proxy**: one shared `http.Transport`
  (MaxIdleConns/MaxIdleConnsPerHost) for pooling; build the upstream request
  with `http.NewRequestWithContext(r.Context(), ...)` so a client disconnect
  cancels the upstream; copy the body and `Flusher.Flush()` after each read;
  strip hop-by-hop headers (Content-Length, Transfer-Encoding, Connection,
  Keep-Alive, Upgrade, Trailer, Te, Proxy-*) when copying the response.
- **Centralize alias/model expansion** in the resolver's terminal `resolve`
  function so every path expands aliases. PITFALL: expanding only the full
  model string misses the model-after-colon in a `provider:model` spec
  (`ds:v4` resolves "ds" correctly but sends model "v4" upstream).
- PITFALL: the `write_file`/`patch` auto-lint runs `go vet` from outside the
  module root, so it reports false "no required module provides package … go.mod
  file not found" errors. `go build ./...` from the module root is the source
  of truth — ignore that specific lint noise.
- PITFALL: `crypto/scrypt` and `crypto/pbkdf2` are NOT in the Go stdlib — only
  `crypto/hkdf`, `crypto/sha3`, `crypto/mlkem` were added. Password-based key
  derivation needs `golang.org/x/crypto/scrypt`; take that one dependency
  instead of hand-rolling scrypt.
- Porting a JS deterministic hash or percent-bucket: reproduce `x | 0` (32-bit
  signed truncation) with `int32` arithmetic. A 64-bit `int` does not wrap the
  way JS does, so the bucket/routing diverges from the original.
- **Windows config stored in `HKCU\Environment`** (User env vars, not just the
  shell): read `os.Getenv` first, then fall back to
  `exec.Command("reg", "query", "HKCU\\Environment", "/v", NAME)` and parse the
  `REG_SZ`/`REG_EXPAND_SZ` value. Go's `exec` passes args directly (no shell),
  so there is no MSYS path-mangling and no `x/sys` dependency. A stale shell
  (started before the var was set) won't have it in `os.Getenv`, which is why
  the registry fallback exists. In defiant-claude this is centralized in
  `internal/envutil` — `Get(name)` (env→registry) and `Hydrate(names)` (bulk
  copy missing vars into the process env at startup so downstream `os.Getenv`
  callers, e.g. `routing.keyFromEnv`, don't each need the fallback).

## Fallback chains

- Preserve the capability slot (`opus`/`sonnet`/`haiku`/`sub`/`fable`) into the
  resolved Target.
- Tier-match fallbacks: use the fallback provider's own config entry for the
  SAME slot, because different providers name the same model differently
  (`deepseek-v4-pro` on DeepSeek is `deepseek/deepseek-v4-pro` on OpenRouter).
  Only fall back to the identical model name when the slot is unknown.
- Retry on network error + `{408, 429, 500, 502, 503, 504}`; stream back
  non-retryable statuses as-is.

## Wire-format translation

- Request: translate the Anthropic body to the target format — `system` prompt
  → `system` message, `tool_use` blocks → `tool_calls`, `tool_result` blocks →
  `role:"tool"` messages carrying `tool_call_id`, `tools` → function defs, and
  set `stream_options.include_usage` when streaming.
- Response: translate a foreign SSE stream with a stateful `io.Reader` wrapper
  — NOT a goroutine/pipeline. Its `Read` consumes one source event, transforms
  it to native SSE, buffers the output, and serves it on the next `Read`, so it
  drops straight into the existing copy loop with trivial backpressure.
- Track a started/finished state machine and map `finish_reason` → `stop_reason`
  (`stop`→`end_turn`, `tool_calls`→`tool_use`, `length`→`max_tokens`). Wrap only
  2xx responses; pass non-2xx bodies through raw so upstream error JSON is not
  mangled.
- Prove the translation in-test with a mock upstream (`httptest.NewServer`) +
  `httptest.NewRecorder`, asserting BOTH that the upstream received the
  translated request shape and the client received the translated response.

## Key encryption (AES-256-GCM)

When the source encrypts API keys at rest, stay byte-compatible so existing
encrypted values still decrypt without a re-encrypt migration:
- `cipher.NewGCM`'s `Seal` returns `ciphertext || tag`; a format that stores
  the auth tag separately must split off `gcm.Overhead()` (16) bytes from the
  end before base64-ing each part.
- Reproduce the KDF exactly (scrypt N/r/p) and the string layout
  (`$aes256gcm:<salt>:<iv>:<tag>:<ciphertext>`, base64 each). An encrypted value
  embeds its own random salt, so any KDF change orphans every stored key.
- Cache derived keys by (master-secret, salt): scrypt is ~150 ms per call, so
  re-deriving per request adds avoidable latency.

## Adaptive routing (circuit breaker, momentum, canary)

A static fallback chain is only the base; the source's "smart" behavior is
three in-memory state machines layered on top:
- Circuit breaker: per-provider CLOSED/OPEN/HALF_OPEN. Open when the non-429
  failure rate crosses a threshold (e.g. ≥34%) with enough requests to judge
  (e.g. ≥5). Treat 429 as healthy — counting rate-limits as failures inflates
  the failure rate and falsely trips the breaker. After a cooldown, send one
  HALF_OPEN probe; success closes, failure re-opens with a doubled cooldown.
  Block production traffic while OPEN and HALF_OPEN (the probe is the test).
- Momentum: a per-session-key ring buffer of recent successful decisions;
  reorder fallbacks toward the provider that has been working, only when
  confidence is high (e.g. ≥0.4) and that provider is still healthy.
- Canary: per-slot COLD→WARMING→ACTIVE for gradual rollouts; gate WARMING
  traffic by a hash percentage bucket so a given request always maps to the
  same provider, promote on consecutive successes, roll back on an error spike.
- Hash determinism matters: the body→bucket hash must be ported exactly (see
  the int32 rule above) or rollout percentages shift.

## References

- [`docs/defiant-claude.md`](defiant-claude.md) — the defiant-claude Go rewrite:
  package map, provider/wire-format breakdown, and current state. Read it before
  continuing that project.
