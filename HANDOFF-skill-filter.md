# Defiant Skill Filter + Cache Miss Investigation — Handoff

**Session date**: 2026-06-18
**Working directory**: `C:\Dev\defiant`
**Defiant repo**: `https://github.com/Poiar/defiant-claude` (private)

## What was done

### Skill filter (`proxy/skill-filter.ts` — NEW)

Strips Anthropic-specific content from the Claude Code system prompt before it reaches non-Anthropic upstream providers (DeepSeek via OpenAI translation path, Gemini).

**What it strips:**
1. The "The most recent Claude models are..." paragraph (with model table)
2. The `claude-api` TRIGGER block (tells model to read SKILL.md before Anthropic queries)
3. Anthropic-only skill entries from the skills list:
   - `claude-api`, `code-review`, `security-review`, `simplify`, `run`, `review`, `init`, `keybindings-help`
4. Scattered Anthropic model name references (claude-opus-4-8, Fable 5, etc.)

**What it keeps:**
- `deep-research`, `loop`, `verify`, `update-config`, `fewer-permission-prompts`

**Key design decisions:**
- Returns unchanged string if no Anthropic content found — avoids mutating unrelated content
- Cleanup (blank line collapse, trailing newline) only runs when `modified` flag is set
- Regex replacements compare `result !== before` instead of using `.test()` (avoids `g` flag `lastIndex` bug)

### Integration (`proxy/protocol-translate.ts` — MODIFIED)

Two insertion points:
1. **OpenAI path** (`translateRequest()`): `systemContent = stripAnthropicSkills(systemContent)` before system message insertion
2. **Gemini path** (`translateRequestToGemini()`): Each text block filtered through `stripAnthropicSkills()` before parts array

### Tests (`proxy/__tests__/skill-filter.test.ts` — NEW)

**8 tests — ALL PASS:**
1. Passes through clean content unchanged
2. Strips Claude model paragraph
3. Strips claude-api from skills list
4. Strips claude-api TRIGGER block
5. Strips multiple Anthropic-only skills
6. Cleans up blank lines after removals
7. Empty string passes through
8. All Anthropic-only skills stripped, model-agnostic ones kept

**Existing tests:** All 111 protocol-translate tests also pass.

### Full test suite — NOT YET RUN
- 51 test suites, ~1668 tests
- Command: `npm test` (from `C:\Dev\defiant`)
- Need to verify skill filter doesn't break anything else

## Cache miss issue — partial investigation

### DeepSeek disk cache mechanics
- Automatic disk cache, no `cache_control` markers needed
- Requires **identical prefix matching** for cache hits
- Cache prefix units at: end of input, end of output, common prefixes, fixed token intervals
- **Persistence: hours to days** (not 5 minutes like Anthropic)
- **Cache hit**: $0.0036/M tokens (50× cheaper than miss at $0.435/M)
- Verified empirically: 97.7% hit rate on identical requests 10s apart

### Why cache misses happen in this session
With 150+ tool calls, each turn has a different `messages` array → the prefix changes → cache miss. The system prompt itself may also vary between turns (dynamic skill listings, environment details).

### Potential improvements (not implemented)
1. **Strip skills entirely** before forwarding — might stabilize the system prompt prefix (the skill filter partially does this)
2. **Verify system prompt stability** between turns — is the core system prompt identical turn-to-turn?
3. **Consider whether compaction/context changes** are breaking the prefix match
4. **Log cache hit rates** in the proxy to see actual numbers per request

## Relevant files
| File | Purpose |
|------|---------|
| `proxy/skill-filter.ts` | Core filter logic |
| `proxy/protocol-translate.ts` | Integration points (OpenAI + Gemini paths) |
| `proxy/__tests__/skill-filter.test.ts` | 8 tests |
| `memory/deepseek-caching.md` | Cache mechanics documentation |
| `proxy/providers.json` | 18 providers, pricing, endpoints |

## Key memory files in defiant
- `CLAUDE.md` — Architecture overview, dev commands, troubleshooting
- `memory/deepseek-caching.md` — Cache economics (50× discount)
- `memory/protocol-translation-architecture.md` — Two translation paths
- `memory/fingerprint-cache-key-antipattern.md` — Why UUID not fingerprints for thinking cache
- `memory/never-kill-proxy.md` — Don't restart proxy from within CC

## Next steps
1. **Run full test suite**: `cd C:\Dev\defiant && npm test` — verify no regressions
2. **Log cache hit/miss rates** from actual proxy requests to quantify the problem
3. **Check if system prompt is stable** between turns — log a hash of the system content each request
4. **Consider broader skill stripping** — maybe strip ALL skill entries before non-Anthropic providers (not just Anthropic-specific ones)
