---
name: search-debug
description: Trace and debug web search through the proxy — DDG scraper health, pre-execution, guardrails, provider standardization
---

# Search Debug

End-to-end web search diagnostics. Traces every layer of the pipeline and verifies all guardrails.

## Quick Check

```bash
node -e "
const { ddgLiteSearch, webSearch, webSearchStructured, populateToolResults, extractSearchQuery,
  _resetDdgCookies, _resetSearchCache, _resetFetchSlots } = require('./proxy/server-tools');
const { validatePreExecResponse } = require('./proxy/pre-exec-validate');
const { getTrustedModel } = require('./proxy/model-trust');
async function test() {
  _resetDdgCookies(); _resetSearchCache(); _resetFetchSlots();

  // Tier 1: DDG Lite POST (structured)
  console.log('=== DDG Lite Structured ===');
  const r = await webSearchStructured('test query');
  console.log(r.length > 0 ? '✅ ' + r.length + ' results' : '❌ Empty');
  if (r[0]) console.log('   title=' + r[0].title.slice(0, 60));
  if (r[0]) console.log('   url=' + r[0].url.slice(0, 60));
  if (r[0]) console.log('   snippet=' + (r[0].snippet || '').slice(0, 60));

  // Tier 2: Full pipeline
  console.log('=== webSearch() ===');
  _resetSearchCache();
  const w = await webSearch('test query');
  console.log(w.length > 100 ? '✅ ' + w.length + ' chars' : '❌ Short/empty');
  console.log(w.split('\n').slice(0, 3).join('\n'));

  // Tier 3: Response validation
  console.log('=== validatePreExecResponse (valid) ===');
  const validBody = {
    model: 'claude-haiku-4-5-20251001',
    content: [{
      type: 'web_search_tool_result',
      tool_use_id: 'toolu_SEARCH_TEST',
      caller: { type: 'direct' },
      content: [{
        type: 'web_search_result', url: 'https://example.com',
        title: 'Test', encrypted_content: 'snippet', page_age: null
      }]
    }],
    usage: { input_tokens: 1, output_tokens: 50, server_tool_use: { web_search_requests: 1, web_fetch_requests: 0 } }
  };
  const ve = validatePreExecResponse(validBody);
  console.log(ve === null ? '✅ Valid' : '❌ ' + ve);

  // Tier 4: Response validation (missing tool_use_id — the actual bug)
  console.log('=== validatePreExecResponse (missing tool_use_id) ===');
  const badBody = {
    model: 'claude-haiku-4-5-20251001',
    content: [{ type: 'web_search_tool_result', content: 'results' }],
    usage: { input_tokens: 1, output_tokens: 50, server_tool_use: { web_search_requests: 1, web_fetch_requests: 0 } }
  };
  const be = validatePreExecResponse(badBody);
  console.log(be !== null ? '✅ Caught: ' + be : '❌ Missed!');

  // Tier 5: Model trust
  console.log('=== Model Trust ===');
  console.log('haiku:deepseek-v4-flash → ' + getTrustedModel('haiku:deepseek-v4-flash'));
  console.log('haiku:claude-haiku-4-5 → ' + getTrustedModel('haiku:claude-haiku-4-5-20251001'));

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
# 1. Check proxy version and health
curl -s http://127.0.0.1:$(cat ~/.deepclaude/proxy.port)/health | grep -o '"version":"[^"]*"'

# 2. Verify proxy log for WEB_SEARCH_PREX entries
strings ~/.deepclaude/proxy.log | grep WEB_SEARCH | tail -5

# 3. Check DDG scraper directly
npx tsx -e "require('./proxy/server-tools').ddgLiteSearch('test').then(r => console.log(r.length, 'results'))"

# 4. Test pre-execution through proxy (non-streaming)
curl -s --max-time 15 -X POST http://127.0.0.1:$(cat ~/.deepclaude/proxy.port)/v1/messages \
  -H "Content-Type: application/json" -H "x-api-key: deepclaude-$(cat ~/.deepclaude/proxy.port)" \
  -d '{"model":"haiku:deepseek-v4-flash","max_tokens":200,"stream":false,
    "tools":[{"type":"web_search_20250305","name":"web_search","description":"Search",
    "input_schema":{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}}],
    "tool_choice":{"type":"tool","name":"web_search_20250305"},
    "system":[{"type":"text","text":"You are an assistant for performing a web search tool use"}],
    "messages":[{"role":"user","content":[{"type":"text","text":"Perform a web search for the query: test"}]}]}' \
  2>&1 | python -m json.tool 2>/dev/null | head -30

# 5. Verify web_search_tool_result format (the critical check)
curl -s --max-time 15 -X POST http://127.0.0.1:$(cat ~/.deepclaude/proxy.port)/v1/messages \
  -H "Content-Type: application/json" -H "x-api-key: deepclaude-$(cat ~/.deepclaude/proxy.port)" \
  -d '{"model":"haiku:deepseek-v4-flash","max_tokens":200,"stream":false,
    "tools":[{"type":"web_search_20250305","name":"web_search"}],
    "system":[{"type":"text","text":"web search assistant"}],
    "messages":[{"role":"user","content":[{"type":"text","text":"Perform a web search for the query: test"}]}]}' \
  2>&1 | grep -o '"web_search_tool_result"'

# 6. Run all web search tests
npx jest proxy/__tests__/server-tools.test.ts proxy/__tests__/integration.test.ts proxy/__tests__/pre-exec-validate.test.ts --no-coverage
```

## CC Response Format (CRITICAL)

CC counts `web_search_tool_result` content blocks to determine "Did N searches". The response MUST include:

```json
{
  "model": "claude-haiku-4-5-20251001",
  "content": [{
    "type": "web_search_tool_result",
    "tool_use_id": "toolu_SEARCH_N",
    "caller": { "type": "direct" },
    "content": [{
      "type": "web_search_result",
      "url": "https://...",
      "title": "...",
      "encrypted_content": "...",
      "page_age": null
    }]
  }],
  "usage": {
    "server_tool_use": { "web_search_requests": 1, "web_fetch_requests": 0 }
  }
}
```

### What CC Ignores

- ❌ Text content blocks (`{ type: 'text', text: '...' }`) — CC counts 0 searches
- ❌ web_search_tool_result without `tool_use_id` — "Web search error: undefined"
- ❌ web_search_tool_result without `caller` — "Web search error: undefined"
- ❌ Model not starting with `claude-` — server_tool_use silently ignored
- ❌ Plain string `content` instead of web_search_result array — results not displayed

### Validation Guardrail

`pre-exec-validate.ts` checks ALL these fields before sending. Called for both streaming and non-streaming paths. See [[web-search-tool-result-format]].

## Failure Modes

| Symptom | Diagnosis | Fix |
|---------|-----------|-----|
| "Did 0 searches" with text blocks | Pre-exec returns text not web_search_tool_result | Check tryPreExecuteWebSearch content type |
| "Web search error: undefined" | Missing tool_use_id or caller field | Check validatePreExecResponse catches it |
| "Did 0 searches" despite correct format | Model doesn't start with claude- | Check getTrustedModel() output |
| "Did 0 searches" despite everything correct | CC Explore not routing through proxy | Check ANTHROPIC_BASE_URL on port |
| Empty DDG results | Bot detection / CAPTCHA | DDG may have changed — check cookie jar |
| No WEB_SEARCH_PREX in log | extractSearchQuery returned null | Message format may differ |
| 502 / fallback exhausted | No providers configured | Check routes.json / slot-overrides.json |

## Provider Standardization

All providers produce identical search responses through these layers:

1. **Pre-execution** (before routing): intercepts all web_search/web_fetch tools from ANY provider, runs DDG locally, returns inline results with proper web_search_tool_result format. Model is never called for web searches.

2. **Response metadata** (for pre-execution bypass): if pre-execution is somehow skipped (e.g., unusual message format), the fallback path still injects `server_tool_use` via protocol translation for OpenAI/Anthropic/Gemini providers.

3. **Model trust**: `getTrustedModel()` maps any slot-override model name to a canonical `claude-*` name that CC trusts for `server_tool_use` rendering.

4. **Format validation**: `validatePreExecResponse()` checks ALL required fields before any response is sent.

## Guardrails (5-Layer Defense)

| Layer | Location | What it prevents |
|-------|----------|------------------|
| Type system | `protocol-types.ts` | Missing fields caught at compile time |
| Response validator | `pre-exec-validate.ts` | Malformed blocks caught at runtime (both stream + non-stream) |
| Integration tests | `integration.test.ts` | Regression in pre-execution response format |
| Unit tests | `pre-exec-validate.test.ts` | 25 validation tests covering all field combinations |
| Search debug skill | This file | Manual diagnostics for live debugging |

### Additional Runtime Guards

| Guardrail | Location | What it prevents |
|-----------|----------|------------------|
| 100KB response cap | `tryPreExecuteWebSearch` | OOM from huge search results |
| 15 result max | `tryPreExecuteWebSearch` | Realistic limit (DDG rarely returns more) |
| 800 char query limit | `tryPreExecuteWebSearch` | DDG abuse via query stuffing |
| JSON sanitization | `tryPreExecuteWebSearch` | Broken JSON from control chars/surrogates |
| Concurrent fetch slots (5) | `server-tools.ts` | DDG rate limiting |
| Empty result fallback | `tryPreExecuteWebSearch` | Returns proper web_search_result with "No results" |
| Cookie jar persistence | `ddgLiteSearch` | Session reuse across queries |
| UA rotation | `ddgLiteSearch` | Reduces fingerprinting |
| 500KB data limit | `ddgLiteSearch` | Memory guard on DDG response |
| UTF-8 safe truncation | `safeSlice()` | No broken surrogate pairs |
| Search cache (5s TTL) | `server-tools.ts` | Dedupes identical queries |

## Key Files

- `proxy/server-tools.ts` — DDG scraper, webSearch(), webSearchStructured(), extractSearchQuery(), populateToolResults()
- `proxy/start-proxy.ts` — tryPreExecuteWebSearch(), tool detection, early/late hooks, both stream/non-stream validation
- `proxy/pre-exec-validate.ts` — validatePreExecResponse() — checks ALL required fields
- `proxy/model-trust.ts` — getTrustedModel()
- `proxy/protocol-types.ts` — web_search_tool_result, web_search_result, caller type definitions
- `proxy/ddg-playwright.ts` — (removed — non-functional, DDG TLS fingerprinting prevents headless browser scraping)
- `proxy/__tests__/server-tools.test.ts` — 141 scraper + webSearchStructured tests
- `proxy/__tests__/integration.test.ts` — 4 pre-execution tests with format assertions
- `proxy/__tests__/pre-exec-validate.test.ts` — 25 validation tests

## Memory Files

- [[web-search-tool-result-format]] — Exact format CC requires
- [[web-search-guardrails]] — Five-layer defense
- [[web-search-architecture]] — Full pipeline
- [[web-search-pre-execution]] — Why pre-execution beats model-mediated

## Related Skills

- `/restart-proxy` — hot-swap to pick up search fixes
- `/verify` — check a change actually works
