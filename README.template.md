# deepclaude

<!-- AUTO:tagline -->
<!-- /AUTO:tagline -->

## Architecture

DeepClaude runs a local HTTP routing proxy that intercepts Claude Code's Anthropic API calls and dispatches each model slot (Opus, Sonnet, Haiku, subagent) to a different upstream provider.

**Direct DeepSeek (`ds`) uses the `/anthropic` endpoint** — DeepSeek offers an Anthropic-compatible API surface that speaks Claude's protocol natively. The proxy passes messages through unchanged: no format translation, no content flattening, no lossy conversion. Thinking mode (`{type: "enabled", budget_tokens: N}`), structured content blocks, tool use, and streaming all work without transformation. OpenAI-format translation only activates when routing through third-party providers (OpenRouter, Kimi, Mistral, etc.) that don't offer an Anthropic-compatible endpoint.

### Proxy modules (`proxy/`)

<!-- AUTO:modules -->
<!-- /AUTO:modules -->

### Data-driven provider registry

The proxy, the launcher scripts, and `statusline.mjs` all read from a single `proxy/providers.json` file. Config resolution, route construction, and context-limit lookups are centralized in `proxy/launcher.mjs` — a zero-dependency Node.js module shared by both `deepclaude.ps1` and `deepclaude.sh`. This eliminates duplicated provider, config, and context-limit definitions across languages and guarantees behavioral parity.

<!-- AUTO:providers-schema -->
<!-- /AUTO:providers-schema -->

### Launcher scripts

Two thin platform wrappers with identical behavior:

- **`deepclaude.ps1`** — PowerShell 7+ (Windows), parses CLI args, manages processes
- **`deepclaude.sh`** — Bash 4+ (macOS/Linux), same role

All business logic — config resolution, routes JSON construction, env var computation, slot/thinking overrides, context window calculation — lives in a single **`proxy/launcher.mjs`** Node.js module shared by both wrappers. This eliminates the ~1800 lines of duplicated logic that existed previously and guarantees behavioral parity across platforms.

### Test coverage

<!-- AUTO:test-coverage -->
<!-- /AUTO:test-coverage -->

### Pre-commit

Husky v9 + lint-staged: syntax check on staged files, TypeScript compilation guard.

## Quick start

```
# Get a DeepSeek API key: https://platform.deepseek.com

setx DEEPSEEK_API_KEY "sk-your-key"          # Windows
export DEEPSEEK_API_KEY="sk-your-key"        # macOS/Linux

# Option 1: npm link (creates global deepclaude command)
npm install -g .

# Option 2: Add repo directory to PATH manually
# Windows: setx PATH "%PATH%;C:\path\to\deepclaude"
# macOS/Linux: export PATH="$PATH:/path/to/deepclaude"

deepclaude                                    # Launch with DeepSeek V4 Pro
dc                                            # Shortcut — same as deepclaude (Windows: dc.cmd, macOS/Linux: alias)
```

## Requirements

- **Windows:** PowerShell 7+ ([download](https://github.com/PowerShell/PowerShell))
- **macOS/Linux:** bash 4+, jq, netcat (nc), Node.js 18+
- Node.js 18+ (for the proxy)

## Usage

### Named configs (`-b`)

```
<!-- AUTO:named-configs -->
<!-- /AUTO:named-configs -->
```

### Ad-hoc positional configs

Pass 1–5 `providerKey:modelId` specs, mapped to opus/sonnet/haiku/subagent/fable:

```
deepclaude ds:deepseek-v4-pro                                              # 1 spec → all 5 slots
deepclaude ds:deepseek-v4-pro oc:big-pickle                                # 2 specs → first 3 / last 2
deepclaude ds:deepseek-v4-pro oc:big-pickle or:z-ai/glm-4.5-air:free       # 3 specs → opus, rest=second, sub/fable=third
deepclaude ds:deepseek-v4-pro ds:deepseek-v4-pro oc:big-pickle or:z-ai/glm-4.5-air:free  # 4 specs → sub/fable share last
deepclaude ds:deepseek-v4-pro ds:deepseek-v4-pro oc:big-pickle or:z-ai/glm-4.5-air:free mm:mimo-v2.5-pro  # 5 specs → direct
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
deepclaude --set-slot haiku or:z-ai/glm-4.5-air:free   # Set haiku to a free OR model
deepclaude --set-slot subagent oc:big-pickle            # Set subagent to OpenCode
deepclaude --set-slot sonnet                            # Clear override (reverts to config default)
```

Overrides are stored in `~/.deepclaude/slot-overrides.json`. The proxy reloads them on every request — changes take effect immediately in a running session.

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

DeepSeek V4 models use a `compactionWindow` of 950K tokens to preserve automatic disk cache hits. Compaction rewrites conversation history, which invalidates the prefix and forces an expensive cache miss ($0.435/M). By delaying compaction to 950K (near the 1M wall), most requests stay within the same prefix and hit the disk cache at $0.0036/M — a 50× discount. The cache persists for hours to days and requires no configuration.

## Persistent proxy workflow

The proxy routes each model name to the right provider. It runs on `127.0.0.1` with a dynamic port.

```
deepclaude -b ds+oc --persist      # Start with proxy, keep it alive after exit

# Mid-session, from another terminal or within CC via /model:
deepclaude --switch fw             # Switch everything to Fireworks
deepclaude --set-slot haiku oc:big-pickle  # Change just the haiku slot

deepclaude --models                # List all available models
deepclaude --stop-proxy            # Kill the proxy when done
```

State files live in `~/.deepclaude/`:
<!-- AUTO:state-files -->
<!-- /AUTO:state-files -->

## Remote control (`--remote`)

```
deepclaude --remote                 # Default config via proxy
deepclaude --remote -b ds+oc        # Named config
deepclaude --remote ds:deepseek-v4-pro oc:big-pickle  # Ad-hoc
deepclaude --remote -b anthropic    # Anthropic direct
```

Starts the routing proxy, prints a `claude.ai/code/session_...` URL. Works on phone, tablet, any browser. Proxy auto-stops on exit (unless `--persist`).

## Doctor

System health check — verifies Node.js, proxy script, state directory, API keys, slot overrides, and runs a proxy startup test:

```
deepclaude --doctor
```

## Statusline

Shows the real model, provider, context usage, effort level, and git branch — with slot override resolution so you see what's actually running.

<pre style="background:#1a1a1a;color:#ccc;padding:10px 14px;border-radius:6px;font-family:Consolas,Menlo,monospace;font-size:13px;line-height:1.6;overflow-x:auto;white-space:pre">
<span style="font-weight:bold;color:#64B4FF">deepclaude</span>  <span style="font-weight:bold;color:#FF50B4">main</span>     <span style="font-weight:bold;color:#C864FF">o deepseek-v4-pro[1m]</span>  <span style="font-weight:bold;color:#FF5050">max</span>     <span style="font-weight:bold;color:#50C878">45k</span>     <span style="font-weight:bold;color:#FFD250">$0.01</span> <span style="color:#787878">$3.74</span>
</pre>

| Color | Element | Source |
|---|---|---|
| <span style="font-weight:bold;color:#64B4FF">█ Light blue</span> | Directory name | `d.workspace.current_dir` last segment |
| <span style="font-weight:bold;color:#FF50B4">█ Pink</span> | Git branch | `git rev-parse --abbrev-ref HEAD` |
| <span style="font-weight:bold;color:#C864FF">█ Purple</span> | Slot + model | Slot label (`o`/`s`/`h`/`sub`) + resolved model ID |
| <span style="font-weight:bold;color:#FF5050">█ Red</span> / <span style="font-weight:bold;color:#FFB432">█ Orange</span> / <span style="font-weight:bold;color:#64A0FF">█ Blue</span> | Effort | `max`/`high` (red), `medium` (orange), `low` (blue) |
| <span style="font-weight:bold;color:#50C878">█ Green</span> / <span style="font-weight:bold;color:#FFB432">█ Orange</span> / <span style="font-weight:bold;color:#FF5050">█ Red</span> | Context usage | Token count + % — green ≤50%, orange 50–79%, red ≥80% |
| <span style="font-weight:bold;color:#FFD250">█ Gold</span> | Session spend | Current Claude Code session cost from `~/.deepclaude/spend.json` |
| <span style="color:#787878">█ Gray</span> | Today spend | Daily total (shown when it exceeds session spend) |

The context gauge reads `tokens/percent` (e.g. `45k/5%` when the max is known). DeepSeek V4 Pro appends milestone tags: **SR** (300K+, purple) and **FBR** (400K+, magenta). Circuit breakers show **✕** (open, red), **◐** (half-open, orange), or **·** (closed, green). A recent fallback appends **↳**provider (orange).

```
# All platforms (Node.js)
1. Copy statusline/statusline.mjs → ~/.claude/statusline.mjs
2. Add to ~/.claude/settings.json:

  { "statusLine": { "type": "command", "command": "node ~/.claude/statusline.mjs" } }
```

Resolves slot overrides from `~/.deepclaude/slot-overrides.json` and context limits from `~/.deepclaude/current-routes.json`, so the token gauge and model display always reflect reality.

Tip: `deepclaude --install-statusline` automates the manual setup above.

## Environment

<!-- AUTO:env-vars -->
<!-- /AUTO:env-vars -->

All provider API key env vars (see [Providers table](#providers-and-api-keys)) are pushed into the process so the proxy (child process) inherits them.

## Windows Defender

The proxy starts a local HTTP server and forwards requests — Windows Defender often flags this as suspicious behavior and may **delete or quarantine** the proxy files. This is a catch-22: if deepclaude is deleted, you can't run `deepclaude --fix-av`.

**deepclaude writes a standalone rescue script on every launch:** `~/.deepclaude/fix-av.cmd`. Even if AV deletes the entire deepclaude directory, this file survives (it lives in your home directory, not near any executables). Run it as **administrator**:

```
~/.deepclaude/fix-av.cmd
```

Alternatively, run these commands manually in an admin PowerShell window:

```
Add-MpPreference -ExclusionPath "C:\path\to\deepclaude\proxy"
Add-MpPreference -ExclusionProcess "node.exe"
```

After adding exclusions, re-clone or re-install deepclaude if files were quarantined.

## Troubleshooting

**npm install fails**
Ensure Node.js 18+ is installed. Delete node_modules and package-lock.json, then retry.

**tsx not found**
Run `npm install` from the project root. The proxy uses tsx to run TypeScript directly.

**TypeScript compilation errors**
Run `npm test` to check for type errors.

**Proxy fails to start on Windows (port not responding)**
Windows Defender may be blocking the proxy. Run `~/.deepclaude/fix-av.cmd` as admin (this file is written on every launch and survives AV deletion of the deepclaude directory).

**"command not found: deepclaude"**
The deepclaude directory is not on your PATH. Run `npm install -g .` from the repo directory, or add the repo directory to your PATH manually.

**"DEEPSEEK_API_KEY not set"**
At minimum you need one provider's API key. See the [Providers table](#providers-and-api-keys). Set keys via environment variables.

**macOS/Linux: "jq: command not found"**
Install jq: `brew install jq` (macOS) or `sudo apt install jq` (Linux).

**Proxy produces no response / Claude Code hangs**
Run `deepclaude --doctor` to check system health. Check that your provider API key is valid and has credits. The proxy has built-in protection against silent stream drops: gzip decompression for misconfigured CDNs, heartbeat/deadline detection with byte diagnostics (logged to `~/.deepclaude/proxy.log`), and automatic fallback chain retry. Check the proxy log for stream timeout or transport error messages.

## Similar projects

DeepClaude occupies a specific niche — per-slot Claude Code routing with protocol translation. These projects in the broader LLM proxy/gateway space have informed DeepClaude's design and are worth knowing about:

| Project | Type | Key strength |
|---|---|---|
| [LiteLLM](https://github.com/BerriAI/litellm) | OSS AI Gateway (Python) | 9 routing strategies (lowest cost, least busy, budget limiter, latency-based), spend tracking per key, admin dashboard, 8ms P95 at 1k RPS |
| [Portkey Gateway](https://github.com/portkey-ai/gateway) | OSS AI Gateway (Node.js) | 122KB footprint, <1ms overhead, configurable retry with status code filtering, guardrail pipeline, MCP gateway |
| [Aider](https://github.com/Aider-AI/aider) | OSS AI coding tool (Python) | Model alias system, coding benchmark leaderboard, reasoning tag extraction, multi-provider via litellm |
| [Cline](https://github.com/cline/cline) | VS Code AI assistant | Multi-provider with per-model config, implicit slot concept, provider-specific quirk handling |
| [Continue.dev](https://github.com/continuedev/continue) | OSS IDE AI assistant | Separate model config for chat vs autocomplete, provider profiles, model selector UX |
| [One API](https://github.com/songquanpeng/one-api) | OSS API management (Go) | Multi-tenant key management, quota tracking, channel load balancing |
| [Manifest](https://github.com/mnfst/manifest) | AI app framework (TypeScript) | Declarative single-file config, "it just works" DX, provider-agnostic design |

DeepClaude's differentiator: **slot-based routing** — Opus, Sonnet, Haiku, and subagent each dispatched independently. Combined with Anthropic↔OpenAI protocol translation, thinking block caching across providers, and a data-driven provider registry, it's purpose-built for the Claude Code ecosystem rather than general-purpose API forwarding.

## License

MIT
