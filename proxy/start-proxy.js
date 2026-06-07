const http = require('http');
const https = require('https');
const fs = require('fs');
const { URL } = require('url');
const { Transform } = require('stream');
const { translateRequest, translateResponse, createStreamTransformer } = require('./protocol-translate');
const { injectThinkingBlocks, extractThinkingBlocks, store } = require('./thinking-cache');

const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 50, keepAliveMsecs: 30000 });

const args = process.argv.slice(2);

function readJson(path) {
    const raw = fs.readFileSync(path, 'utf-8').replace(/^﻿/, '');
    return JSON.parse(raw);
}

let routesFile = null;
let routesMtime = 0;
let overridesFile = null;
let overridesMtime = 0;
let singleUrl = null;
let singleKey = null;

if (args[0] === '--routes' && args[1]) {
    routesFile = args[1];
    if (args[2] === '--overrides' && args[3]) {
        overridesFile = args[3];
    }
} else if (args.length >= 2) {
    singleUrl = args[0];
    singleKey = args[1];
} else {
    console.error('Usage: node start-proxy.js <provider_url> <api_key>');
    console.error('       node start-proxy.js --routes <routes.json> [--overrides <overrides.json>]');
    process.exit(1);
}

let routing = null;
if (routesFile) {
    routing = readJson(routesFile);
    routesMtime = fs.statSync(routesFile).mtimeMs;
}

let slotOverrides = {};
if (overridesFile) {
    try {
        slotOverrides = readJson(overridesFile);
        overridesMtime = fs.statSync(overridesFile).mtimeMs;
    } catch (e) {
        // Overrides file optional — may not exist yet
    }
}

let lastStatCheck = 0;
function checkReload() {
    const now = Date.now();
    if (now - lastStatCheck < 1000) return;
    lastStatCheck = now;
    if (routesFile) {
        try {
            const stat = fs.statSync(routesFile);
            if (stat.mtimeMs > routesMtime) {
                routing = readJson(routesFile);
                routesMtime = stat.mtimeMs;
            }
        } catch (e) {
            console.error('Failed to reload routes:', e.message);
        }
    }
    if (overridesFile) {
        try {
            const stat = fs.statSync(overridesFile);
            if (stat.mtimeMs > overridesMtime) {
                slotOverrides = readJson(overridesFile);
                overridesMtime = stat.mtimeMs;
            }
        } catch (e) {
            console.error(`Failed to reload ${overridesFile}:`, e.message);
        }
    }
}

function isProviderHealthy(key) {
    const s = providerStats[key];
    if (!s || s.requests < 3) return true;
    const failRate = s.fails / s.requests;
    if (failRate >= 0.5) return false;
    return true;
}

function resolveTarget(model) {
    if (!routing) {
        const targetUrl = new URL(singleUrl);
        const isBearer = !targetUrl.hostname.includes('deepseek.com');
        const primary = { providerKey: 'direct', url: singleUrl, key: singleKey, isBearer, targetUrl, rewriteModel: null, format: 'anthropic' };
        return { primary, fallbacks: [] };
    }

    // Slot prefix: "sonnet:oc:big-pickle" → check overrides, fall back to model after prefix
    const slotMatch = model && model.match(/^(sonnet|opus|haiku|subagent):(.+)$/);
    if (slotMatch) {
        const slot = slotMatch[1];
        const fallback = slotMatch[2];
        model = slotOverrides[slot] || fallback;
    }

    let providerKey = null, rewriteModel = null;

    // Check for providerKey:modelId prefix (explicit provider override from /model)
    const prefixMatch = model && model.match(/^([a-z][a-z0-9_-]*):(.+)$/);
    if (prefixMatch && routing.providers[prefixMatch[1]]) {
        providerKey = prefixMatch[1];
        rewriteModel = prefixMatch[2];
    } else {
        // Fall back to routes table lookup
        const route = (model && routing.routes[model]) || null;

        if (!route) {
            providerKey = routing.defaultProvider || null;
        } else if (typeof route === 'string') {
            providerKey = route;
        } else if (route && typeof route === 'object' && route.provider) {
            providerKey = route.provider;
            rewriteModel = route.rewrite || null;
        } else {
            providerKey = routing.defaultProvider || null;
        }
    }

    const provider = providerKey ? routing.providers[providerKey] : null;
    if (!provider) {
        return { error: providerKey ? `Unknown provider: ${providerKey}` : 'No default provider configured' };
    }

    const targetUrl = new URL(provider.url);
    let primary = {
        providerKey,
        url: provider.url,
        key: process.env[provider.keyEnv] || provider.key,
        isBearer: provider.auth === 'bearer',
        targetUrl: targetUrl,
        rewriteModel: rewriteModel,
        format: provider.format || 'anthropic',
    };

    const fallbacks = [];
    if (provider.fallback && Array.isArray(provider.fallback)) {
        for (const fbKey of provider.fallback) {
            if (fbKey === providerKey) continue;
            const fb = routing.providers[fbKey];
            if (!fb || !(process.env[fb.keyEnv] || fb.key)) continue;
            const fbUrl = new URL(fb.url);

            // Resolve the correct model rewrite for the fallback provider.
            // Don't inherit the primary's rewriteModel — different providers
            // use different model names (e.g. oc rewrites to "big-pickle"
            // but ds needs "deepseek-v4-pro").
            let fbRewrite = null;
            const fbRouteEntry = (model && routing.routes[model]) || null;
            if (fbRouteEntry) {
                const fbProv = typeof fbRouteEntry === 'string' ? fbRouteEntry : (fbRouteEntry.provider || null);
                if (fbProv === fbKey) {
                    fbRewrite = typeof fbRouteEntry === 'object' ? (fbRouteEntry.rewrite || null) : null;
                }
            }

            fallbacks.push({
                providerKey: fbKey,
                url: fb.url,
                key: process.env[fb.keyEnv] || fb.key,
                isBearer: fb.auth === 'bearer',
                targetUrl: fbUrl,
                rewriteModel: fbRewrite,
                format: fb.format || 'anthropic',
            });
        }
    }

    // Circuit breaker: skip unhealthy primary
    if (fallbacks.length > 0 && !isProviderHealthy(primary.providerKey)) {
        const healthyFallbackIdx = fallbacks.findIndex(f => isProviderHealthy(f.providerKey));
        if (healthyFallbackIdx >= 0) {
            const tmp = primary;
            primary = fallbacks[healthyFallbackIdx];
            fallbacks[healthyFallbackIdx] = tmp;
        }
    }

    return { primary, fallbacks };
}

// --- Anthropic server-side tool handling ---

const SERVER_TOOL_PREFIXES = [
    'web_search_',
    'web_fetch_',
    'url_fetch_',
    'computer_',
    'bash_',
    'text_editor_',
    'memory_',
    'tool_search_tool_',
];

function isServerToolType(type) {
    if (!type || typeof type !== 'string') return false;
    return SERVER_TOOL_PREFIXES.some(prefix => type.startsWith(prefix));
}

const WEB_SEARCH_SCHEMA = {
    type: 'object',
    properties: {
        query: { type: 'string', description: 'The search query' },
    },
    required: ['query'],
};

const WEB_FETCH_SCHEMA = {
    type: 'object',
    properties: {
        url: { type: 'string', description: 'URL to fetch content from' },
    },
    required: ['url'],
};

function convertServerTools(tools) {
    if (!tools || !Array.isArray(tools)) return { tools, hasWebSearch: false, hasWebFetch: false };

    let hasWebSearch = false;
    let hasWebFetch = false;

    const converted = tools.map(tool => {
        if (!tool || typeof tool !== 'object') return tool;

        const type = tool.type || '';
        if (type.startsWith('web_search_')) {
            hasWebSearch = true;
            return {
                type: 'custom',
                name: 'web_search',
                description: 'Search the web for current, up-to-date information. Returns relevant text snippets and URLs.',
                input_schema: WEB_SEARCH_SCHEMA,
            };
        }
        if (type.startsWith('web_fetch_') || type.startsWith('url_fetch_')) {
            hasWebFetch = true;
            return {
                type: 'custom',
                name: 'web_fetch',
                description: 'Fetch and read content from a URL. Returns the text content of the page.',
                input_schema: WEB_FETCH_SCHEMA,
            };
        }
        return tool;
    });

    return { tools: converted, hasWebSearch, hasWebFetch };
}

// --- Web search execution (DuckDuckGo — free, no API key) ---

function webSearch(query) {
    return new Promise((resolve) => {
        const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&no_redirect=1`;
        https.get(url, { headers: { 'User-Agent': 'deepclaude-proxy/1.0' }, timeout: 15000 }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    const results = [];
                    if (parsed.AbstractText) results.push(parsed.AbstractText);
                    if (parsed.AbstractURL) results.push(`Source: ${parsed.AbstractURL}`);
                    if (parsed.Answer) results.push(`Answer: ${parsed.Answer}`);
                    const topics = parsed.RelatedTopics || [];
                    for (const topic of topics.slice(0, 8)) {
                        if (topic.Text) results.push(`- ${topic.Text}`);
                        if (topic.FirstURL) results.push(`  ${topic.FirstURL}`);
                    }
                    const text = results.join('\n') || `No results found for query: "${query}"`;
                    resolve(text);
                } catch {
                    resolve(`Search completed but results could not be parsed for: "${query}"`);
                }
            });
        }).on('error', (err) => {
            resolve(`Web search failed: ${err.message}. Query was: "${query}"`);
        }).on('timeout', () => {
            resolve(`Web search timed out for query: "${query}"`);
        });
    });
}

// --- Web fetch execution ---

function isPrivateIPv4(host) {
    return host === '127.0.0.1' || host === '0.0.0.0' ||
        /^10\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
        /^192\.168\./.test(host) || /^169\.254\./.test(host);
}

function webFetch(url, _depth = 0, _visited = new Set()) {
    try {
        const parsed = new URL(url);
        const hostname = parsed.hostname;
        if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' ||
            /^10\./.test(hostname) || /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
            /^192\.168\./.test(hostname) || /^169\.254\./.test(hostname) ||
            /^0\.0\.0\.0$/.test(hostname)) {
            return Promise.resolve('Error: Access to internal/private networks is blocked.');
        }
        // Block all-numeric hostnames (integer-form IPs like 2130706433)
        if (/^\d+$/.test(hostname)) return Promise.resolve('Error: Access to internal/private networks is blocked.');
        // Block hex-form IPs (e.g. 0x7f000001)
        if (/^0x[0-9a-fA-F]+$/.test(hostname)) return Promise.resolve('Error: Access to internal/private networks is blocked.');
        // Block IPv4-mapped IPv6 private addresses
        if (/^::ffff:/.test(hostname)) {
            const ipv4Part = hostname.replace(/^::ffff:/, '');
            if (isPrivateIPv4(ipv4Part)) return Promise.resolve('Error: Access to internal/private networks is blocked.');
        }
        // Block IPv6 private ranges (ULA fc00::/7, link-local fe80::/10)
        if (hostname.startsWith('fc') || hostname.startsWith('fd') ||
            hostname.startsWith('fe8') || hostname.startsWith('fe9') ||
            hostname.startsWith('fea') || hostname.startsWith('feb')) {
            return Promise.resolve('Error: Access to internal/private networks is blocked.');
        }
    } catch (e) { return Promise.resolve('Error: Invalid URL.'); }
    if (_depth > 5 || _visited.has(url)) return Promise.resolve('Too many redirects fetching: ' + url);
    _visited.add(url);
    return new Promise((resolve) => {
        const parsedUrl = new URL(url);
        const transport = parsedUrl.protocol === 'https:' ? https : http;
        const req = transport.get(url, { headers: { 'User-Agent': 'deepclaude-proxy/1.0' }, timeout: 20000 }, (res) => {
            // Follow redirects
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                webFetch(new URL(res.headers.location, url).href, _depth + 1, _visited).then(resolve);
                return;
            }
            let data = '';
            res.on('data', chunk => {
                data += chunk;
                if (data.length > 1_000_000) { res.destroy(); resolve(data.slice(0, 1_000_000) + '\n\n[Content truncated at 1MB]'); }
            });
            res.on('end', () => {
                // Simple HTML → text extraction
                const text = data.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
                    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                    .replace(/<[^>]+>/g, ' ')
                    .replace(/&amp;/g, '&')
                    .replace(/&lt;/g, '<')
                    .replace(/&gt;/g, '>')
                    .replace(/&quot;/g, '"')
                    .replace(/&#39;/g, "'")
                    .replace(/\s+/g, ' ')
                    .trim()
                    .slice(0, 50000);
                resolve(text || `Fetched ${url} but could not extract text content.`);
            });
        });
        req.on('error', (err) => resolve(`Web fetch failed: ${err.message}. URL was: ${url}`));
        req.on('timeout', () => { req.destroy(); resolve(`Web fetch timed out for URL: ${url}`); });
    });
}

// --- Check and populate empty tool results for web_search / web_fetch ---

function hasPendingToolResult(messages) {
    if (!messages || !Array.isArray(messages)) return { needsPopulation: false };

    const toolUseIds = new Map(); // tool_use_id → { name, input }

    // Collect all tool_use blocks from assistant messages
    for (const msg of messages) {
        if (msg.role !== 'assistant') continue;
        const content = Array.isArray(msg.content) ? msg.content : [];
        for (const block of content) {
            if (block.type === 'tool_use' && (block.name === 'web_search' || block.name === 'web_fetch')) {
                toolUseIds.set(block.id, { name: block.name, input: block.input || {} });
            }
        }
    }

    if (toolUseIds.size === 0) return { needsPopulation: false };

    // Check for empty/error tool_results matching our tool_use blocks
    const emptyResults = [];
    for (const msg of messages) {
        if (msg.role !== 'user') continue;
        const content = Array.isArray(msg.content) ? msg.content : [];
        for (const block of content) {
            if (block.type !== 'tool_result') continue;
            const toolUseId = block.tool_use_id;
            const toolInfo = toolUseIds.get(toolUseId);
            if (!toolInfo) continue;

            const resultContent = block.content;
            const isEmpty = !resultContent ||
                (typeof resultContent === 'string' && resultContent.trim() === '') ||
                (typeof resultContent === 'string' && resultContent.includes('not recognized')) ||
                (typeof resultContent === 'string' && resultContent.includes('No tool implementation found')) ||
                (Array.isArray(resultContent) && resultContent.length === 0);

            if (isEmpty) {
                emptyResults.push({ block, toolInfo });
            }
        }
    }

    return { needsPopulation: emptyResults.length > 0, emptyResults };
}

async function populateToolResults(messages) {
    const { emptyResults } = hasPendingToolResult(messages);
    if (!emptyResults || emptyResults.length === 0) return false;

    for (const { block, toolInfo } of emptyResults) {
        if (toolInfo.name === 'web_search') {
            const query = toolInfo.input.query || toolInfo.input.q || toolInfo.input.search || '';
            if (query) {
                const result = await webSearch(query);
                block.content = result;
            }
        } else if (toolInfo.name === 'web_fetch') {
            const url = toolInfo.input.url || toolInfo.input.uri || '';
            if (url) {
                const result = await webFetch(url);
                block.content = result;
            }
        }
    }

    return true;
}

// --- Stream warmup: peek first SSE chunk before committing headers ---

function peekFirstChunk(proxyRes, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const contentType = proxyRes.headers['content-type'] || '';
    if (!contentType.includes('text/event-stream')) {
      return resolve({ ok: true, firstChunk: null });
    }

    let resolved = false;
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      proxyRes.removeListener('readable', onReadable);
      proxyRes.removeListener('error', onError);
      proxyRes.destroy();
      resolve({ ok: false, reason: 'timeout' });
    }, timeoutMs);

    const onReadable = () => {
      if (resolved) return;
      const chunk = proxyRes.read();
      if (chunk !== null) {
        resolved = true;
        clearTimeout(timer);
        proxyRes.removeListener('readable', onReadable);
        proxyRes.removeListener('error', onError);
        proxyRes.unshift(chunk);
        resolve({ ok: true, firstChunk: chunk });
      }
    };

    const onError = () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      proxyRes.removeListener('readable', onReadable);
      proxyRes.removeListener('error', onError);
      resolve({ ok: false, reason: 'error', message: 'stream error during peek' });
    };

    proxyRes.on('readable', onReadable);
    proxyRes.once('error', onError);
  });
}

// --- Main server ---

const startTime = Date.now();
const providerStats = {}; // providerKey → { requests, successes, fails, totalMs }
let requestIdCounter = 0;

const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        const healthStats = {};
        for (const [k, v] of Object.entries(providerStats)) {
            healthStats[k] = { requests: v.requests, successes: v.successes, fails: v.fails, avgMs: v.requests ? Math.round(v.totalMs / v.requests) : 0 };
        }
        res.end(JSON.stringify({ status: 'ok', uptime: Date.now() - startTime, providers: healthStats }));
        return;
    }

    checkReload();

    const contentLength = parseInt(req.headers['content-length'], 10);
    if (contentLength > 10_000_000) {
        res.writeHead(413, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'api_error', message: 'request body too large' } }));
        req.destroy();
        return;
    }
    let body = '';
    req.on('data', chunk => {
        body += chunk;
        if (body.length > 10_000_000) { res.writeHead(413, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { type: 'api_error', message: 'request body too large' } })); req.destroy(); }
    });
    req.on('end', () => {
        const reqId = ++requestIdCounter;
        (async () => {
        let model = null;
        let parsed = null;
        try { parsed = JSON.parse(body); model = parsed.model; } catch (e) {}

        const urlPath = req.url.split('?')[0];
        const isModelCall = urlPath === '/v1/messages' || urlPath === '/v1/messages/';

        // Non-model calls (OAuth, agent infrastructure, etc.) → passthrough to Anthropic directly.
        // Claude Code sends many API endpoint types through ANTHROPIC_BASE_URL — routing
        // non-/v1/messages calls to non-Anthropic backends causes ConnectionRefused errors.
        if (!isModelCall) {
            const anthro = new URL('https://api.anthropic.com');
            const anthroPath = anthro.pathname.replace(/\/+$/, '') + req.url;
            const anthroHeaders = { ...req.headers };
            delete anthroHeaders['host'];
            delete anthroHeaders['connection'];
            delete anthroHeaders['content-length'];
            delete anthroHeaders['transfer-encoding'];

            const anthroTransport = anthro.protocol === 'https:' ? https : http;
            const anthroReq = anthroTransport.request({
                hostname: anthro.hostname,
                port: 443,
                path: anthroPath,
                method: req.method,
                headers: anthroHeaders,
                timeout: 60000,
            }, (anthroRes) => {
                res.writeHead(anthroRes.statusCode, anthroRes.headers);
                anthroRes.pipe(res);
            });
            anthroReq.on('timeout', () => { anthroReq.destroy(); if (!res.headersSent) { res.writeHead(504); res.end(); } });
            anthroReq.on('error', (err) => { if (!res.headersSent) { res.writeHead(502); res.end(JSON.stringify({ error: err.message })); } });
            anthroReq.write(body);
            anthroReq.end();
            return;
        }

        const resolved = resolveTarget(model);

        if (resolved.error) {
            res.writeHead(502);
            res.end(JSON.stringify({ error: resolved.error }));
            return;
        }

        // Pre-process request body once (tool results, server tools)
        let baseBody = body;
        let bodyPreprocessed = false;
        if (parsed) {
            try {
                let modified = false;

                if (parsed.messages) {
                    const populated = await populateToolResults(parsed.messages);
                    if (populated) modified = true;
                }

                const conv = convertServerTools(parsed.tools);
                if (conv.hasWebSearch || conv.hasWebFetch) {
                    parsed.tools = conv.tools;
                    modified = true;
                }

                if (modified) { baseBody = JSON.stringify(parsed); bodyPreprocessed = true; }
            } catch (e) {}
        }

        const chain = [resolved.primary, ...resolved.fallbacks];
        if (chain.length > 3) chain.length = 3;

        let lastError = null;

        for (let attempt = 0; attempt < chain.length; attempt++) {
            const target = chain[attempt];
            const isRetry = attempt > 0;

            // Rewrite model for this target
            let forwardedBody = baseBody;
            if (target.rewriteModel) {
                try {
                    const p = bodyPreprocessed ? JSON.parse(baseBody) : JSON.parse(body);
                    if (p.model !== target.rewriteModel) { p.model = target.rewriteModel; forwardedBody = JSON.stringify(p); }
                } catch (e) {}
            }

            // Protocol translation
            let streamTransformer = null;
            if (target.format === 'openai') {
                try {
                    const reqParsed = JSON.parse(forwardedBody);
                    const { openaiBody } = translateRequest(reqParsed);
                    forwardedBody = JSON.stringify(openaiBody);
                    if (reqParsed.stream) streamTransformer = createStreamTransformer(model || reqParsed.model);
                } catch (e) {}
            }

            // Build upstream path. target.pathname may overlap with req.url
            // (e.g. provider URL /v1 + request /v1/messages → /v1/messages not /v1/v1/messages).
            // Strip the shared prefix to avoid double path segments.
            const basePath = target.targetUrl.pathname.replace(/\/+$/, '');
            let overlap = '';
            for (let i = 1; i <= Math.min(basePath.length, req.url.length); i++) {
                if (basePath.endsWith(req.url.substring(0, i))) overlap = req.url.substring(0, i);
            }
            const upstreamPath = overlap ? basePath + req.url.substring(overlap.length) : basePath + req.url;

            const options = {
                hostname: target.targetUrl.hostname,
                port: target.targetUrl.port || (target.targetUrl.protocol === 'https:' ? 443 : 80),
                path: upstreamPath,
                method: req.method,
                headers: { ...req.headers },
                timeout: 60000,
                agent: keepAliveAgent,
            };

            delete options.headers['host'];
            delete options.headers['connection'];
            delete options.headers['proxy-authorization'];
            delete options.headers['content-length'];
            delete options.headers['transfer-encoding'];

            if (target.isBearer) {
                options.headers['authorization'] = `Bearer ${target.key}`;
                delete options.headers['x-api-key'];
            } else {
                options.headers['x-api-key'] = target.key;
                delete options.headers['authorization'];
            }

            if (options.hostname === 'openrouter.ai' || options.hostname.endsWith('.openrouter.ai')) {
                options.headers['http-referer'] = 'https://github.com/Poiar/deepclaude';
                options.headers['x-title'] = 'deepclaude';
            }

            // Handle thinking blocks based on target format
            if (target.format === 'anthropic') {
                try {
                    const reqParsed = JSON.parse(forwardedBody);
                    if (reqParsed.messages) {
                        injectThinkingBlocks(reqParsed.messages);
                        forwardedBody = JSON.stringify(reqParsed);
                    }
                } catch (e) {}
            } else if (target.format === 'openai') {
                try {
                    const reqParsed = JSON.parse(forwardedBody);
                    if (reqParsed.messages) {
                        reqParsed.messages = reqParsed.messages.map(m => {
                            if (m.role === 'assistant' && Array.isArray(m.content)) {
                                m.content = m.content.filter(b => b.type !== 'thinking');
                            }
                            return m;
                        });
                        forwardedBody = JSON.stringify(reqParsed);
                    }
                } catch (e) {}
            }

            const transport = options.port === 443 ? https : http;
            const t0 = Date.now();
            const result = await tryForward(transport, options, forwardedBody, streamTransformer, target.format === 'openai');
            const ms = Date.now() - t0;

            if (result.success) {
                recordStat(target.providerKey, true, ms);
                if (isRetry) {
                    console.error(`[#${reqId}] ${req.method} ${model || '-'} → ${target.providerKey} ${result.status} ${ms}ms (fallback #${attempt})`);
                } else {
                    console.error(`[#${reqId}] ${req.method} ${model || '-'} → ${target.providerKey} ${result.status} ${ms}ms`);
                }
                res.writeHead(result.status, result.headers);
                if (result.body) {
                    res.end(result.body);
                } else if (result.stream) {
                    result.stream.on('error', (err) => {
                        console.error(`[#${reqId}] Stream error for ${model}:`, err.message);
                        if (!res.headersSent) {
                            res.writeHead(502, { 'content-type': 'application/json' });
                            res.end(JSON.stringify({ error: { type: 'api_error', message: 'upstream stream failed' } }));
                        } else {
                            res.write('event: error\ndata: {"type":"error","error":{"type":"api_error","message":"upstream stream failed"}}\n\n');
                            res.end();
                        }
                    });
                    result.stream.pipe(res);
                    res.on('close', () => {
                        if (result.stream && !result.stream.destroyed) result.stream.destroy();
                    });
                }
                return;
            }

            recordStat(target.providerKey, false, ms);
            lastError = result.error;
            const label = target.providerKey || 'upstream';
            if (result.status) {
                console.error(`[#${reqId}] ${req.method} ${model || '-'} → ${label} ${result.status} ${ms}ms, trying next...`);
            } else {
                console.error(`[#${reqId}] ${req.method} ${model || '-'} → ${label} ERR ${result.error} ${ms}ms, trying next...`);
            }
        }

        // All attempts failed
        if (!res.headersSent) {
            res.writeHead(502);
            res.end(JSON.stringify({ error: lastError || 'All providers failed' }));
        }
        })().catch(err => {
            console.error('FATAL: unhandled error in request handler:', err);
            if (!res.headersSent) { res.writeHead(502); res.end('{}'); }
        });
    });

function recordStat(providerKey, success, ms) {
        if (!providerKey) return;
        if (!providerStats[providerKey]) providerStats[providerKey] = { requests: 0, successes: 0, fails: 0, totalMs: 0 };
        const s = providerStats[providerKey];
        s.requests++;
        s.totalMs += ms;
        s.lastRequest = Date.now();
        if (success) s.successes++; else s.fails++;
    }

    function tryForward(transport, options, forwardedBody, streamTransformer, isOpenAI) {
        return new Promise((resolve) => {
            const proxy = transport.request(options, (proxyRes) => {
                if (proxyRes.statusCode >= 400) {
                    proxyRes.resume();
                    return resolve({ success: false, status: proxyRes.statusCode, error: `HTTP ${proxyRes.statusCode}` });
                }

                const ct = proxyRes.headers['content-type'] || '';
                const isStream = ct.includes('text/event-stream');

                if (isStream) {
                    peekFirstChunk(proxyRes).then(peek => {
                        if (!peek.ok) {
                            proxy.destroy();
                            return resolve({ success: false, error: `Stream peek: ${peek.reason}` });
                        }
                        // peek.firstChunk already unshifted by peekFirstChunk — do not unshift again

                        const SAFE_HEADERS = ['content-type', 'x-request-id', 'cache-control'];
                        const outHeaders = {};
                        for (const h of SAFE_HEADERS) {
                            if (proxyRes.headers[h]) outHeaders[h] = proxyRes.headers[h];
                        }
                        if (!outHeaders['content-type']) outHeaders['content-type'] = proxyRes.headers['content-type'] || 'text/event-stream';
                        let outStream = proxyRes;

                        if (streamTransformer) {
                            outStream = outStream.pipe(streamTransformer);
                        }

                        resolve({ success: true, status: proxyRes.statusCode, headers: outHeaders, stream: outStream });
                    });
                } else {
                    const chunks = [];
                    proxyRes.on('data', c => chunks.push(c));
                    proxyRes.on('error', (err) => { resolve({ success: false, error: err.message }); });
                    proxyRes.on('end', () => {
                        let responseBody = Buffer.concat(chunks);
                        if (isOpenAI) {
                            try {
                                const openaiResp = JSON.parse(responseBody.toString());
                                const anthropicResp = translateResponse(openaiResp, model);
                                responseBody = Buffer.from(JSON.stringify(anthropicResp));
                            } catch (e) {}
                        } else {
                            try {
                                const resp = JSON.parse(responseBody.toString());
                                if (resp.content && Array.isArray(resp.content)) {
                                    const responseMsg = { role: 'assistant', content: resp.content };
                                    const fullMessages = parsed && parsed.messages ? [...parsed.messages, responseMsg] : [responseMsg];
                                    const tc = extractThinkingBlocks(fullMessages);
                                    if (tc) {
                                        store(tc.sk, tc.firstToolUseId, tc.blocks);
                                        resp.content = resp.content.filter(b => b.type !== 'thinking' && b.type !== 'redacted_thinking');
                                        responseBody = Buffer.from(JSON.stringify(resp));
                                    }
                                }
                            } catch (e) {}
                        }
                        const SAFE_HEADERS = ['content-type', 'x-request-id', 'cache-control'];
                        const outHeaders = { 'content-length': responseBody.length };
                        for (const h of SAFE_HEADERS) {
                            if (proxyRes.headers[h]) outHeaders[h] = proxyRes.headers[h];
                        }
                        resolve({ success: true, status: proxyRes.statusCode, headers: outHeaders, body: responseBody });
                    });
                }
            });

            proxy.on('timeout', () => {
                proxy.destroy();
                resolve({ success: false, error: 'Upstream timeout after 60s' });
            });

            proxy.on('error', (err) => {
                resolve({ success: false, error: err.message });
            });

            proxy.write(forwardedBody);
            proxy.end();
        });
    }
});

server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    process.stdout.write('PORT:' + String(port));
});

process.on('SIGTERM', () => {
    server.close(() => process.exit(0));
    setTimeout(() => {
        console.error('Forced shutdown after 30s drain timeout');
        process.exit(1);
    }, 30000).unref();
});
process.on('SIGINT', () => {
    server.close(() => process.exit(0));
    setTimeout(() => {
        console.error('Forced shutdown after 30s drain timeout');
        process.exit(1);
    }, 30000).unref();
});
process.on('unhandledRejection', (reason) => {
    console.error('FATAL: unhandledRejection:', reason);
});
process.on('uncaughtException', (err) => {
    console.error('FATAL: uncaughtException:', err.message);
    if (typeof server !== 'undefined') server.close(() => process.exit(1));
    else process.exit(1);
});
