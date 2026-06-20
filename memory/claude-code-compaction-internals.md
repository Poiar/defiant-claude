---
name: claude-code-compaction-internals
description: How Claude Code determines context window and triggers auto-compaction — critical for proxy model routing
metadata: 
  node_type: memory
  type: reference
  originSessionId: 2b17f843-715b-4aa7-acc7-025f76beed3b
---

Claude Code's auto-compaction behavior is governed by several functions embedded in the Node.js SEA binary (extracted from v2.1.169 at `C:\Users\pc\.local\share\claude\versions\`).

## Context window: `PV(model)` function

```js
function PV(H, q) {
  if (DISABLE_COMPACT && CLAUDE_CODE_MAX_CONTEXT_TOKENS) return parseInt(env, 10);
  if (u2(H)) return 1e6;                  // model has "[1m]" suffix — easiest lever
  if (q?.includes(Rc.header) && EB(H)) return 1e6;  // extended thinking beta header
  if (k6H(H)) return 1e6;                 // Opus 4.7/4.8 on firstParty/AnthropicAWS/mantle ONLY
  let K = D46(H);                         // Sonnet 4.6 server-side override
  if (K !== null) return K;
  return qX8;                             // default: 200000
}
```

**Key insight**: `k6H(H)` only returns true for `claude-opus-4-7`/`claude-opus-4-8` when the backend is `firstParty`, `anthropicAws`, or `mantle`. Third-party proxies never match this, so even with Opus 4.7 emulation, the context window falls to **200k default**.

## Auto-compaction threshold: `ii(model)` function

Determines the compaction window from the context window:
- Default auto mode with 200k context: compact at min(200000*0.8, 200000-13000) = **~160,000 tokens** (the ~166k the user observed)
- With 1M context: compact at **~987,000 tokens**

## Env var validation: `BKH()` clamps

`CLAUDE_CODE_AUTO_COMPACT_WINDOW` is validated against range [dKK=100000, bu_=**1000000**]. Values > 1,000,000 are **rejected as invalid**. So `1048576` (the real deepseek-v4-pro context) silently fails — must use exactly `1000000`.

## Dynamic per-model: `[1m]` suffix

`u2(H)` checks if the model name string contains `[1m]`. This is checked on the **raw** model name before normalization. So setting `ANTHROPIC_MODEL=opus:ds:deepseek-v4-pro[1m]` gives 1M context **per-request**, surviving mid-session `/model` switches.

The proxy must strip `[1m]` before route lookup (`routing.ts`) so upstream APIs don't receive it.

## Fallback constants

```js
var qX8 = 200000;   // default context window
var dKK = 100000;    // min auto-compact window
var bu_ = 1000000;   // max auto-compact window
var Iu_ = 200000;    // default auto-compact window for 1M-capable models
var FKK = 0.2;       // precompute buffer fraction (20%)
```

## Defiant integration points

- `defiant.ps1` lines ~1587-1601 (remote), ~1709-1721 (main): sets `CLAUDE_CODE_AUTO_COMPACT_WINDOW` based on opus slot model's contextLimit from `providers.json`
- `defiant.ps1` Append-1M function: adds `[1m]` suffix to model env vars when context ≥1M
- `routing.ts` resolveTarget: strips `[1m]` before route lookup
