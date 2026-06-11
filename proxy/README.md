# DeepClaude Proxy

HTTP reverse proxy that routes Claude Code to cheap third-party backends. Provider-agnostic — mix models from different APIs in one config. 14 providers, 35 named configs, 617 tests.

## Architecture

```
deepclaude.ps1 / deepclaude.sh          [Launcher — CLI parsing, lifecycle]
  |
  v
proxy/start-proxy.ts                    [HTTP server on :3200]
  |
  +-- routing.ts                        [Slot-based route resolution]
  +-- forward.ts                        [Upstream HTTP + SSE streaming]
  +-- protocol-translate.ts             [Anthropic ↔ OpenAI wire format]
  +-- stats.ts                          [Circuit breakers, spend tracking]
  +-- config.ts                         [Hot-reload config watcher]
  +-- server-tools.ts                   [DuckDuckGo search, SSRF-safe web fetch]
  +-- canary.ts                         [Gradual provider rollout]
  +-- momentum.ts                       [Session-based provider stickiness]
  +-- prompt-router.ts                  [Request complexity → cheap provider]
  +-- startup-check.ts                  [Pre-acceptance health probes]
  +-- dashboard.ts                      [SSE health dashboard + /metrics]
  +-- thinking-cache.ts                 [Anthropic thinking block cache]
  +-- reasoning-cache.ts                [OpenAI reasoning content cache]
```

## Key Features

- **Slot-based routing**: opus, sonnet, haiku, subagent, fable — each maps to a provider:model pair
- **Fallback chains**: automatic provider failover with per-provider retry + exponential jitter backoff
- **Circuit breakers**: auto-open on failure rate >34%, auto-probe recovery with cooldown backoff
- **Canary rollouts**: per-slot per-model gradual deployment with error-rate rollback
- **Protocol translation**: Anthropic Messages ↔ OpenAI Chat Completions, bidirectional
- **SSRF protection**: DNS resolution + IP validation against 8 blocked ranges
- **Stream guards**: 180s heartbeat, 15s first-byte timeout, 300s read timeout, 500MB total cap
- **Cache-aware pricing**: Tracks DeepSeek disk cache hit/miss tokens (cache hits ~$0.0036/M vs $0.435/M miss)
- **Server-side tools**: Web search (DuckDuckGo) and web fetch with SSRF validation
- **Spend tracking**: Per-provider, per-model with atomic writes and write-ahead journal crash recovery
- **Prometheus /metrics**: Counters and gauges for uptime, memory, concurrency, per-provider stats
- **Health dashboard**: Self-contained HTML + SSE stream, optional auth key

## DeepSeek Cache Economics

DeepSeek's API has a free disk cache that persists hours-to-days (no fixed TTL). Cache hits are ~50× cheaper than misses. The proxy passes request bodies through unchanged, so DeepSeek's prefix matching works perfectly — typically **98%+ cache hit rate** on long sessions.

**compactionWindow**: DeepSeek models have a 950K compaction threshold (vs. the normal 160K). This preserves cache hits by pushing compaction near the context wall — compaction rewrites history, invalidating the disk cache prefix and causing expensive cache misses.

## Quick Start

```
dc                      # Launch with DeepSeek (default)
dc -b ds+oc             # DeepSeek + OpenCode subs
dc --persist            # Keep proxy running between sessions
dc --doctor             # Full system check
dc --status             # Show config, keys, slots
dc --logs               # Tail proxy log
dc --dashboard --open   # Health dashboard in browser
```

## Config

All provider definitions, pricing, context limits, and slot mappings are in a single file: [`proxy/providers.json`](providers.json).

```
providers.json:
  providers:      14 provider definitions (endpoint, auth, wire format, fallbacks)
  contextLimits:  40+ model context window sizes
  compactionWindow: Per-model compaction thresholds
  configs:        35 named configs (slot → provider:model)
  aliases:        12 model aliases
  pricing:        30+ pricing entries (input/output, cache hit/miss for DeepSeek)
```

## Running Tests

```sh
npm test              # 35 suites, 617 tests
npm run test:coverage
```
