# Defiant Claude

<!-- AUTO:tagline -->
<!-- /AUTO:tagline -->

## Architecture

Defiant runs a local HTTP routing proxy that intercepts Claude Code's Anthropic API calls and dispatches each model slot (Opus, Sonnet, Haiku, subagent) to a different upstream provider.

**Direct DeepSeek (`ds`) uses the `/anthropic` endpoint** — DeepSeek offers an Anthropic-compatible API surface that speaks Claude's protocol natively. The proxy passes messages through unchanged: no format translation, no content flattening, no lossy conversion. Thinking mode (`{type: "enabled", budget_tokens: N}`), structured content blocks, tool use, and streaming all work without transformation. OpenAI-format translation only activates when routing through third-party providers (OpenRouter, Kimi, Mistral, etc.) that don't offer an Anthropic-compatible endpoint.

**Thinking block echo** — When DeepSeek's thinking mode is enabled, every assistant response that contains a tool_use also includes a `thinking` block. DeepSeek requires these thinking blocks to be echoed back verbatim in every subsequent request — if missing, it returns HTTP 400 ("content[].thinking must be passed back to the API"). The proxy's `thinking-cache.ts` handles this automatically: it extracts thinking blocks from responses, caches them keyed by `sessionKey:toolUseId` (the tool_use UUID is globally unique, so no conversation fingerprint is needed), and re-injects them into the next request before forwarding. **Caches now persist to `~/.defiant/thinking-cache/` and survive proxy restarts** — kill+resume no longer burns cache-miss tokens at 120× cost. Same pattern applies to reasoning content via `reasoning-cache.ts` and provider momentum via `momentum.ts`.

### Proxy modules (`proxy/`)

<!-- AUTO:modules -->
<!-- /AUTO:modules -->

### Data-driven provider registry

The proxy and CLI read from `proxy/providers.json`. The launcher (`proxy/launcher.mjs`) generates `~/.defiant/current-routes.json` from it, which the proxy and `statusline.mjs` load at runtime. Config resolution, route construction, and context-limit lookups are centralized in `proxy/launcher.mjs` — a zero-dependency Node.js module shared by `defiant.ps1`, `defiant.sh`, and `scripts/cli.mjs`. This eliminates duplicated provider, config, and context-limit definitions across languages and guarantees behavioral parity.

<!-- AUTO:providers-schema -->
<!-- /AUTO:providers-schema -->

### Launcher scripts

**`scripts/cli.mjs`** is the single entry point (Node.js) — handles all flag parsing, config resolution, proxy launch, and CC spawn. All subcommands (`--status`, `--models`, `--cost`, `--doctor`, `--dry-run`, etc.) are dispatched from here.

- **`defiant.ps1`** — 15-line PowerShell wrapper, just resolves Node.js and invokes `node scripts/cli.mjs @args`
- **`defiant.sh`** — 10-line Bash wrapper, `exec node scripts/cli.mjs "$@"`

Config resolution, routes JSON construction, env var computation, slot/thinking overrides, and context window calculation live in **`proxy/launcher.mjs`** — a zero-dependency Node.js module shared across all entry points. This eliminates the ~1800 lines of duplicated PS1/SH logic and guarantees behavioral parity across platforms.

### Test coverage

<!-- AUTO:test-coverage -->
<!-- /AUTO:test-coverage -->

### Pre-commit

Husky v9 + lint-staged: syntax check on staged files, TypeScript compilation guard.

### Web Search

Defiant intercepts web search requests BEFORE they reach any model provider. Claude Code's WebSearch harness sends `web_search_20250305` tool requests — the proxy runs DuckDuckGo locally and returns results inline, bypassing the model entirely.

```
CC sends: {tools: [{type: "web_search_20250305"}], messages: [{text: "Perform a web search for the query: ..."}]}
    ↓
Proxy intercepts (before routing) → extracts query → searches DDG
    ↓
Returns Anthropic-native web_search_tool_result with:
  - Proper content blocks CC counts for "Did N searches"
  - server_tool_use.web_search_requests in usage
  - claude-* trusted model name
```

**Why this matters**: Non-Anthropic providers (DeepSeek, OpenAI) don't execute web searches server-side. They'd only return `tool_use` blocks — CC would show "Did 0 searches." Pre-execution makes web search work identically across all 18 providers.

**Five-layer defense against regressions**:
1. Type system (`protocol-types.ts`) — `web_search_tool_result`, `caller`, `web_search_result` types
2. Response validator (`pre-exec-validate.ts`) — checks ALL required fields before sending (both stream + non-stream)
3. Integration tests — exact format assertions against real proxy
4. Unit tests — 25 validation test cases
5. Search-debug skill (`/search-debug`) — live diagnostics

See [[web-search-tool-result-format]] and [[web-search-guardrails]] for the exact protocol format.

## Quick start

```
# Get a DeepSeek API key: https://platform.deepseek.com

setx DEEPSEEK_API_KEY "sk-your-key"          # Windows
export DEEPSEEK_API_KEY="sk-your-key"        # macOS/Linux

# Option 1: npm link (creates global defiant command)
npm install -g .

# Option 2: Add repo directory to PATH manually
# Windows: setx PATH "%PATH%;C:\path\to\defiant"
# macOS/Linux: export PATH="$PATH:/path/to/defiant"

defiant                                    # Launch with DeepSeek V4 Pro
dc                                            # Shortcut — same as defiant (Windows: dc.cmd, macOS/Linux: alias)
```

## Requirements

- **Windows:** PowerShell 7+ ([download](https://github.com/PowerShell/PowerShell))
- **macOS/Linux:** bash 4+, jq, netcat (nc), Node.js 18+
- Node.js 18+ (for the proxy)

## Scripts

```
npm run verify          # Full verification: tests + lint
npm run restart-proxy   # Hot-swap to a new proxy (old forwards, dies when drained)
npm run build:readme    # Regenerate README.md from template
npm test               # Run test suite
```

## Usage

### Named configs (`-b`)

```
<!-- AUTO:named-configs -->
<!-- /AUTO:named-configs -->
```

### Ad-hoc positional configs

Pass 1–5 `providerKey:modelId` specs. Each spec is assigned to consecutive slots:

| Specs | Opus | Sonnet | Haiku | Subagent | Fable |
|-------|------|--------|-------|----------|-------|
| 1 spec | spec 1 | spec 1 | spec 1 | spec 1 | spec 1 |
| 2 specs | spec 1 | spec 1 | spec 1 | spec 2 | spec 2 |
| 3 specs | spec 1 | spec 2 | spec 2 | spec 2 | spec 3 |
| 4 specs | spec 1 | spec 2 | spec 3 | spec 4 | spec 4 |
| 5 specs | spec 1 | spec 2 | spec 3 | spec 4 | spec 5 |

Slot order: opus, sonnet, haiku, subagent, fable. When you provide fewer specs than slots, the last spec fills all remaining slots.

```
defiant ds:deepseek-v4-pro                                              # 1 spec → all 5 slots
defiant ds:deepseek-v4-pro oc:big-pickle                                # 2 specs → opus/sonnet/haiku=ds, sub/fable=oc
defiant ds:deepseek-v4-pro oc:big-pickle or:z-ai/glm-4.5-air:free       # 3 specs → opus=ds, sonnet/haiku/sub=oc, fable=or
defiant ds:deepseek-v4-pro ds:deepseek-v4-pro oc:big-pickle or:z-ai/glm-4.5-air:free  # 4 specs → sub/fable share last
defiant ds:deepseek-v4-pro ds:deepseek-v4-pro oc:big-pickle or:z-ai/glm-4.5-air:free mm:mimo-v2.5-pro  # 5 specs → direct 1:1
```

### Flags

```
<!-- AUTO:flags -->
<!-- /AUTO:flags -->
```

## Providers and API keys

<!-- AUTO:providers-table -->
<!-- /AUTO:providers-table -->

Keys are read from both process env and machine/user environment variables.

<!-- AUTO:openai-note -->
<!-- /AUTO:openai-note -->

## Provider fallback

Providers can specify a `fallback` list — if the primary provider fails (500, 429, timeout, dead stream), the proxy automatically retries with the fallback:

```
<!-- AUTO:fallback-list -->
<!-- /AUTO:fallback-list -->
```

Fallbacks are configured per-provider and transparent to Claude Code. Max 3 attempts per request.

## Named configs reference

```
<!-- AUTO:configs-reference -->
<!-- /AUTO:configs-reference -->
```

Note: `al` (Alibaba/DashScope) is only available via ad-hoc config and fallback, not as a named `-b al` config.

## Slot overrides (`--set-slot`)

Override individual model slots without changing configs. Survives config switches.

```
defiant --set-slot haiku or:z-ai/glm-4.5-air:free   # Set haiku to a free OR model
defiant --set-slot subagent oc:big-pickle            # Set subagent to OpenCode
defiant --set-slot sonnet                            # Clear override (reverts to config default)
```

Overrides are stored in `~/.defiant/slot-overrides.json`. The proxy reloads them on every request — changes take effect immediately in a running session.

Within Claude Code, you can switch the **opus** model directly:
```
/model oc:big-pickle               # Switch opus to OpenCode
/model or:z-ai/glm-4.5-air:free    # Switch opus to a free OR model
```

## Context window limits

Per-model context limits are configured automatically:

<!-- AUTO:context-table -->
<!-- /AUTO:context-table -->

Models at 1M tokens get `CLAUDE_CODE_AUTO_COMPACT_WINDOW` set (clamped to 1,000,000 — Claude Code's internal max). Models between 128K–1M get `CLAUDE_CODE_MAX_CONTEXT_TOKENS` with compaction disabled. A `[1m]` suffix is appended to 1M-context model IDs (e.g. `deepseek-v4-pro[1m]`) — this is stripped by the proxy's router and used internally by Claude Code for dynamic context-window detection.

DeepSeek V4 models use a `compactionWindow` of 950K tokens to preserve automatic disk cache hits. Compaction rewrites conversation history, which invalidates the prefix and forces an expensive cache miss ($0.435/M). By delaying compaction to 950K (near the 1M wall), most requests stay within the same prefix and hit the disk cache at $0.0036/M — a 120× discount. The cache persists for hours to days and requires no configuration.

### Cost optimization (defaults)

The default config is **`ds+oc`** (DeepSeek for opus/sonnet/fable, free OpenCode for haiku/subagent). Prompt-router sends TRIVIAL requests (greetings, `<50` char) to free providers automatically. A **$25/day budget cap** is on by default — set `DEFIANT_DAILY_BUDGET=0` to disable. Provider fallback chains prefer free tiers: `ds → oc → um → or`.

## Per-session proxy design

Each `defiant` invocation starts its own isolated proxy on a unique port. The proxy lives only as long as the CC session — when CC exits, the proxy is killed. There is no shared proxy, no PID lock, and no `--persist`/`--switch`/`--stop-proxy` flags.

**Hot-swap:** To restart the proxy mid-session, write the new port to `~/.defiant/next-proxy.port`, start a new proxy on that port (detached, with `--port <N>`), and the old proxy detects the signal and enters forwarding mode. It forwards all traffic to the new proxy and exits when all client connections drain. Then restart CC to pick up the new proxy.

```
defiant                                    # Starts isolated proxy on a random port

# Mid-session slot/model changes (use in CC):
/model oc:big-pickle                         # Switch opus to OpenCode
/model or:z-ai/glm-4.5-air:free              # Switch opus to a free OR model

defiant --set-slot haiku oc:big-pickle    # Change just the haiku slot (from another terminal)
defiant --models                          # List all available models
```

State files live in `~/.defiant/`:
<!-- AUTO:state-files -->
<!-- /AUTO:state-files -->

## Remote control (`--remote`)

```
defiant --remote                 # Default config via proxy
defiant --remote -b ds+oc        # Named config
defiant --remote ds:deepseek-v4-pro oc:big-pickle  # Ad-hoc
defiant --remote -b anthropic    # Anthropic direct
```

Starts the routing proxy, prints a `claude.ai/code/session_...` URL. Works on phone, tablet, any browser. Proxy auto-stops on exit.

## Doctor

System health check — verifies Node.js, proxy script, state directory, API keys, slot overrides, and runs a proxy startup test:

```
defiant --doctor
```

## Statusline

Shows the real model, provider, context usage, effort level, and git branch — with slot override resolution so you see what's actually running.

![Statusline preview](assets/statusline-preview.png)

| Color | Element | Source |
|---|---|---|
| `#64B4FF` Light blue | Directory name | `d.workspace.current_dir` last segment |
| `#FF50B4` Pink | Git branch | `git rev-parse --abbrev-ref HEAD` |
| `#C864FF` Purple | Slot + model | Slot label (`o`/`s`/`h`/`sub`/`f`) + resolved model ID |
| `#FF5050` Red / `#FFB432` Orange / `#64A0FF` Blue | Effort | `max`/`high` (red), `medium` (orange), `low` (blue) |
| `#50C878` Green / `#FFB432` Orange / `#FF5050` Red | Context usage | Token count + percent — green ≤50%, orange 50–79%, red ≥80% |
| `#FFD250` Gold | Session spend | Current Claude Code session cost from `~/.defiant/spend.json` |
| `#787878` Gray | Today spend | Daily total (shown when it exceeds session spend) |

The context gauge shows `tokens/percent` (e.g. `45k/5%` when the max is known). DeepSeek V4 Pro appends milestone tags: **SR** (300K+, purple) and **FBR** (400K+, magenta). Circuit breakers show **✕** (open, red), **◐** (half-open, orange), or **·** (closed, green). A recent fallback appends **↳**provider (orange).

```
# All platforms (Node.js)
1. Copy statusline/statusline.mjs → ~/.claude/statusline.mjs
2. Add to ~/.claude/settings.json:

  { "statusLine": { "type": "command", "command": "node ~/.claude/statusline.mjs" } }
```

Resolves slot overrides from `~/.defiant/slot-overrides.json` and context limits from `~/.defiant/current-routes.json`, so the token gauge and model display always reflect reality.

Tip: `defiant --install-statusline` automates the manual setup above.

## Environment

<!-- AUTO:env-vars -->
<!-- /AUTO:env-vars -->

All provider API key env vars (see [Providers table](#providers-and-api-keys)) are pushed into the process so the proxy (child process) inherits them.

## Windows Defender

The proxy starts a local HTTP server and forwards requests — Windows Defender often flags this as suspicious behavior and may **delete or quarantine** the proxy files. This is a catch-22: if defiant is deleted, you can't run `defiant --fix-av`.

**defiant writes a standalone rescue script on every launch:** `~/.defiant/fix-av.cmd`. Even if AV deletes the entire defiant directory, this file survives (it lives in your home directory, not near any executables). Run it as **administrator**:

```
~/.defiant/fix-av.cmd
```

Alternatively, run these commands manually in an admin PowerShell window:

```
Add-MpPreference -ExclusionPath "C:\path\to\defiant\proxy"
Add-MpPreference -ExclusionProcess "node.exe"
```

After adding exclusions, re-clone or re-install defiant if files were quarantined.

## Troubleshooting

**npm install fails**
Ensure Node.js 18+ is installed. Delete node_modules and package-lock.json, then retry.

**tsx not found**
Run `npm install` from the project root. The proxy uses tsx to run TypeScript directly.

**TypeScript compilation errors**
Run `npm test` to check for type errors.

**Proxy fails to start on Windows (port not responding)**
Windows Defender may be blocking the proxy. Run `~/.defiant/fix-av.cmd` as admin (this file is written on every launch and survives AV deletion of the defiant directory).

**"command not found: defiant"**
The defiant directory is not on your PATH. Run `npm install -g .` from the repo directory, or add the repo directory to your PATH manually.

**"DEEPSEEK_API_KEY not set"**
At minimum you need one provider's API key. See the [Providers table](#providers-and-api-keys). Set keys via environment variables.

**macOS/Linux: "jq: command not found"**
Install jq: `brew install jq` (macOS) or `sudo apt install jq` (Linux).

**Proxy produces no response / Claude Code hangs**
Run `defiant --doctor` to check system health. Check that your provider API key is valid and has credits. The proxy has built-in protection against silent stream drops: gzip decompression for misconfigured CDNs, heartbeat/deadline detection with byte diagnostics (logged to `~/.defiant/proxy.log`), and automatic fallback chain retry. Check the proxy log for stream timeout or transport error messages.

## Similar projects

Defiant occupies a specific niche — per-slot Claude Code routing with protocol translation. These projects in the broader LLM proxy/gateway space have informed Defiant's design and are worth knowing about:

| Project | Type | Key strength |
|---|---|---|
| [LiteLLM](https://github.com/BerriAI/litellm) | OSS AI Gateway (Python) | 9 routing strategies (lowest cost, least busy, budget limiter, latency-based), spend tracking per key, admin dashboard, 8ms P95 at 1k RPS |
| [Portkey Gateway](https://github.com/portkey-ai/gateway) | OSS AI Gateway (Node.js) | 122KB footprint, <1ms overhead, configurable retry with status code filtering, guardrail pipeline, MCP gateway |
| [Aider](https://github.com/Aider-AI/aider) | OSS AI coding tool (Python) | Model alias system, coding benchmark leaderboard, reasoning tag extraction, multi-provider via litellm |
| [Cline](https://github.com/cline/cline) | VS Code AI assistant | Multi-provider with per-model config, implicit slot concept, provider-specific quirk handling |
| [Continue.dev](https://github.com/continuedev/continue) | OSS IDE AI assistant | Separate model config for chat vs autocomplete, provider profiles, model selector UX |
| [One API](https://github.com/songquanpeng/one-api) | OSS API management (Go) | Multi-tenant key management, quota tracking, channel load balancing |
| [Manifest](https://github.com/mnfst/manifest) | AI app framework (TypeScript) | Declarative single-file config, "it just works" DX, provider-agnostic design |

Defiant's differentiator: **slot-based routing** — Opus, Sonnet, Haiku, and subagent each dispatched independently. Combined with Anthropic↔OpenAI protocol translation, thinking block caching across providers, and a data-driven provider registry, it's purpose-built for the Claude Code ecosystem rather than general-purpose API forwarding.

## License

MIT
