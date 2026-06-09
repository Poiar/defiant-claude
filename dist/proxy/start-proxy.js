'use strict';
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const http_1 = __importDefault(require("http"));
const https_1 = __importDefault(require("https"));
const stream_1 = require("stream");
const protocol_translate_1 = require("./protocol-translate");
const thinking_cache_1 = require("./thinking-cache");
const reasoning_cache_1 = require("./reasoning-cache");
const util_1 = require("./util");
const config_1 = require("./config");
const routing_1 = require("./routing");
const prompt_router_1 = require("./prompt-router");
const canary_1 = require("./canary");
const forward_1 = require("./forward");
const probe_1 = require("./probe");
const server_tools_1 = require("./server-tools");
const stats_1 = require("./stats");
const dashboard_1 = require("./dashboard");
const error_codes_1 = require("./error-codes");
const truncate_1 = require("./truncate");
const concurrency_1 = require("./concurrency");
const log_1 = require("./log");
const friendly_error_1 = require("./friendly-error");
const transport_errors_1 = require("./transport-errors");
const rate_limiter_1 = require("./rate-limiter");
const header_sanitizer_1 = require("./header-sanitizer");
const momentum_1 = require("./momentum");
const ssrf_1 = require("./ssrf");
// Git hash captured at startup so every health check shows the exact commit.
const child_process_1 = require("child_process");
const GIT_HASH = (() => {
    try {
        return (0, child_process_1.execSync)('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
    }
    catch {
        return 'unknown';
    }
})();
// Retry config for transient upstream transport errors.
// Each provider in the fallback chain gets up to 3 retries with exponential
// backoff before the proxy moves on to the next fallback provider.
const MAX_PER_PROVIDER_RETRIES = 2; // 1 initial + 2 retries = 3 total attempts
const RETRY_BASE_DELAY_MS = 800; // 800ms -> 1.6s
// Status codes that warrant trying a different provider.
// Auth errors (401/403) and client errors (400/404/413) won't be fixed
// by a different backend -- fail fast rather than burning fallback attempts.
const FALLBACKABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
// --- Bootstrap ---
const log = (0, log_1.createLogger)('proxy');
// Stamp the git hash onto the stats module for health endpoint reporting.
(0, stats_1.setGitHash)(GIT_HASH);
// Check for --probe flag before normal startup
const probeIdx = process.argv.indexOf('--probe');
const dryRunIdx = process.argv.indexOf('--dry-run');
const whatIfIdx = process.argv.indexOf('--what-if');
const dryIdx = dryRunIdx >= 0 ? dryRunIdx : whatIfIdx;
// Parse spend budget caps (applies to normal server startup)
const maxSpendIdx = process.argv.indexOf('--max-spend');
let maxSpend = null;
if (maxSpendIdx >= 2 && process.argv[maxSpendIdx + 1]) {
    maxSpend = parseFloat(process.argv[maxSpendIdx + 1]);
    if (isNaN(maxSpend) || maxSpend < 0) {
        console.error('--max-spend must be a non-negative number. Usage: --max-spend <dollars>');
        process.exit(1);
    }
}
const dailyBudgetEnv = process.env.DEEPCLAUDE_DAILY_BUDGET || '';
let dailyBudget = null;
if (dailyBudgetEnv) {
    dailyBudget = parseFloat(dailyBudgetEnv);
    if (isNaN(dailyBudget) || dailyBudget < 0) {
        console.error('DEEPCLAUDE_DAILY_BUDGET must be a non-negative number');
        process.exit(1);
    }
}
if (probeIdx >= 2) {
    const nextArg = process.argv[probeIdx + 1];
    let routesFile = null;
    if (nextArg && !nextArg.startsWith('-')) {
        routesFile = nextArg;
    }
    else {
        const routesIdx = process.argv.indexOf('--routes');
        if (routesIdx >= 2 && process.argv[routesIdx + 1]) {
            routesFile = process.argv[routesIdx + 1];
        }
    }
    if (!routesFile) {
        console.error('Usage: npx tsx start-proxy.ts --probe <routes.json>');
        console.error('       npx tsx start-proxy.ts --probe --routes <routes.json>');
        process.exit(1);
    }
    const { runProbe } = require('./probe');
    runProbe(routesFile).catch((err) => { console.error('Probe error:', err.message); process.exit(1); });
}
else if (dryIdx >= 2) {
    let routesFile = null;
    const nextArg = process.argv[dryIdx + 1];
    if (nextArg && !nextArg.startsWith('-')) {
        routesFile = nextArg;
    }
    else {
        const routesIdx = process.argv.indexOf('--routes');
        if (routesIdx >= 2 && process.argv[routesIdx + 1]) {
            routesFile = process.argv[routesIdx + 1];
        }
    }
    if (!routesFile) {
        const homeDir = process.env.HOME || process.env.USERPROFILE || '';
        const defaultPath = homeDir + '/.deepclaude/current-routes.json';
        try {
            require('fs').accessSync(defaultPath);
            routesFile = defaultPath;
        }
        catch (_) {
            console.error('Usage: npx tsx start-proxy.ts --dry-run <routes.json>');
            console.error('       npx tsx start-proxy.ts --dry-run --routes <routes.json>');
            console.error('       npx tsx start-proxy.ts --dry-run (uses ~/.deepclaude/current-routes.json)');
            process.exit(1);
        }
    }
    const { runDryRun } = require('./dry-run');
    runDryRun(routesFile);
    process.exit(0);
}
else {
    // --- Normal server startup ---
    const hasDashboard = process.argv.slice(2).indexOf('--dashboard') >= 0;
    const hasOpen = process.argv.slice(2).indexOf('--open') >= 0;
    const filteredArgv = process.argv.filter((a, i) => {
        if (a === '--dashboard' || a === '--open' || a === '--max-spend')
            return false;
        if (i > 0 && process.argv[i - 1] === '--max-spend')
            return false;
        return true;
    });
    const keepAliveAgent = new https_1.default.Agent({ keepAlive: true, maxSockets: 50, keepAliveMsecs: 30000 });
    const parsed = (0, config_1.parseArgs)(filteredArgv);
    const state = (0, config_1.loadConfig)(parsed);
    // Validate at startup (warn but don't block)
    const configWarnings = (0, config_1.validateConfig)(state);
    for (const w of configWarnings) {
        log.warn(null, w);
    }
    // Load provider registry for data-driven hooks (optional -- proxy works without it)
    let providerRegistry = null;
    try {
        providerRegistry = require('./providers.json');
    }
    catch (_) { /* file not found, continue without registry */ }
    const concurrency = (0, concurrency_1.createSlotLimiter)();
    const rateLimiter = (0, rate_limiter_1.createRateLimiter)();
    const isDev = process.env.DEEPCLAUDE_DEV === '1' || process.env.NODE_ENV === 'development';
    // Apply spend budget caps from CLI/env
    if (maxSpend !== null)
        (0, stats_1.setSessionCap)(maxSpend);
    if (dailyBudget !== null)
        (0, stats_1.setDailyBudget)(dailyBudget);
    if (maxSpend !== null || dailyBudget !== null) {
        log.info(null, 'Spend caps: ' +
            (maxSpend !== null ? 'session=$' + maxSpend.toFixed(2) : '') +
            (maxSpend !== null && dailyBudget !== null ? ', ' : '') +
            (dailyBudget !== null ? 'daily=$' + dailyBudget.toFixed(2) : ''));
    }
    // Extract display names from provider registry for the dashboard
    let providerDisplayNames;
    if (providerRegistry && providerRegistry.providers) {
        providerDisplayNames = {};
        for (const [key, rawDef] of Object.entries(providerRegistry.providers)) {
            const rec = rawDef;
            if (rec.displayName) {
                providerDisplayNames[key] = rec.displayName;
            }
        }
    }
    // Register provider info for circuit breaker auto-probe recovery
    if (state.routing && state.routing.providers) {
        for (const [key, provider] of Object.entries(state.routing.providers)) {
            const rawKey = process.env[provider.keyEnv || ''] || provider.key;
            const resolvedKey = (0, config_1.resolveKey)(rawKey);
            const probeModel = (provider.format || 'anthropic') === 'openai' ? 'gpt-4o-mini' : 'claude-sonnet-4-20250514';
            (0, stats_1.registerProviderInfo)(key, {
                url: provider.url,
                key: resolvedKey,
                isBearer: provider.auth === 'bearer',
                format: provider.format || 'anthropic',
                model: probeModel,
            });
        }
    }
    function lookupProviderByHost(hostname) {
        if (!providerRegistry)
            return null;
        for (const [, def] of Object.entries(providerRegistry.providers)) {
            try {
                const u = new URL(def.endpoint);
                if (u.hostname === hostname || hostname.endsWith('.' + u.hostname))
                    return def;
            }
            catch (_) { /* invalid URL, skip */ }
        }
        return null;
    }
    // --- HTTP Server ---
    let activeConnections = 0;
    const server = http_1.default.createServer((req, res) => {
        req.setTimeout(30000); // Prevent slow-body trickle from starving concurrency slots
        // --- Dashboard routes (always available when proxy is running) ---
        if ((0, dashboard_1.serveDashboard)(req, res, concurrency.status(), rateLimiter.status(), providerDisplayNames))
            return;
        // --- Health check ---
        if (req.method === 'GET' && req.url === '/health') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify((0, stats_1.getFullHealthSnapshot)(concurrency.status(), rateLimiter.status())));
            return;
        }
        // Compute URL path and model-call flag before body reading for Content-Type validation.
        const urlPath = (req.url || '').split('?')[0];
        const isModelCall = urlPath === '/v1/messages' || urlPath === '/v1/messages/';
        // Content-Type validation for model calls
        if (isModelCall) {
            const ct = (req.headers['content-type'] || '').toLowerCase();
            if (!ct.includes('application/json')) {
                res.writeHead(415, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ type: 'api_error', message: 'Content-Type must be application/json' }));
                return;
            }
        }
        // --- Rate limit check ---
        const clientIp = req.socket.remoteAddress || '127.0.0.1';
        const rateCheck = rateLimiter.check(clientIp);
        if (!rateCheck.allowed) {
            res.writeHead(429, {
                'content-type': 'application/json',
                'retry-after': String(rateCheck.retryAfter || 60),
            });
            res.end(JSON.stringify((0, error_codes_1.formatError)(429)));
            return;
        }
        (0, config_1.checkReload)(state, parsed);
        // --- Body size guard ---
        const contentLength = parseInt(req.headers['content-length'] || '', 10);
        if (!isNaN(contentLength) && contentLength > 10_000_000) {
            res.writeHead(413, { 'content-type': 'application/json' });
            res.end(JSON.stringify((0, error_codes_1.formatError)(413)));
            req.destroy();
            return;
        }
        let body = true; // sentinel: true = accumulating, null = cancelled (size exceeded)
        let bodySize = 0;
        const chunks = [];
        req.on('error', (_err) => {
            // Client disconnect or transport error during body read.
            // Without this handler, Node throws unhandled 'error' -> uncaughtException -> process.exit(1).
            if (body !== null) {
                body = null;
                req.removeAllListeners('data');
                req.removeAllListeners('end');
            }
            try {
                if (!res.headersSent && !res.destroyed) {
                    res.writeHead(400, { 'content-type': 'application/json' });
                    res.end(JSON.stringify((0, error_codes_1.formatError)(400)));
                }
            }
            catch (_) { /* socket may already be destroyed */ }
        });
        req.on('data', (chunk) => {
            bodySize += chunk.length;
            if (bodySize > 10_000_000) {
                try {
                    if (!res.destroyed) {
                        res.writeHead(413, { 'content-type': 'application/json' });
                        res.end(JSON.stringify((0, error_codes_1.formatError)(413)));
                    }
                }
                catch (_) { /* socket may already be destroyed */ }
                req.destroy();
                req.removeAllListeners('data');
                req.removeAllListeners('end');
                body = null;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (body === null)
                return; // body read was cancelled (size limit exceeded)
            req.setTimeout(0); // Clear slow-body guard — streaming phase may have long idle gaps
            activeConnections++;
            const rawBody = Buffer.concat(chunks);
            const reqId = (0, stats_1.nextRequestId)();
            (async () => {
                let model = null;
                let parsedBody = null;
                try {
                    const parsed = JSON.parse(rawBody.toString());
                    parsedBody = parsed;
                    model = parsed.model;
                }
                catch (e) {
                    log.error(reqId, 'body parse error: ' + (0, truncate_1.truncateForLog)(e.message));
                }
                // Compute sanitized headers once for safe logging throughout the handler
                const safeHeaders = (0, header_sanitizer_1.sanitizeHeaders)(req.headers);
                // Non-model calls (OAuth, agent infrastructure, etc.) -> passthrough to Anthropic.
                if (!isModelCall) {
                    const anthro = new URL('https://api.anthropic.com');
                    const anthroPath = anthro.pathname.replace(/\/+$/, '') + req.url;
                    const anthroHeaders = { ...req.headers };
                    delete anthroHeaders['host'];
                    delete anthroHeaders['connection'];
                    delete anthroHeaders['content-length'];
                    delete anthroHeaders['transfer-encoding'];
                    const anthroTransport = anthro.protocol === 'https:' ? https_1.default : http_1.default;
                    const anthroReq = anthroTransport.request({
                        hostname: anthro.hostname,
                        port: 443,
                        path: anthroPath,
                        method: req.method,
                        headers: anthroHeaders,
                        timeout: 60000,
                    }, (anthroRes) => {
                        const safeResHeaders = {};
                        const hopByHop = new Set(['transfer-encoding', 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'upgrade']);
                        for (const [k, v] of Object.entries(anthroRes.headers)) {
                            if (!hopByHop.has(k.toLowerCase()))
                                safeResHeaders[k] = v;
                        }
                        if (!res.headersSent && !res.destroyed) {
                            res.writeHead(anthroRes.statusCode || 200, safeResHeaders);
                            (0, stream_1.pipeline)(anthroRes, res, (err) => {
                                if (err)
                                    log.error(reqId, 'pipeline error: ' + (0, error_codes_1.scrubCredentials)(err.message));
                            });
                        }
                    });
                    anthroReq.on('timeout', () => { anthroReq.destroy(); try {
                        if (!res.headersSent && !res.destroyed) {
                            res.writeHead(504);
                            res.end();
                        }
                    }
                    catch (_) { /* socket may already be destroyed */ } });
                    anthroReq.on('error', (err) => {
                        log.error(reqId, 'passthrough upstream error: ' + (0, error_codes_1.scrubCredentials)(err.message));
                        try {
                            if (!res.headersSent && !res.destroyed) {
                                res.writeHead(502);
                                res.end(JSON.stringify((0, error_codes_1.formatError)(502, null, isDev)));
                            }
                        }
                        catch (_) { /* socket may already be destroyed */ }
                    });
                    anthroReq.write(rawBody);
                    anthroReq.end();
                    return;
                }
                // Prompt-based smart routing: classify request and optionally override model
                // to route cheap/simple queries to cheaper providers.
                if (parsedBody && state.routing?.promptRouter?.enabled) {
                    const slotMatch = model && model.match(/^(sonnet|opus|haiku|subagent):/);
                    if (slotMatch) {
                        const slot = slotMatch[1];
                        const classification = (0, prompt_router_1.classifyRequest)(parsedBody);
                        const routeOverride = (0, prompt_router_1.resolvePromptRoute)(slot, classification, state.routing.promptRouter, state.routing);
                        if (routeOverride) {
                            log.info(reqId, 'prompt-router: ' + slot + ' ' + classification.tier + ' -> ' + routeOverride.providerKey + ':' + routeOverride.rewriteModel);
                            model = routeOverride.providerKey + ':' + routeOverride.rewriteModel;
                        }
                    }
                }
                const resolved = (0, routing_1.resolveTarget)(model, state.routing, state.slotOverrides, parsed.singleUrl, parsed.singleKey);
                if (resolved.error) {
                    const err = (0, error_codes_1.formatError)(502, { provider: 'unknown' }, isDev);
                    err.message = resolved.error;
                    res.writeHead(502);
                    res.end(JSON.stringify(err));
                    return;
                }
                // --- Canary routing ---
                // Extract the slot from model to check for a canary config.
                // If active, the canary provider replaces the primary, keeping
                // the original primary as the first fallback.
                const slot = model ? (model.match(/^(sonnet|opus|haiku|subagent):/) || [null])[1] : null;
                let canaryEntry = null;
                if (slot && state.routing?.canary?.[slot] && state.routing?.providers) {
                    const cfg = state.routing.canary[slot];
                    const warmupPercent = cfg.warmupPercent ?? 10;
                    const config = {
                        enabled: true,
                        targetProvider: cfg.targetProvider,
                        targetModel: cfg.targetModel,
                        warmupPercent,
                        promoteAfter: 20,
                        promoteAfterActive: 50,
                        rollbackErrorRate: 0.2,
                    };
                    const providerEntry = state.routing.providers[config.targetProvider];
                    if (providerEntry) {
                        const rawKey = process.env[providerEntry.keyEnv || ''] || providerEntry.key;
                        if (rawKey) {
                            const resolvedKey = (0, config_1.resolveKey)(rawKey);
                            if (!(rawKey.startsWith('$aes256gcm:') && resolvedKey === null)) {
                                const entry = (0, canary_1.getOrCreateEntry)(slot, config);
                                const hash = (0, canary_1.bodyHash)(rawBody.toString(), slot);
                                if ((0, canary_1.shouldUseCanary)(hash, entry.state, entry.config)) {
                                    const canaryTarget = {
                                        providerKey: config.targetProvider,
                                        url: providerEntry.url,
                                        key: resolvedKey,
                                        isBearer: providerEntry.auth === 'bearer',
                                        targetUrl: new URL(providerEntry.url),
                                        rewriteModel: cfg.targetModel,
                                        format: providerEntry.format || 'anthropic',
                                    };
                                    const originalPrimary = resolved.primary;
                                    resolved.primary = canaryTarget;
                                    resolved.fallbacks = [originalPrimary, ...(resolved.fallbacks || [])];
                                }
                                canaryEntry = entry;
                            }
                        }
                    }
                }
                // Pre-process request body once (tool results, server tools)
                let baseBody = rawBody;
                let bodyPreprocessed = false;
                if (parsedBody) {
                    try {
                        let modified = false;
                        if (parsedBody.messages) {
                            const populated = await (0, server_tools_1.populateToolResults)(parsedBody.messages);
                            if (populated)
                                modified = true;
                        }
                        const conv = (0, server_tools_1.convertServerTools)(parsedBody.tools);
                        if (conv.hasWebSearch || conv.hasWebFetch) {
                            parsedBody.tools = conv.tools;
                            modified = true;
                        }
                        if (modified) {
                            baseBody = Buffer.from(JSON.stringify(parsedBody));
                            bodyPreprocessed = true;
                        }
                    }
                    catch (e) {
                        log.error(reqId, 'preprocessing error: ' + (0, truncate_1.truncateForLog)(e.message));
                    }
                }
                const resolvedResult = resolved;
                // Budget cap check -- stop forwarding if spend exceeds configured caps
                const budgetReason = (0, stats_1.checkBudget)();
                if (budgetReason) {
                    if (!res.headersSent && !res.destroyed) {
                        const streamingClient = (0, error_codes_1.isStreamingClient)(req.headers, parsedBody);
                        if (streamingClient) {
                            const friendlyEvents = 'event: error\ndata: ' + JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: budgetReason } }) + '\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\ndata: [DONE]\n\n';
                            res.writeHead(200, (0, forward_1.sseHeaders)({}));
                            res.write(friendlyEvents);
                            res.end();
                        }
                        else {
                            res.writeHead(402, { 'content-type': 'application/json', 'x-budget-cap': 'true' });
                            res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: budgetReason } }));
                        }
                    }
                    return;
                }
                const chain = [resolvedResult.primary, ...resolvedResult.fallbacks.filter(fb => (0, stats_1.isProviderHealthy)(fb.providerKey))];
                if (chain.length > 3) {
                    log.warn(reqId, 'Fallback chain truncated from ' + chain.length + ' to 3 providers');
                    chain.length = 3;
                }
                // Session momentum: if this conversation has a history of successful
                // responses from a particular provider, prefer it at the front of fallbacks.
                const sk = (0, momentum_1.sessionKey)(parsedBody);
                if (sk && chain.length > 1) {
                    const momentum = (0, momentum_1.getMomentum)(sk);
                    if (momentum && momentum.preferredProvider && momentum.confidence >= 2) {
                        const fbIdx = chain.findIndex((t, i) => i > 0 && t.providerKey === momentum.preferredProvider);
                        if (fbIdx > 1) {
                            const [preferred] = chain.splice(fbIdx, 1);
                            chain.splice(1, 0, preferred);
                        }
                    }
                }
                let lastStatus = null;
                let lastRawBody = null;
                let lastQualityReason = null;
                let fallbackFromModel = null;
                const attemptedProviders = [];
                for (let attempt = 0; attempt < chain.length; attempt++) {
                    const target = chain[attempt];
                    attemptedProviders.push({ providerKey: target.providerKey });
                    const isRetry = attempt > 0;
                    // Track which model we're falling back from
                    if (isRetry && attempt === 1) {
                        fallbackFromModel = resolvedResult.primary.rewriteModel || model;
                    }
                    // Rewrite model for this target
                    let forwardedBody = baseBody;
                    if (target.rewriteModel) {
                        try {
                            const p = bodyPreprocessed ? JSON.parse(baseBody.toString()) : JSON.parse(rawBody.toString());
                            if (p.model !== target.rewriteModel) {
                                p.model = target.rewriteModel;
                                forwardedBody = Buffer.from(JSON.stringify(p));
                            }
                        }
                        catch (e) {
                            log.error(reqId, 'model rewrite error: ' + (0, truncate_1.truncateForLog)(e.message));
                        }
                    }
                    // Protocol translation
                    let streamTransformer = null;
                    if (target.format === 'openai') {
                        try {
                            const reqParsed = JSON.parse(forwardedBody.toString());
                            const { openaiBody } = (0, protocol_translate_1.translateRequest)(reqParsed);
                            forwardedBody = Buffer.from(JSON.stringify(openaiBody));
                            if (reqParsed.stream)
                                streamTransformer = (0, protocol_translate_1.createStreamTransformer)(model || reqParsed.model);
                        }
                        catch (e) {
                            log.error(reqId, 'protocol translation error: ' + (0, truncate_1.truncateForLog)(e.message));
                        }
                    }
                    // Build upstream path
                    const basePath = target.targetUrl.pathname.replace(/\/+$/, '');
                    const upstreamPath = (0, util_1.deduplicatePath)(basePath, req.url || '');
                    const options = {
                        hostname: target.targetUrl.hostname,
                        port: target.targetUrl.port || (target.targetUrl.protocol === 'https:' ? 443 : 80),
                        path: upstreamPath,
                        method: req.method || 'POST',
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
                        options.headers['authorization'] = 'Bearer ' + target.key;
                        delete options.headers['x-api-key'];
                    }
                    else {
                        options.headers['x-api-key'] = target.key || '';
                        delete options.headers['authorization'];
                    }
                    // Apply provider-specific extra headers from registry
                    const providerDef = lookupProviderByHost(options.hostname);
                    if (providerDef && providerDef.extraHeaders) {
                        Object.assign(options.headers, providerDef.extraHeaders);
                    }
                    // Handle thinking blocks
                    if (target.format === 'anthropic') {
                        try {
                            const reqParsed = JSON.parse(forwardedBody.toString());
                            if (reqParsed.messages) {
                                (0, thinking_cache_1.injectThinkingBlocks)(reqParsed.messages);
                                forwardedBody = Buffer.from(JSON.stringify(reqParsed));
                            }
                        }
                        catch (e) {
                            log.error(reqId, 'thinking injection error: ' + (0, truncate_1.truncateForLog)(e.message));
                        }
                    }
                    else if (target.format === 'openai') {
                        try {
                            const reqParsed = JSON.parse(forwardedBody.toString());
                            if (reqParsed.messages) {
                                // Strip thinking blocks (Anthropic format -> OpenAI format)
                                reqParsed.messages = reqParsed.messages.map((m) => {
                                    if (m.role === 'assistant' && Array.isArray(m.content)) {
                                        m.content = m.content.filter(b => b.type !== 'thinking');
                                    }
                                    return m;
                                });
                                // Re-inject reasoning_content stripped by SDKs
                                (0, reasoning_cache_1.reinjectReasoningContent)(reqParsed.messages);
                                forwardedBody = Buffer.from(JSON.stringify(reqParsed));
                            }
                        }
                        catch (e) {
                            log.error(reqId, 'thinking strip / reasoning inject error: ' + (0, truncate_1.truncateForLog)(e.message));
                        }
                    }
                    // SSRF validation: ensure upstream URL doesn't point to private/internal IPs
                    const upstreamUrl = target.url + upstreamPath;
                    const ssrfResult = await (0, ssrf_1.validateUrl)(upstreamUrl);
                    if (!ssrfResult.valid) {
                        log.warn(reqId, 'SSRF validation failed for ' + target.providerKey + ': ' + (ssrfResult.reason || 'unknown'));
                        lastStatus = 502;
                        continue; // skip this provider, try next in fallback chain
                    }
                    const transport = target.targetUrl.protocol === 'https:' ? https_1.default : http_1.default;
                    const t0 = Date.now();
                    // Per-provider retry loop: retry transport errors with exponential
                    // backoff before moving to the next fallback provider.
                    let result = { success: false };
                    for (let provAttempt = 0; provAttempt <= MAX_PER_PROVIDER_RETRIES; provAttempt++) {
                        // Acquire concurrency slot before each attempt
                        const { promise: slotPromise, cancel: cancelSlot } = concurrency.acquire();
                        req.once('close', cancelSlot);
                        let release;
                        try {
                            release = await slotPromise;
                        }
                        catch {
                            try {
                                if (!res.headersSent && !res.destroyed) {
                                    res.writeHead(503, { 'content-type': 'application/json' });
                                    res.end(JSON.stringify((0, error_codes_1.formatError)(503)));
                                }
                            }
                            catch (_) { /* socket may already be destroyed */ }
                            return; // abort entire request -- can't get a slot
                        }
                        finally {
                            req.removeListener('close', cancelSlot);
                        }
                        const onClose = () => release();
                        res.once('close', onClose);
                        try {
                            result = await (0, forward_1.tryForward)(transport, options, forwardedBody.toString(), streamTransformer, target.format === 'openai', parsedBody, model, reqId);
                        }
                        finally {
                            release();
                            res.removeListener('close', onClose);
                        }
                        // Success -> stop retrying
                        if (result.success)
                            break;
                        // Non-transport error (HTTP 4xx/5xx) -> stop retrying this provider
                        if (!result.transportError)
                            break;
                        // Transport error, retries left -> backoff and retry
                        if (provAttempt < MAX_PER_PROVIDER_RETRIES) {
                            const delay = RETRY_BASE_DELAY_MS * Math.pow(2, provAttempt);
                            log.warn(reqId, target.providerKey + ' ' + (0, transport_errors_1.describe)(new Error(result.error)) + ', retrying in ' + delay + 'ms (' + (MAX_PER_PROVIDER_RETRIES - provAttempt) + ' left)');
                            await new Promise(r => setTimeout(r, delay));
                        }
                    }
                    const ms = Date.now() - t0;
                    if (result.success) {
                        (0, stats_1.recordStat)(target.providerKey, true, ms);
                        (0, stats_1.recordRecentRequest)({
                            timestamp: Date.now(),
                            model: model,
                            provider: target.providerKey,
                            status: result.status || 200,
                            ms: ms,
                            tokens: result.streamUsage ? { input: result.streamUsage.prompt_tokens || 0, output: result.streamUsage.completion_tokens || 0 } : null,
                            fallback: isRetry,
                        });
                        if (canaryEntry && attempt === 0) {
                            (0, canary_1.recordCanaryResult)(true, canaryEntry.state, canaryEntry.config);
                        }
                        if (result.streamUsage) {
                            (0, stats_1.recordUsage)(target.providerKey, result.streamUsage.prompt_tokens || 0, result.streamUsage.completion_tokens || 0);
                            const upstreamModel = target.rewriteModel || model;
                            if (upstreamModel)
                                (0, stats_1.recordSpend)(upstreamModel, result.streamUsage).catch(() => { });
                        }
                        if (sk)
                            (0, momentum_1.record)(sk, target.providerKey, model || '');
                        const label = target.providerKey || 'upstream';
                        if (isRetry) {
                            log.info(reqId, req.method + ' ' + (model || '-') + ' -> ' + label + ' ' + result.status + ' ' + ms + 'ms (fallback #' + attempt + ')');
                        }
                        else {
                            log.info(reqId, req.method + ' ' + (model || '-') + ' -> ' + label + ' ' + result.status + ' ' + ms + 'ms');
                        }
                        // Add fallback response headers
                        let outHeaders = result.headers || {};
                        if (isRetry) {
                            outHeaders = (0, forward_1.addFallbackHeaders)(outHeaders, {
                                fallbackFromModel,
                                fallbackIndex: attempt,
                            });
                        }
                        if (!res.headersSent && !res.destroyed) {
                            res.writeHead(result.status || 200, outHeaders);
                            if (result.body) {
                                res.end(result.body);
                            }
                            else if (result.stream) {
                                result.stream.on('error', (err) => {
                                    log.error(reqId, 'Stream error for ' + model + ': ' + (0, error_codes_1.scrubCredentials)(err.message));
                                    try {
                                        if (!res.headersSent && !res.destroyed) {
                                            res.writeHead(502, { 'content-type': 'application/json' });
                                            res.end(JSON.stringify((0, error_codes_1.formatError)(502, null, isDev)));
                                        }
                                        else if (!res.destroyed) {
                                            res.write('event: error\ndata: ' + JSON.stringify((0, error_codes_1.formatError)(502, null, isDev)) + '\n\n');
                                            res.end();
                                        }
                                    }
                                    catch (_) { /* socket may already be destroyed */ }
                                });
                                (0, stream_1.pipeline)(result.stream, res, (err) => {
                                    if (result.streamUsage) {
                                        (0, stats_1.recordUsage)(target.providerKey, result.streamUsage.prompt_tokens || 0, result.streamUsage.completion_tokens || 0);
                                        const upstreamModel = target.rewriteModel || model;
                                        if (upstreamModel)
                                            (0, stats_1.recordSpend)(upstreamModel, result.streamUsage).catch(() => { });
                                    }
                                    if (err)
                                        log.error(reqId, 'stream error: ' + (0, error_codes_1.scrubCredentials)(err.message));
                                });
                                // Propagate client disconnect to upstream
                                res.on('close', () => {
                                    const s = result.stream;
                                    if (s && !s.destroyed)
                                        s.destroy();
                                });
                            }
                        }
                        return;
                    }
                    (0, stats_1.recordStat)(target.providerKey, false, ms);
                    (0, stats_1.recordRecentRequest)({
                        timestamp: Date.now(),
                        model: model,
                        provider: target.providerKey,
                        status: result.status || null,
                        ms: ms,
                        tokens: null,
                        fallback: isRetry,
                    });
                    if (canaryEntry && attempt === 0) {
                        (0, canary_1.recordCanaryResult)(false, canaryEntry.state, canaryEntry.config);
                    }
                    lastStatus = result.status || null;
                    lastRawBody = result.rawBody || null;
                    const label = target.providerKey || 'upstream';
                    // Quality failure -- continue to next fallback provider
                    if (result.qualityFailure) {
                        lastQualityReason = result.qualityReason || null;
                        log.warn(reqId, req.method + ' ' + (model || '-') + ' -> ' + label + ' quality failure: ' + result.qualityReason + ' ' + ms + 'ms, trying next...');
                        continue;
                    }
                    // Don't continue fallback chain for non-retryable status codes.
                    if (result.status && !FALLBACKABLE_STATUS.has(result.status)) {
                        log.warn(reqId, req.method + ' ' + (model || '-') + ' -> ' + label + ' ' + result.status + ' ' + ms + 'ms (non-retryable -- stopping)');
                        break;
                    }
                    if (result.status) {
                        log.warn(reqId, req.method + ' ' + (model || '-') + ' -> ' + label + ' ' + result.status + ' ' + ms + 'ms, trying next...');
                    }
                    else {
                        log.warn(reqId, req.method + ' ' + (model || '-') + ' -> ' + label + ' ERR ' + (0, truncate_1.truncateForLog)(result.error) + ' ' + ms + 'ms, trying next...');
                    }
                }
                // All attempts exhausted
                if (!res.headersSent && !res.destroyed) {
                    log.info(reqId, 'all providers exhausted after ' + attemptedProviders.length + ' attempt(s) -- safe request headers: ' + JSON.stringify(safeHeaders.headers) + ' (' + safeHeaders.dropped + ' dropped)');
                    const streamingClient = (0, error_codes_1.isStreamingClient)(req.headers, parsedBody);
                    const isChatClient = streamingClient ||
                        req.headers['anthropic-version'] ||
                        req.headers['x-api-key'] ||
                        isModelCall;
                    if (streamingClient) {
                        const friendlyEvents = (0, friendly_error_1.buildFriendlyStreamEvents)(lastStatus, model, attemptedProviders, lastQualityReason);
                        try {
                            res.writeHead(200, (0, forward_1.sseHeaders)({ 'x-fallback-exhausted': 'true' }));
                            res.write(friendlyEvents);
                            res.end();
                        }
                        catch (_) { /* socket may already be destroyed */ }
                    }
                    else if (isChatClient) {
                        const friendlyResp = (0, friendly_error_1.buildFriendlyResponse)(lastStatus, model, attemptedProviders, lastQualityReason);
                        try {
                            res.writeHead(friendlyResp.status, friendlyResp.headers);
                            res.end(friendlyResp.body);
                        }
                        catch (_) { /* socket may already be destroyed */ }
                    }
                    else {
                        const exhaustedError = (0, error_codes_1.formatExhaustedError)(lastStatus, lastRawBody, isDev, lastQualityReason);
                        const statusCode = (lastStatus && lastStatus >= 400 && lastStatus < 500) ? lastStatus : 502;
                        try {
                            res.writeHead(statusCode, { 'content-type': 'application/json', 'x-fallback-exhausted': 'true' });
                            res.end(JSON.stringify(exhaustedError));
                        }
                        catch (_) { /* socket may already be destroyed */ }
                    }
                }
            })().catch((err) => {
                log.error(null, 'unhandled error in request handler: ' + (0, truncate_1.truncateForLog)(err.message || String(err)));
                try {
                    if (!res.headersSent && !res.destroyed) {
                        res.writeHead(502);
                        res.end(JSON.stringify((0, error_codes_1.formatError)(502, null, isDev)));
                    }
                }
                catch (_) { /* socket may already be destroyed */ }
            }).finally(() => {
                activeConnections--;
            });
        });
    });
    // Auto-probe scheduler for circuit breaker recovery
    setInterval(() => {
        const keys = (0, stats_1.getRegisteredProviderKeys)();
        for (const pk of keys) {
            const info = (0, stats_1.getProviderInfo)(pk);
            if (!info)
                continue;
            const probeTarget = (0, stats_1.maybeStartProbe)(pk);
            if (probeTarget) {
                const slot = {
                    slot: '',
                    providerKey: pk,
                    model: probeTarget.model,
                    url: probeTarget.url,
                    key: probeTarget.key,
                    isBearer: probeTarget.isBearer,
                    format: probeTarget.format,
                };
                (0, probe_1.sendProbe)(slot).then((result) => {
                    const isHealthy = result.success || result.authFailed;
                    (0, stats_1.recordProbeResult)(pk, isHealthy);
                    const action = isHealthy ? 'succeeded -- closing breaker' : 'failed -- extending cooldown';
                    log.info(null, pk + ' circuit breaker HALF_OPEN probe ' + action);
                });
            }
        }
    }, 15_000).unref();
    // --- Lifecycle ---
    server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        process.stdout.write('PORT:' + String(port));
        if (hasDashboard) {
            const url = 'http://127.0.0.1:' + port + '/dashboard';
            process.stdout.write('\nDASHBOARD:' + url);
            if (hasOpen) {
                const platform = process.platform;
                const cmd = platform === 'win32' ? 'start' : platform === 'darwin' ? 'open' : 'xdg-open';
                setTimeout(() => {
                    require('child_process').exec(cmd + ' "' + url + '"');
                }, 500);
            }
        }
    });
    server.timeout = 0;
    function gracefulShutdown(signal) {
        log.info(null, signal + ' received -- draining ' + activeConnections + ' active connections...');
        keepAliveAgent.destroy();
        server.close(() => {
            log.info(null, 'Server stopped accepting new connections');
        });
        const drainStart = Date.now();
        const MAX_DRAIN_MS = 30_000;
        const drainInterval = setInterval(() => {
            if (activeConnections <= 0) {
                log.info(null, 'All connections drained -- exiting cleanly after ' + (Date.now() - drainStart) + 'ms');
                clearInterval(drainInterval);
                process.exit(0);
            }
            if (Date.now() - drainStart >= MAX_DRAIN_MS) {
                log.warn(null, 'Forced shutdown after ' + MAX_DRAIN_MS + 'ms with ' + activeConnections + ' connections remaining');
                clearInterval(drainInterval);
                process.exit(1);
            }
        }, 250).unref();
    }
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('unhandledRejection', (reason) => {
        log.error(null, 'unhandledRejection: ' + (0, error_codes_1.scrubCredentials)(String(reason)));
        process.exit(1);
    });
    process.on('uncaughtException', (err) => {
        log.error(null, 'uncaughtException: ' + (0, error_codes_1.scrubCredentials)(err.message || String(err)));
        if (typeof server !== 'undefined') {
            server.close(() => process.exit(1));
            setTimeout(() => process.exit(1), 10000);
        }
        else
            process.exit(1);
    });
}
