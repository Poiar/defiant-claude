# deepclaude

Provider-agnostic Claude Code wrapper. Route each model slot (Opus, Sonnet, Haiku, subagent) to a different provider. Mix DeepSeek, OpenRouter, OpenCode Zen, Fireworks, and Anthropic in one session.

## Quick start

```
# Get a DeepSeek API key: https://platform.deepseek.com

setx DEEPSEEK_API_KEY "sk-your-key"          # Windows
export DEEPSEEK_API_KEY="sk-your-key"        # macOS/Linux

# Install: add repo directory to PATH, or:
npm install -g .                             # if you prefer npm link

deepclaude                                    # Launch with DeepSeek V4 Pro
```

**Requires PowerShell 7+** on Windows (the `.ps1` uses `??`, `-Parallel`, ternary). On macOS/Linux, use `deepclaude.sh`.

## Usage

### Named configs (`-b`)

```
deepclaude                  # ds (default) — DeepSeek V4 Pro
deepclaude -b or            # OpenRouter (owl-alpha)
deepclaude -b or2           # OpenRouter (DeepSeek)
deepclaude -b or3           # OpenRouter (best free)
deepclaude -b fw            # Fireworks AI
deepclaude -b oc            # OpenCode Zen
deepclaude -b ds+oc         # DeepSeek main + OpenCode subs
deepclaude -b ds+or         # DeepSeek main + OpenRouter subs
deepclaude -b anthropic     # Normal Claude Code
```

### Ad-hoc positional configs

Pass 1–4 `providerKey:modelId` specs, mapped to opus/sonnet/haiku/subagent:

```
deepclaude ds:deepseek-v4-pro                                    # 1 spec → all slots
deepclaude ds:deepseek-v4-pro oc:big-pickle                      # 2 specs → first half / second half
deepclaude ds:deepseek-v4-pro oc:big-pickle or:z-ai/glm-4.5-air:free  # 3 specs → last repeats
```

### Flags

```
--status        Show keys, configs, and active slot mapping
--doctor        System health check (prereqs, keys, proxy test)
--cost          Pricing comparison
--benchmark     Parallel latency test across all configs
--models        List all available model IDs (for /model in CC)
--remote        Browser-based remote control (starts proxy automatically)
--persist       Keep proxy alive after CC exits
--switch CONFIG Switch a running persistent proxy to a different config
--set-slot SLOT MODEL  Override a slot (opus/sonnet/haiku/subagent)
--stop-proxy    Kill the persistent proxy
--version       Print version and proxy path
--lint          Self-lint with PSScriptAnalyzer
--fix-av        Print Windows Defender exclusion commands
```

## Providers and API keys

| Key | Provider | Flag | Auth |
|---|---|---|---|
| `DEEPSEEK_API_KEY` | DeepSeek (direct) | `ds` | x-api-key |
| `OPENROUTER_API_KEY` | OpenRouter | `or` | bearer |
| `FIREWORKS_API_KEY` | Fireworks AI | `fw` | bearer |
| `OPENCODE_API_KEY` | OpenCode Zen | `oc` | bearer |
| `ALIBABA_DASHSCOPE_API_KEY` | Alibaba/DashScope | `al` | bearer |

Keys are read from both process env and machine/user environment variables.

## Named configs reference

```
ds     opus=ds:deepseek-v4-pro     sonnet=ds:deepseek-v4-pro     haiku=ds:deepseek-v4-flash    sub=ds:deepseek-v4-flash
or     opus=or:openrouter/owl-alpha  sonnet=or:openrouter/owl-alpha  haiku=or:z-ai/glm-4.5-air:free  sub=or:z-ai/glm-4.5-air:free
or2    opus=or:deepseek/deepseek-v4-pro  sonnet=or:deepseek/deepseek-v4-pro  haiku=or:deepseek/deepseek-v4-flash  sub=or:deepseek/deepseek-v4-flash
or3    opus=or:openai/gpt-oss-120b:free  sonnet=or:poolside/laguna-m.1:free  haiku=or:z-ai/glm-4.5-air:free  sub=or:liquid/lfm-2.5-1.2b-instruct:free
fw     opus=fw:accounts/fireworks/models/deepseek-v4-pro  (all slots same)
oc     opus=oc:big-pickle  (all slots same)
ds+oc  opus=ds:deepseek-v4-pro  sonnet=ds:deepseek-v4-pro  haiku=oc:big-pickle  sub=oc:big-pickle
ds+or  opus=ds:deepseek-v4-pro  sonnet=ds:deepseek-v4-pro  haiku=or:z-ai/glm-4.5-air:free  sub=or:z-ai/glm-4.5-air:free
```

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

| Model | Context |
|---|---|
| `deepseek-v4-pro` / `deepseek-v4-flash` (any provider) | 1M |
| `openrouter/owl-alpha` | 200K |
| `openai/gpt-oss-120b:free`, `poolside/laguna-m.1:free`, `z-ai/glm-4.5-air:free` | 128K |
| `big-pickle` | 128K |
| `liquid/lfm-2.5-1.2b-instruct:free` | 32K |

Models at 1M tokens get `CLAUDE_CODE_AUTO_COMPACT_WINDOW` set. Models between 128K–1M get `CLAUDE_CODE_MAX_CONTEXT_TOKENS` with compaction disabled.

## Persistent proxy workflow

The proxy routes each model name to the right provider. It runs on `127.0.0.1` with a dynamic port.

```
deepclaude -b ds+oc --persist      # Start with proxy, keep it alive after exit

# Mid-session, from another terminal or within CC via /model:
deepclaude --switch ds+or          # Switch all slots to DeepSeek + OpenRouter
deepclaude --switch fw             # Switch everything to Fireworks
deepclaude --set-slot haiku oc:big-pickle  # Change just the haiku slot

deepclaude --models                # List all available models
deepclaude --stop-proxy            # Kill the proxy when done
```

State files live in `~/.deepclaude/`:
- `proxy.json` — PID, port, routes file
- `current-routes.json` — active routing table (reloaded on every request)
- `slot-overrides.json` — per-slot model overrides

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

Shows the real model, provider, context usage, effort level, and git branch — with slot override resolution so you see what's actually running:

![statusline example](statusline/example.png)

```
1. Copy statusline/statusline.sh → ~/.claude/statusline.sh
2. Add to ~/.claude/settings.json:
```

```json
{
  "statusLine": {
    "type": "command",
    "command": "bash ~/.claude/statusline.sh"
  }
}
```

Resolves slot overrides from `~/.deepclaude/slot-overrides.json` and context limits from `~/.deepclaude/current-routes.json`, so the token gauge and model display always reflect reality.

## Environment

| Variable | Purpose |
|---|---|
| `DEEPCLAUDE_DEFAULT_BACKEND` | Default config (falls back to legacy `CHEAPCLAUDE_DEFAULT_BACKEND`, then `ds`) |

All provider env vars are pushed into the process so the proxy (child process) inherits them.

## License

MIT
