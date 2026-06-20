export const meta = {
  name: 'defiant-cache-qa',
  description: 'QA audit of Defiant for cache-invalidation and cost-inefficiency issues',
  phases: [
    { title: 'Cache Core' },
    { title: 'Body Pipeline' },
    { title: 'SSE' },
    { title: 'Config' },
    { title: 'Synthesis' },
  ],
}

var ROOT = 'C:\\OC\\defiant'

phase('Cache Core')
phase('Body Pipeline')
phase('SSE')
phase('Config')

var findings = []

// AGENT 1: Thinking cache injection
phase('Cache Core')
var a1 = await agent("Read " + ROOT + "/proxy/thinking-cache.ts and " + ROOT + "/proxy/session-key.ts. Analyze these questions with FILE:LINE evidence:\n\n1. In injectThinkingBlocks(), what messageCount is passed to retrieve()? If it doesn't match what was stored, the cache returns null, thinking blocks aren't injected, request body differs -> DeepSeek cache miss at 50x cost.\n\n2. In the store() call at forward.ts:763, what is passed as messageCount? Has the response message been added yet?\n\n3. Session key stability: sessionKey() hashes firstUserMsg.content + systemHint.slice(0,500). After stripSystemBillingHeader() removes the billing header block, does sessionKey() produce the same hash? The systemHint joins ALL system block texts.\n\n4. TTL mismatch: TTL is 30 minutes. DeepSeek disk cache persists hours to days. After 30 min the in-memory entry expires. Next request arrives without cached thinking blocks -> request body differs -> cache miss.\n\n5. LRU eviction at 1000 entries: on set(), the FIRST key in Map iteration order is evicted. In a long session, could the PREVIOUS turn's thinking entry be evicted before the next turn needs it?\n\n6. Disk persistence race: writeToDisk() overwrites files. loadFromDisk() reads all .json files. If a concurrent request calls writeToDisk() while loadFromDisk() is mid-iteration, could we get a partial read?\n\nAnswer each question with SEVERITY (critical/high/medium/low), CATEGORY (cache-miss/data-loss/race-condition/cost/correctness), and a clear recommendation.", {label: 'cache-core', schema: {type: 'object', properties: {findings: {type: 'array', items: {type: 'object', properties: {title: {type: 'string'}, severity: {type: 'string', enum: ['critical','high','medium','low']}, category: {type: 'string', enum: ['cache-miss','data-loss','race-condition','cost','correctness']}, file: {type: 'string'}, line: {type: 'number'}, description: {type: 'string'}, impact: {type: 'string'}, recommendation: {type: 'string'}}, required: ['title','severity','category','file','line','description','impact','recommendation']}}}, required: ['findings']}})
if (a1) { findings = findings.concat(a1.findings) }

// AGENT 2: Body pipeline
phase('Body Pipeline')
var a2 = await agent("Read " + ROOT + "/proxy/protocol-types.ts lines 800-940 and " + ROOT + "/proxy/start-proxy.ts lines 1540-1580 and 1800-1847.\n\nAnalyze:\n\n1. At start-proxy.ts:1548, stripSystemBillingHeader is inside 'if (constraints.stripFields && constraints.stripFields.length > 0)'. What if the provider has NO stripFields? Does the billing header (with the ever-changing cch hash) still get stripped? If not, every request has a different cch -> 0% cache hit rate. Check the constraints for 'ds' / deepseek.\n\n2. stripDuplicateMessages() compares consecutive messages with deepEqual on content. Could it remove a legitimate duplicate message (e.g., user double-sends)? Removing one shifts the entire message sequence -> all subsequent cache prefixes invalidated.\n\n3. The strips happen at lines 1548-1567. Thinking injection at lines 1802-1847. Are both in the SAME code path? Could the body reach upstream without going through strips but with thinking injection?\n\n4. What about subagent requests - same path?", {label: 'pipeline', schema: {type: 'object', properties: {findings: {type: 'array', items: {type: 'object', properties: {title: {type: 'string'}, severity: {type: 'string', enum: ['critical','high','medium','low']}, category: {type: 'string', enum: ['cache-miss','correctness','cost','design']}, file: {type: 'string'}, line: {type: 'number'}, description: {type: 'string'}, impact: {type: 'string'}, recommendation: {type: 'string'}}, required: ['title','severity','category','file','line','description','impact','recommendation']}}}, required: ['findings']}})
if (a2) { findings = findings.concat(a2.findings) }

// AGENT 3: SSE forwarding + timeouts
phase('SSE')
var a3 = await agent("Read " + ROOT + "/proxy/forward.ts lines 273-330 (timeout constants), 391-469 (peekFirstChunk), 695-730 (heartbeat/deadline), 1365-1403 (extractStreamUsage). Also " + ROOT + "/proxy/start-proxy.ts lines 1850-1950.\n\nAnalyze:\n\n1. FIRST_BYTE_TIMEOUT_MS = 15s (line 288). DeepSeek extended thinking can take >15s before first SSE byte. Does the 15s timer fire, destroying the connection and causing retries? Each retry is at 50x miss cost.\n\n2. STREAM_HEARTBEAT_MS = 180s. For DeepSeek thinking budget=16K tokens, thinking takes 2+ minutes. Could 180s heartbeat fire before model finishes? Stream killed -> response lost -> user retries -> new request (cache miss if thinking blocks not extracted).\n\n3. extractStreamUsage() at line 1372: if the usage SSE event is in the last chunk of rawUsageBuf after truncation at line 840, is it lost? Check the truncation logic.\n\n4. In streaming path (line 753): accumulatedBlocks is populated by 'data' listener. On 'end' (line 772), extractThinkingBlocks runs. Is accumulatedBlocks guaranteed to be complete when 'end' fires in Node.js streams?\n\n5. Gzip decompression (line 634-655): if gunzip fails, log continues. Could corrupted output waste upstream tokens?", {label: 'sse', schema: {type: 'object', properties: {findings: {type: 'array', items: {type: 'object', properties: {title: {type: 'string'}, severity: {type: 'string', enum: ['critical','high','medium','low']}, category: {type: 'string', enum: ['cache-miss','cost','correctness','waste']}, file: {type: 'string'}, line: {type: 'number'}, description: {type: 'string'}, impact: {type: 'string'}, recommendation: {type: 'string'}}, required: ['title','severity','category','file','line','description','impact','recommendation']}}}, required: ['findings']}})
if (a3) { findings = findings.concat(a3.findings) }

// AGENT 4: Config hot-reload + routing
phase('Config')
var a4 = await agent("Read " + ROOT + "/proxy/config.ts (hot-reload at lines 457-579), " + ROOT + "/proxy/router.ts, " + ROOT + "/proxy/start-proxy.ts lines 680-700.\n\nAnalyze:\n\n1. checkReload() polls every 1 second. If user edits providers.json mid-session changing thinking budget, does the NEXT request include a different 'thinking: { budget_tokens: N }'? This changes the request prefix -> DeepSeek cache miss on every subsequent turn.\n\n2. Slot overrides hot-reloaded. If user swaps 'opus' from 'deepseek-v4-pro' to 'gpt-5', does the model field in the request change? Different model name -> different prefix -> 100% cache miss.\n\n3. When a provider's format changes from 'anthropic' to 'openai' via hot-reload, the request pipeline switches from injectThinkingBlocks to reinjectReasoningContent + thinking block stripping. Could a partial reload apply half the changes?\n\n4. Provider failure -> fallback with different format -> different translation path -> different request body structure even for same logical content.\n\n5. Initial load: does it use safeReadJson validation or could a malformed providers.json crash the proxy?", {label: 'config', schema: {type: 'object', properties: {findings: {type: 'array', items: {type: 'object', properties: {title: {type: 'string'}, severity: {type: 'string', enum: ['critical','high','medium','low']}, category: {type: 'string', enum: ['cache-miss','correctness','cost','design']}, file: {type: 'string'}, line: {type: 'number'}, description: {type: 'string'}, impact: {type: 'string'}, recommendation: {type: 'string'}}, required: ['title','severity','category','file','line','description','impact','recommendation']}}}, required: ['findings']}})
if (a4) { findings = findings.concat(a4.findings) }

// SYNTHESIS
phase('Synthesis')

var severityOrder = { critical: 0, high: 1, medium: 2, low: 3 }
findings.sort(function(a, b) { return (severityOrder[a.severity] || 99) - (severityOrder[b.severity] || 99) })

var criticalCount = findings.filter(function(f) { return f.severity === 'critical' }).length
var highCount = findings.filter(function(f) { return f.severity === 'high' }).length
var cacheMissCount = findings.filter(function(f) { return f.category === 'cache-miss' }).length
var costCount = findings.filter(function(f) { return f.category === 'cost' || f.category === 'waste' }).length

log('=== Defiant Cache QA Results ===')
log('Total: ' + findings.length + ' findings (' + criticalCount + ' critical, ' + highCount + ' high, ' + cacheMissCount + ' cache-miss, ' + costCount + ' cost/waste)')

var sevs = ['critical', 'high', 'medium', 'low']
for (var si = 0; si < sevs.length; si++) {
  var items = findings.filter(function(f) { return f.severity === sevs[si] })
  if (items.length === 0) continue
  log('')
  log('## ' + sevs[si].toUpperCase())
  for (var fi = 0; fi < items.length; fi++) {
    var f = items[fi]
    log('')
    log('### [' + f.category.toUpperCase() + '] ' + f.title)
    log(f.file + ':' + f.line)
    log(f.description)
    log('Impact: ' + f.impact)
    log('Fix: ' + f.recommendation)
  }
}

log('')
log('## TOP 3')
var top3 = findings.slice(0, 3)
for (var ti = 0; ti < top3.length; ti++) {
  log((ti + 1) + '. [' + top3[ti].severity + '] ' + top3[ti].title)
  log('   ' + top3[ti].file + ':' + top3[ti].line)
  log('   ' + top3[ti].recommendation)
}

return {
  findings: findings,
  summary: {
    total: findings.length,
    critical: criticalCount,
    high: highCount,
    cacheMissIssues: cacheMissCount,
    costIssues: costCount,
  },
  topIssues: top3,
}
