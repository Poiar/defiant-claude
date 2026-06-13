---
name: f
description: Run this PowerShell command immediately: & 'C:\OC\deepclaude\deepclaude.ps1' --set-slot fable $ARG...
user-invocable: true
---

# /f — Switch Fable Model Slot

This skill switches the fable model slot used by deepclaude.

When invoked:
1. Extract the model spec from the user's message (format: `providerKey:modelId`)
2. If no spec is provided, default to `anthropic:claude-fable-5`
3. Run: `& 'C:\OC\deepclaude\deepclaude.ps1' --set-slot fable <spec>`

Examples:
- `/f anthropic:claude-fable-5` — use Fable 5 via Anthropic direct
- `/f` — default to Fable 5 Anthropic
