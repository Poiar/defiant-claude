# deepclaude — Launch Posts

---

## 1. Reddit r/ClaudeAI

**Title:** I built "deepclaude" — use Claude Code's full agent loop with DeepSeek V4 Pro. Same UX, 17x cheaper, no usage caps.

**Body:**

I got tired of the $200/month Claude Max plan with weekly usage caps, so I built a simple tool that swaps the brain while keeping Claude Code's body.

**What it does:** One command (`deepclaude`) launches Claude Code CLI with DeepSeek V4 Pro as the model. Everything works — file reading, editing, bash, multi-step autonomous loops, subagent spawning. The only difference is which model thinks.

**Cost comparison:**

| | Anthropic | deepclaude (DeepSeek) |
|---|---|---|
| Output/M tokens | $15.00 | $0.87 |
| Monthly (heavy use) | $200 (capped) | ~$50 (uncapped) |
| Usage limits | Weekly + 5-hour caps | None |

DeepSeek's auto context caching makes agent loops even cheaper — after the first request, repeated context costs $0.004/M instead of $0.44/M.

**Supports 3 backends:**
- DeepSeek direct (default)
- OpenRouter (cheapest, US servers)
- Fireworks AI (fastest)

**Bonus: Remote control works too.** `deepclaude --remote` starts a browser session at claude.ai/code with DeepSeek as the brain. It runs a local proxy that splits traffic — bridge auth goes to Anthropic, model calls go to DeepSeek.

**What doesn't work:** Image/vision input, parallel tool use, MCP server tools. For the 20% of tasks that need real Opus quality, switch with `deepclaude -b anthropic`.

GitHub: https://github.com/aattaran/deepclaude

Works on Windows (PowerShell) and macOS/Linux (bash). Setup is 2 minutes — get a DeepSeek API key, set one env var, run `deepclaude`.

---

## 2. Hacker News

**Title:** Show HN: deepclaude – Claude Code's autonomous agent loop with DeepSeek V4 Pro at 17x lower cost

**Body:**

Claude Code is the best autonomous coding agent but costs $200/month with usage caps. deepclaude swaps the model to DeepSeek V4 Pro ($0.87/M output) while keeping Claude Code's tool loop, file editing, and autonomous execution.

One shell script, no dependencies beyond Claude Code + a DeepSeek API key. Works by setting env vars (ANTHROPIC_BASE_URL, ANTHROPIC_DEFAULT_*_MODEL) per-session.

The interesting technical challenge was remote control. `claude remote-control` uses a hardcoded WebSocket bridge to wss://bridge.claudeusercontent.com for auth, but model API calls go to ANTHROPIC_BASE_URL. deepclaude starts a local HTTP proxy that routes /v1/messages to DeepSeek while passing everything else to Anthropic. Bridge auth stays on Anthropic, model inference goes to DeepSeek.

Supports DeepSeek (direct), OpenRouter, and Fireworks AI. DeepSeek's automatic context caching makes agent loops extremely cheap — system prompt + file context gets cached at $0.004/M after the first request.

https://github.com/aattaran/deepclaude

---

## 3. X / Twitter

I built deepclaude — use Claude Code's full agent loop with DeepSeek V4 Pro for $0.87/M instead of $15/M.

Same tool calling, file editing, autonomous coding. 17x cheaper. No usage caps.

One command: `deepclaude`

Even remote control (browser sessions) works — via a local proxy that splits bridge auth (Anthropic) from model calls (DeepSeek).

github.com/aattaran/deepclaude

#ClaudeCode #DeepSeek #AI #CodingAgent

---

## 4. Reddit r/LocalLLaMA

**Title:** deepclaude — run Claude Code's agent loop with DeepSeek V4 Pro ($0.87/M vs $15/M Anthropic)

**Body:**

For those who want Claude Code's autonomous agent UX but don't want to pay $200/month:

**deepclaude** is a shell script that launches Claude Code with DeepSeek V4 Pro as the backend. No code changes to Claude Code — just env var overrides per-session.

The technical interesting bit: Claude Code's remote control uses a hardcoded WebSocket bridge to Anthropic for auth, but model API calls respect ANTHROPIC_BASE_URL. deepclaude includes a ~50-line Node.js HTTP proxy that intercepts model calls and routes them to DeepSeek while letting bridge auth flow to Anthropic unchanged.

DeepSeek V4 Pro (1.6T params, 49B active MoE, 1M context) scores 96.4% on LiveCodeBench. For 80% of daily coding tasks, it's indistinguishable from Claude Opus. For the hard 20%, switch backends with one flag.

Supports DeepSeek direct, OpenRouter, Fireworks AI. Context caching is automatic — $0.004/M for cached input vs $0.44/M uncached.

https://github.com/aattaran/deepclaude

---

## 5. Reddit r/ChatGPTCoding

**Title:** deepclaude — Claude Code's autonomous coding agent with DeepSeek V4 Pro. $50/month instead of $200.

**Body:**

If you use Claude Code for autonomous coding but hate the price:

`deepclaude` swaps the model to DeepSeek V4 Pro while keeping everything that makes Claude Code great — the tool loop, file editing, bash execution, subagent spawning, and multi-step autonomous coding.

Setup is 2 minutes:
1. Get a DeepSeek API key ($5 to start)
2. `export DEEPSEEK_API_KEY="sk-..."`
3. Run `deepclaude`

That's it. Same terminal UI, same commands, same `/init`, same autonomous loops. Just 17x cheaper.

Also supports remote control — `deepclaude --remote` gives you a browser URL at claude.ai/code running DeepSeek under the hood.

GitHub: https://github.com/aattaran/deepclaude
