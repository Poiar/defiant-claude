# deepclaude

Provider-agnostic Claude Code wrapper. Route each model slot (Opus, Sonnet, Haiku, subagent) to a different provider. Mix DeepSeek, OpenRouter, OpenCode Zen, Fireworks, Kimi, Mimo, Umans, and Anthropic in one session.

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
```

## Requirements

- **Windows:** PowerShell 7+ ([download](https://github.com/PowerShell/PowerShell))
- **macOS/Linux:** bash 4+, jq, netcat (nc), Node.js 18+
- Node.js 18+ (for the proxy)

## Usage

### Named configs (`-b`)

```
deepclaude                  # ds (default) — DeepSeek V4 Pro
deepclaude -b or            # OpenRouter (owl-alpha)
deepclaude -b or2           # OpenRouter (DeepSeek)
deepclaude -b or3           # OpenRouter (best free)
deepclaude -b fw            # Fireworks AI
deepclaude -b oc            # OpenCode Zen
deepclaude -b km            # Kimi K2.6
deepclaude -b mm            # Xiaomi Mimo V2.5 Pro
deepclaude -b um            # Umans AI (Kimi K2.6)
deepclaude -b gr            # Groq (Llama 4 Maverick)
deepclaude -b mt            # Mistral Large
deepclaude -b mx            # MiniMax M1
deepclaude -b za            # Z.ai GLM 4.5
deepclaude -b bp            # BytePlus Doubao 1.5 Pro
deepclaude -b sf            # SiliconFlow (DeepSeek V4 Pro)
deepclaude -b nv            # Novita (DeepSeek V4 Pro)
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
--benchmark     Latency test across all configs (parallel on .ps1, sequential on .sh)
--models        List all available model IDs (for /model in CC)
--remote        Browser-based remote control (starts proxy automatically)
--persist       Keep proxy alive after CC exits
--switch CONFIG Switch a running persistent proxy to a different config
--set-slot SLOT MODEL  Override a slot (opus/sonnet/haiku/subagent)
--stop-proxy    Kill the persistent proxy
--version       Print version and proxy path
--lint          Self-lint (PSScriptAnalyzer on .ps1, shellcheck on .sh)
--effort LEVEL        Set Claude Code effort level (default: max)
--fix-av              Print Windows Defender exclusion commands
--install-statusline  Auto-install the statusline script and config
```

## Providers and API keys

| Key | Provider | Flag | Auth |
|---|---|---|---|
| `DEEPSEEK_API_KEY` | DeepSeek (direct) | `ds` | x-api-key |
| `OPENROUTER_API_KEY` | OpenRouter | `or` | bearer |
| `FIREWORKS_API_KEY` | Fireworks AI | `fw` | bearer |
| `OPENCODE_API_KEY` | OpenCode Zen | `oc` | bearer |
| `ALIBABA_DASHSCOPE_API_KEY` | Alibaba/DashScope | `al` | bearer |
| `KIMI_API_KEY` | Kimi/Moonshot | `km` | bearer |
| `MIMO_API_KEY` | Xiaomi Mimo | `mm` | bearer |
| `UMANS_API_KEY` | Umans AI | `um` | x-api-key |
| `GROQ_API_KEY` | Groq | `gr` | bearer |
| `MISTRAL_API_KEY` | Mistral | `mt` | bearer |
| `MINIMAX_API_KEY` | MiniMax | `mx` | bearer |
| `ZAI_API_KEY` | Z.ai / GLM | `za` | bearer |
| `BYTEPLUS_API_KEY` | BytePlus/Doubao | `bp` | bearer |
| `SILICONFLOW_API_KEY` | SiliconFlow | `sf` | bearer |
| `NOVITA_API_KEY` | Novita | `nv` | bearer |

Keys are read from both process env and machine/user environment variables.

Providers with `format = "openai"` (Kimi, Mimo, Alibaba, Groq, Mistral, MiniMax, Z.ai, BytePlus, SiliconFlow, Novita) use OpenAI-compatible endpoints. The proxy automatically translates between Anthropic and OpenAI protocols — no configuration needed.

## Provider fallback

Providers can specify a `fallback` list — if the primary provider fails (500, 429, timeout, dead stream), the proxy automatically retries with the fallback:

```
km → fallback: ds        # Kimi fails → DeepSeek
mm → fallback: oc        # Mimo fails → OpenCode
gr → fallback: ds        # Groq fails → DeepSeek
```

Fallbacks are configured per-provider and transparent to Claude Code. Max 3 attempts per request.

## Named configs reference

```
ds     opus=ds:deepseek-v4-pro     sonnet=ds:deepseek-v4-pro     haiku=ds:deepseek-v4-flash    sub=ds:deepseek-v4-flash
or     opus=or:openrouter/owl-alpha  sonnet=or:openrouter/owl-alpha  haiku=or:z-ai/glm-4.5-air:free  sub=or:z-ai/glm-4.5-air:free
or2    opus=or:deepseek/deepseek-v4-pro  sonnet=or:deepseek/deepseek-v4-pro  haiku=or:deepseek/deepseek-v4-flash  sub=or:deepseek/deepseek-v4-flash
or3    opus=or:openai/gpt-oss-120b:free  sonnet=or:poolside/laguna-m.1:free  haiku=or:z-ai/glm-4.5-air:free  sub=or:liquid/lfm-2.5-1.2b-instruct:free
fw     opus=fw:accounts/fireworks/models/deepseek-v4-pro  (all slots same)
oc     opus=oc:big-pickle  (all slots same)
km     opus=km:kimi-k2.6  (all slots same)
mm     opus=mm:mimo-v2.5-pro  (all slots same)
um     opus=um:umans-coder  (all slots same)
gr     opus=gr:groq/llama-4-maverick  sonnet=gr:groq/llama-4-maverick  haiku=gr:groq/deepseek-r1-distill-qwen-32b  sub=gr:groq/deepseek-r1-distill-qwen-32b
mt     opus=mt:mistral/mistral-large  sonnet=mt:mistral/mistral-large  haiku=mt:mistral/mistral-small  sub=mt:mistral/mistral-small
mx     opus=mx:minimax/minimax-m1  (all slots same)
za     opus=za:zai/glm-4.5  (all slots same)
bp     opus=bp:byteplus/doubao-1.5-pro  (all slots same)
sf     opus=sf:siliconflow/deepseek-v4-pro  (all slots same)
nv     opus=nv:novita/deepseek-v4-pro  (all slots same)
ds+oc  opus=ds:deepseek-v4-pro  sonnet=ds:deepseek-v4-pro  haiku=oc:big-pickle  sub=oc:big-pickle
ds+or  opus=ds:deepseek-v4-pro  sonnet=ds:deepseek-v4-pro  haiku=or:z-ai/glm-4.5-air:free  sub=or:z-ai/glm-4.5-air:free
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

| Model | Context |
|---|---|
| `deepseek-v4-pro` / `deepseek-v4-flash` (any provider) | 1M |
| `openrouter/owl-alpha` | 200K |
| `openai/gpt-oss-120b:free`, `poolside/laguna-m.1:free`, `z-ai/glm-4.5-air:free` | 128K |
| `big-pickle` | 128K |
| `kimi-k2.6`, `umans-kimi-k2.6`, `umans-coder` | 256K |
| `mimo-v2.5-pro`, `umans-flash`, `umans-glm-5.1` | 128K |
| `liquid/lfm-2.5-1.2b-instruct:free` | 32K |
| `groq/llama-4-maverick` | 128K |
| `groq/deepseek-r1-distill-qwen-32b` | 128K |
| `mistral/mistral-large` | 128K |
| `mistral/mistral-small` | 128K |
| `minimax/minimax-m1` | 256K |
| `zai/glm-4.5` | 128K |
| `byteplus/doubao-1.5-pro` | 128K |
| `siliconflow/deepseek-v4-pro` | 1M |
| `novita/deepseek-v4-pro` | 1M |

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

Shows the real model, provider, context usage, effort level, and git branch — with slot override resolution so you see what's actually running.

```
# Windows (PowerShell)
1. Copy statusline/statusline.ps1 → ~/.claude/statusline.ps1
2. Add to ~/.claude/settings.json:

  { "statusLine": { "type": "command", "command": "pwsh ~/.claude/statusline.ps1" } }

# macOS/Linux (bash)
1. Copy statusline/statusline.sh → ~/.claude/statusline.sh
2. Add to ~/.claude/settings.json:

  { "statusLine": { "type": "command", "command": "bash ~/.claude/statusline.sh" } }
```

Resolves slot overrides from `~/.deepclaude/slot-overrides.json` and context limits from `~/.deepclaude/current-routes.json`, so the token gauge and model display always reflect reality.

Tip: `deepclaude --install-statusline` automates the manual setup above.

## Environment

| Variable | Purpose |
|---|---|
| `DEEPCLAUDE_DEFAULT_BACKEND` | Default config (falls back to `ds`; legacy `CHEAPCLAUDE_DEFAULT_BACKEND` also accepted) |

All provider env vars are pushed into the process so the proxy (child process) inherits them.

## Windows Defender

The proxy starts a local HTTP server and forwards requests — Windows Defender often flags this as suspicious behavior. If the proxy gets blocked:

```
deepclaude --fix-av       # Prints the exact exclusion commands to run
```

Then run the printed commands in an **admin** PowerShell window. You'll need to exclude both the `proxy/` directory and potentially `node.exe`.

## Troubleshooting

**Proxy fails to start on Windows (port not responding)**
Windows Defender may be blocking the proxy. Run `deepclaude --fix-av` and execute the printed commands in an admin PowerShell window.

**"command not found: deepclaude"**
The deepclaude directory is not on your PATH. Run `npm install -g .` from the repo directory, or add the repo directory to your PATH manually.

**"DEEPSEEK_API_KEY not set"**
At minimum you need one provider's API key. See the [Providers table](#providers-and-api-keys). Set keys via environment variables.

**macOS/Linux: "jq: command not found"**
Install jq: `brew install jq` (macOS) or `sudo apt install jq` (Linux).

**Proxy produces no response / Claude Code hangs**
Run `deepclaude --doctor` to check system health. Check that your provider API key is valid and has credits.

## License

MIT
