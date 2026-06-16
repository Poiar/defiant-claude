---
name: search-debug
description: Trace and debug web search through the proxy — DDG scraper health, pre-execution, guardrails, provider standardization
---

# Search Debug

End-to-end web search diagnostics. Traces every layer of the pipeline and verifies all guardrails.

## Quick Check

```bash
node -e "
const { ddgLiteSearch, webSearch, populateToolResults, extractSearchQuery,
  _resetDdgCookies, _resetSearchCache, _resetFetchSlots } = require('./proxy/server-tools');
async function test() {
  _resetDdgCookies(); _resetSearchCache(); _resetFetchSlots();

  // Tier 1: DDG Lite POST
  console.log('=== DDG Lite (POST) ===');
  const r = await ddgLiteSearch('test query');
  console.log(r.length > 0 ? '✅ ' + r.length + ' results' : '❌ Empty');
  if (r[0]) console.log('   ' + r[0].title.slice(0, 60));

  // Tier 2: Full pipeline
  console.log('=== webSearch() ===');
  _resetSearchCache();
  const w = await webSearch('test query');
  console.log(w.length > 100 ? '✅ ' + w.length + ' chars' : '❌ Short/empty');
  console.log(w.split('\n').slice(0, 3).join('\n'));

  // Tier 3: populateToolResults (proxy flow)
  console.log('=== populateToolResults ===');
  _resetSearchCache();
  const msgs = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'web_search', input: { query: 'test' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '' }] }
  ];
  const ok = await populateToolResults(msgs as any);
  console.log(ok ? '✅ Filled: ' + ((msgs[1] as any).content[0].content as string).length + ' chars' : '❌ Not filled');

  // Guard: extractSearchQuery
  console.log('=== extractSearchQuery ===');
  const q1 = extractSearchQuery([
    { role: 'user', content: [{ type: 'text', text: 'Perform a web search for the query: iPhone 18 Pro 2026' }] }
  ]);
  console.log(q1 === 'iPhone 18 Pro 2026' ? '✅ Matched' : '❌ Got: ' + q1);
}
test().catch(e => { console.error('❌', e.message); process.exit(1); });
" 2>&1
```

## Deep Debug (full pipeline trace)

```bash
# 1. Check proxy version
curl -s http://127.0.0.1:$(cat ~/.deepclaude/proxy.port)/health | grep -o '"version":"[^"]*"'

# 2. Verify proxy log for WEB_SEARCH_PREX entries
strings ~/.deepclaude/proxy.log | grep WEB_SEARCH | tail -5

# 3. Check DDG scraper directly
npx tsx -e "require('./proxy/server-tools').ddgLiteSearch('test').then(r => console.log(r.length, 'results'))"

# 4. Test pre-execution through proxy
curl -s --max-time 15 -X POST http://127.0.0.1:$(cat ~/.deepclaude/proxy.port)/v1/messages \
  -H "Content-Type: application/json" -H "x-api-key: deepclaude-$(cat ~/.deepclaude/proxy.port)" \
  -d '{"model":"haiku:deepseek-v4-flash","max_tokens":200,"stream":false,
    "tools":[{"type":"web_search_20250305","name":"web_search","description":"Search",
    "input_schema":{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}}],
    "tool_choice":{"type":"tool","name":"web_search_20250305"},
    "system":[{"type":"text","text":"You are an assistant for performing a web search tool use"}],
    "messages":[{"role":"user","content":[{"type":"text","text":"Perform a web search for the query: test"}]}]}' \
  2>&1 | grep -o '"server_tool_use":{"web_search_requests":[0-9]*}'
```

## Failure Modes

| Symptom | Diagnosis | Fix |
|---------|-----------|-----|
| "Did 0 searches" | DDG returns empty | `ddgLiteSearch('test')` — check DDG Lite scraper |
| "Did 0 searches" | Pre-execution not firing | Check proxy version has pre-exec code |
| "Did 0 searches" | wrong model trust | Check `getTrustedModel()` output |
| 400 from upstream | thinking + tool_choice conflict | Check `applyThinkingConfig` stripping |
| Empty DDG results | Bot detection / CAPTCHA | DDG may have changed — check cookie jar |
| No WEB_SEARCH_PREX in log | extractSearchQuery returned null | Message format may differ |
| 502 / fallback exhausted | No providers configured | Check routes.json / slot-overrides.json |

## Provider Standardization

All providers produce identical search responses through these layers:

1. **Pre-execution** (before routing): intercepts all web_search/web_fetch tools from ANY provider, runs DDG locally, returns inline results with `server_tool_use`. Model is never called for web searches.

2. **Response metadata** (for pre-execUTION bypass): if pre-execution is somehow skipped (e.g., unusual message format), the fallback path still injects `server_tool_use` via protocol translation for OpenAI/Anthropic/Gemini providers.

3. **Model trust**: `getTrustedModel()` maps any slot-override model name to a canonical `claude-*` name that CC trusts for `server_tool_use` rendering.

## Guardrails

| Guardrail | Location | What it prevents |
|-----------|----------|------------------|
| 100KB response cap | `tryPreExecuteWebSearch` | OOM from huge search results |
| 800 char query limit | `tryPreExecuteWebSearch` | DDG abuse via query stuffing |
| JSON sanitization | `tryPreExecuteWebSearch` | Broken SSE from control chars |
| Concurrent fetch slots (5) | `server-tools.ts` | DDG rate limiting |
| Empty result fallback | `webSearch()` | Returns "No results" instead of empty |
| Cookie jar persistence | `ddgLiteSearch` | Session reuse across queries |
| UA rotation | `ddgLiteSearch` | Reduces fingerprinting |
| 500KB data limit | `ddgLiteSearch` | Memory guard on DDG response |
| UTF-8 safe truncation | `safeSlice()` | No broken surrogate pairs |
| Search cache (5s TTL) | `server-tools.ts` | Dedupes identical queries |

## Key Files

- `proxy/server-tools.ts` — DDG scraper, webSearch(), extractSearchQuery(), populateToolResults()
- `proxy/start-proxy.ts` — tryPreExecuteWebSearch(), tool detection, early/late hooks
- `proxy/model-trust.ts` — getTrustedModel()
- `proxy/ddg-playwright.ts` — Playwright reference (currently non-functional due to DDG TLS fingerprinting)
- `proxy/__tests__/server-tools.test.ts` — 137 scraper tests
- `proxy/__tests__/integration.test.ts` — 4 pre-execution tests
- `proxy/__tests__/model-trust.test.ts` — 19 trust model tests

## Related Skills

- `/restart-proxy` — hot-swap to pick up search fixes
- `/verify` — check a change actually works
