'use strict';

import http from 'http';
import https from 'https';
import { pipeline, Transform } from 'stream';

import { translateRequest, createStreamTransformer } from './protocol-translate';
import { injectThinkingBlocks } from './thinking-cache';
import { reinjectReasoningContent } from './reasoning-cache';
import { deduplicatePath } from './util';
import { parseArgs, loadConfig, checkReload, validateConfig, resolveKey } from './config';
import { resolveTarget, ResolvedTarget } from './routing';
import { classifyRequest, resolvePromptRoute } from './prompt-router';
import { bodyHash, shouldUseCanary, recordCanaryResult, getOrCreateEntry, type CanaryEntry, type CanaryConfig } from './canary';
import { tryForward, addFallbackHeaders, sseHeaders, type ForwardHeaders, type ForwardResult } from './forward';
import { sendProbe } from './probe';
import type { ProbeSlot } from './probe';
import { convertServerTools, populateToolResults } from './server-tools';
import { isProviderHealthy, recordSpend, recordStat, recordUsage, recordRecentRequest, recordStreamMetrics, getFullHealthSnapshot, nextRequestId, checkBudget, setSessionCap, setDailyBudget, registerProviderInfo, maybeStartProbe, recordProbeResult, getRegisteredProviderKeys, getProviderInfo, setGitHash } from './stats';
import { serveDashboard } from './dashboard';
import { formatError, formatExhaustedError, scrubCredentials, isStreamingClient } from './error-codes';
import { truncateForLog } from './truncate';
import { createSlotConcurrency } from './concurrency';
import { createLogger } from './log';
import { buildFriendlyResponse, buildFriendlyStreamEvents } from './friendly-error';
import { describe as describeTransportError } from './transport-errors';
import { createRateLimiter } from './rate-limiter';
import { sanitizeHeaders } from './header-sanitizer';
import { sessionKey, getMomentum, record as recordMomentum } from './momentum';
import { validateUrl } from './ssrf';
import { finalizeMetrics } from './stream-metrics';
import { logRequest, setLogAllRequests, type RequestLogEntry } from './request-log';
import { runStartupChecks } from './startup-check';

// Git hash captured lazily so the module can be imported without blocking at load time.
import { execSync } from 'child_process';
let _gitHash: string | null = null;
function getGitHash(): string {
  if (_gitHash !== null) return _gitHash;
  try { _gitHash = execSync('git rev-parse --short HEAD', { encoding: 'utf8', timeout: 5000 }).trim(); }
  catch { _gitHash = 'unknown'; }
  return _gitHash;
}

// Retry config for transient upstream transport errors.
// Each provider in the fallback chain gets up to 3 retries with exponential
// backoff before the proxy moves on to the next fallback provider.
const MAX_PER_PROVIDER_RETRIES = 2; // 1 initial + 2 retries = 3 total attempts
const RETRY_BASE_DELAY_MS = 800;   // 800ms -> 1.6s

// Status codes that warrant trying a different provider.
// Auth errors (401/403) and client errors (400/404/413) won't be fixed
// by a different backend -- fail fast rather than burning fallback attempts.
const FALLBACKABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

// --- Bootstrap ---

const log = createLogger('proxy');

// Stamp the git hash onto the stats module for health endpoint reporting.
setGitHash(getGitHash());

// Check for --probe flag before normal startup
const probeIdx = process.argv.indexOf('--probe');
const dryRunIdx = process.argv.indexOf('--dry-run');
const whatIfIdx = process.argv.indexOf('--what-if');
const dryIdx = dryRunIdx >= 0 ? dryRunIdx : whatIfIdx;

// Parse spend budget caps (applies to normal server startup)
const maxSpendIdx = process.argv.indexOf('--max-spend');
let maxSpend: number | null = null;
if (maxSpendIdx >= 2 && process.argv[maxSpendIdx + 1]) {
  maxSpend = parseFloat(process.argv[maxSpendIdx + 1]);
  if (isNaN(maxSpend) || maxSpend < 0) {
    console.error('--max-spend must be a non-negative number. Usage: --max-spend <dollars>');
    process.exit(1);
  }
}
const dailyBudgetEnv = process.env.DEEPCLAUDE_DAILY_BUDGET || '';
let dailyBudget: number | null = null;
if (dailyBudgetEnv) {
  dailyBudget = parseFloat(dailyBudgetEnv);
  if (isNaN(dailyBudget) || dailyBudget < 0) {
    console.error('DEEPCLAUDE_DAILY_BUDGET must be a non-negative number');
    process.exit(1);
  }
}

if (probeIdx >= 2) {
    const nextArg = process.argv[probeIdx + 1];
    let routesFile: string | null = null;
    if (nextArg && !nextArg.startsWith('-')) {
        routesFile = nextArg;
    } else {
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
    runProbe(routesFile).catch((err: Error) => { console.error('Probe error:', err.message); process.exit(1); });
} else if (dryIdx >= 2) {
    let routesFile: string | null = null;
    const nextArg = process.argv[dryIdx + 1];
    if (nextArg && !nextArg.startsWith('-')) {
        routesFile = nextArg;
    } else {
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
        } catch (_) {
            console.error('Usage: npx tsx start-proxy.ts --dry-run <routes.json>');
            console.error('       npx tsx start-proxy.ts --dry-run --routes <routes.json>');
            console.error('       npx tsx start-proxy.ts --dry-run (uses ~/.deepclaude/current-routes.json)');
            process.exit(1);
        }
    }
    const { runDryRun } = require('./dry-run');
    runDryRun(routesFile);
    process.exit(0);
} else {
    // --- Normal server startup ---

    const hasDashboard = process.argv.slice(2).indexOf('--dashboard') >= 0;
    const hasOpen = process.argv.slice(2).indexOf('--open') >= 0;
    const hasLogAll = process.argv.slice(2).indexOf('--log-all') >= 0;
    const filteredArgv = process.argv.filter((a, i) => {
	      if (a === '--dashboard' || a === '--open' || a === '--max-spend' || a === '--log-all') return false;
	      if (i > 0 && process.argv[i - 1] === '--max-spend') return false;
	      return true;
	    });

    const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 50, keepAliveMsecs: 30000 });
    const parsed = parseArgs(filteredArgv);
    const state = loadConfig(parsed);

// Validate at startup (warn but don't block)
const configWarnings = validateConfig(state);
for (const w of configWarnings) {
    log.warn(null, w);
}

// Enable request logging based on CLI flag or env var (opt-in).
if (hasLogAll || process.env.DEEPCLAUDE_LOG_ALL_REQUESTS === 'true') {
    setLogAllRequests(true);
}

// Load provider registry for data-driven hooks (optional -- proxy works without it)
let providerRegistry: { providers: Record<string, { endpoint: string; extraHeaders?: Record<string, string> }> } | null = null;
try { providerRegistry = require('./providers.json'); } catch (e: any) {
    if (e.code !== 'MODULE_NOT_FOUND') {
        console.warn('Warning: providers.json exists but could not be parsed:', e.message);
    }
}

const concurrency = createSlotConcurrency();
const rateLimiter = createRateLimiter();
const isDev = process.env.DEEPCLAUDE_DEV === '1' || process.env.NODE_ENV === 'development';

// Apply spend budget caps from CLI/env
if (maxSpend !== null) setSessionCap(maxSpend);
if (dailyBudget !== null) setDailyBudget(dailyBudget);
if (maxSpend !== null || dailyBudget !== null) {
    log.info(null, 'Spend caps: ' +
        (maxSpend !== null ? 'session=$' + maxSpend.toFixed(2) : '') +
        (maxSpend !== null && dailyBudget !== null ? ', ' : '') +
        (dailyBudget !== null ? 'daily=$' + dailyBudget.toFixed(2) : ''));
}

// Extract display names from provider registry for the dashboard
let providerDisplayNames: Record<string, string> | undefined;
if (providerRegistry && providerRegistry.providers) {
    providerDisplayNames = {};
    for (const [key, rawDef] of Object.entries(providerRegistry.providers)) {
        const rec = rawDef as { displayName?: string };
        if (rec.displayName) {
            providerDisplayNames[key] = rec.displayName;
        }
    }
}

// Register provider info for circuit breaker auto-probe recovery
if (state.routing && state.routing.providers) {
    for (const [key, provider] of Object.entries(state.routing.providers)) {
        const rawKey = process.env[provider.keyEnv || ''] || provider.key;
        const resolvedKey = resolveKey(rawKey);
        const probeModel = (provider.format || 'anthropic') === 'openai' ? 'gpt-4o-mini' : 'claude-sonnet-4-20250514';
        registerProviderInfo(key, {
            url: provider.url,
            key: resolvedKey,
            isBearer: provider.auth === 'bearer',
            format: provider.format || 'anthropic',
            model: probeModel,
        });
    }
}

// --- Data-driven provider hooks ---
// Look up extra headers from the provider registry instead of hardcoding
// hostname checks for OpenRouter, etc.

interface ProviderDef {
    endpoint: string;
    extraHeaders?: Record<string, string>;
}

function lookupProviderByHost(hostname: string): ProviderDef | null {
    if (!providerRegistry) return null;
    for (const [, def] of Object.entries(providerRegistry.providers)) {
        try {
            const u = new URL(def.endpoint);
            if (u.hostname === hostname || hostname.endsWith('.' + u.hostname)) return def;
        } catch (_) { /* invalid URL, skip */ }
    }
    return null;
}

// --- HTTP Server ---

let activeConnections = 0;

const server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
    req.setTimeout(30000);  // Prevent slow-body trickle from starving concurrency slots

    // --- Dashboard routes (always available when proxy is running) ---
    if (serveDashboard(req, res, concurrency.status(), rateLimiter.status(), providerDisplayNames)) return;

    // --- Health check ---
    if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(getFullHealthSnapshot(concurrency.status(), rateLimiter.status())));
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
        res.end(JSON.stringify(formatError(429)));
        return;
    }

    checkReload(state, parsed);

    // --- Body size guard ---
    const contentLength = parseInt(req.headers['content-length'] || '', 10);
    if (!isNaN(contentLength) && contentLength > 10_000_000) {
        res.writeHead(413, { 'content-type': 'application/json' });
        res.end(JSON.stringify(formatError(413)));
        req.destroy();
        return;
    }

    let body: true | null = true;  // sentinel: true = accumulating, null = cancelled (size exceeded)
    let bodySize = 0;
    const chunks: Buffer[] = [];
    req.on('error', (_err: Error) => {
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
                res.end(JSON.stringify(formatError(400)));
            }
        } catch (_) { /* socket may already be destroyed */ }
    });
    req.on('data', (chunk: Buffer) => {
        bodySize += chunk.length;
        if (bodySize > 10_000_000) {
            try {
                if (!res.destroyed) {
                    res.writeHead(413, { 'content-type': 'application/json' });
                    res.end(JSON.stringify(formatError(413)));
                }
            } catch (_) { /* socket may already be destroyed */ }
            req.destroy();
            req.removeAllListeners('data');
            req.removeAllListeners('end');
            body = null;
            return;
        }
        chunks.push(chunk);
    });

    req.on('end', () => {
        activeConnections++;
        if (body === null) { activeConnections--; return; }
        req.setTimeout(0);  // Clear slow-body guard — streaming phase may have long idle gaps
        const rawBody = Buffer.concat(chunks);
        const reqId = nextRequestId();

        // --- Request deadline ---
        // Last-resort safety net covering the entire request lifecycle (body
        // parsed -> response sent).  Set after we know the slot so subagent
        // requests get a tighter limit.  Non-model passthrough calls get the
        // default 120s deadline set immediately below.
        let requestDeadline: ReturnType<typeof setTimeout> | null = null;
        const clearRequestDeadline = () => {
            if (requestDeadline) { clearTimeout(requestDeadline); requestDeadline = null; }
        };
        const setRequestDeadline = (timeoutMs: number, label: string) => {
            requestDeadline = setTimeout(() => {
                log.warn(reqId, 'request deadline exceeded (' + timeoutMs + 'ms, slot=' + label + ') -- destroying connection');
                try {
                    if (!res.headersSent && !res.destroyed) {
                        res.writeHead(504, { 'content-type': 'application/json' });
                        res.end(JSON.stringify(formatError(504)));
                    } else if (!res.destroyed) {
                        res.destroy();
                    }
                } catch (_) { /* socket may already be destroyed */ }
            }, timeoutMs);
        };
        // Set default deadline immediately (covers non-model passthrough and the
        // window before slot resolution).  Adjusted for subagent slots below.
        setRequestDeadline(120_000, 'default');
        res.once('finish', clearRequestDeadline);
        res.once('close', clearRequestDeadline);

        (async () => {
            let model: string | null = null;
            let parsedBody: Record<string, unknown> | null = null;
            try { const parsed = JSON.parse(rawBody.toString()) as Record<string, unknown>; parsedBody = parsed; model = parsed.model as string; } catch (e) {
                if (rawBody.length === 0) {
                    log.info(reqId, 'body parse warning: empty body (likely health probe)');
                } else {
                    log.error(reqId, 'body parse error: ' + truncateForLog((e as Error).message));
                }
            }

            // Compute sanitized headers once for safe logging throughout the handler
            const safeHeaders = sanitizeHeaders(req.headers as Record<string, string | string[]>);

            // Non-model calls (OAuth, agent infrastructure, etc.) -> passthrough to Anthropic.
            if (!isModelCall) {
                const anthro = new URL('https://api.anthropic.com');
                const anthroPath = anthro.pathname.replace(/\/+$/, '') + req.url;
                const anthroHeaders: Record<string, string | string[] | undefined> = { ...req.headers };
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
                    headers: anthroHeaders as Record<string, string>,
                    timeout: 60000,
                }, (anthroRes: http.IncomingMessage) => {
                    const safeResHeaders: Record<string, string | string[] | undefined> = {};
                    const hopByHop = new Set(['transfer-encoding', 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'upgrade']);
                    for (const [k, v] of Object.entries(anthroRes.headers)) {
                        if (!hopByHop.has(k.toLowerCase())) safeResHeaders[k] = v;
                    }
                    if (!res.headersSent && !res.destroyed) {
                        res.writeHead(anthroRes.statusCode || 200, safeResHeaders as Record<string, string | number>);

                        // Stream deadline: the 120s request deadline above becomes a
                        // no-op once headers are sent, so add stream-level timeouts to
                        // prevent the pipeline from hanging forever if upstream sends
                        // headers+partial body then stalls.
                        const PASSTHROUGH_HEARTBEAT_MS = 60_000;
                        const PASSTHROUGH_DEADLINE_MS = 120_000;
                        let passthroughBytes = 0;
                        let streamHeartbeat: ReturnType<typeof setTimeout> | null = null;
                        let streamDeadline: ReturnType<typeof setTimeout> | null = null;
                        const cancelStreamTimeouts = () => {
                            if (streamHeartbeat) { clearTimeout(streamHeartbeat); streamHeartbeat = null; }
                            if (streamDeadline) { clearTimeout(streamDeadline); streamDeadline = null; }
                        };
                        const resetStreamHeartbeat = () => {
                            if (streamHeartbeat) clearTimeout(streamHeartbeat);
                            streamHeartbeat = setTimeout(() => {
                                if (res.destroyed || res.writableEnded) return;
                                anthroRes.destroy(new Error('Passthrough stream heartbeat timeout after ' + PASSTHROUGH_HEARTBEAT_MS / 1000 + 's, received ' + passthroughBytes + ' bytes'));
                            }, PASSTHROUGH_HEARTBEAT_MS);
                        };
                        streamDeadline = setTimeout(() => {
                            if (res.destroyed || res.writableEnded) return;
                            cancelStreamTimeouts();
                            anthroRes.destroy(new Error('Passthrough stream deadline after ' + PASSTHROUGH_DEADLINE_MS / 1000 + 's, received ' + passthroughBytes + ' bytes'));
                        }, PASSTHROUGH_DEADLINE_MS);
                        resetStreamHeartbeat();
                        anthroRes.on('data', (chunk: Buffer) => {
                            passthroughBytes += chunk.length;
                            resetStreamHeartbeat();
                        });
                        anthroRes.once('end', cancelStreamTimeouts);
                        anthroRes.once('error', cancelStreamTimeouts);

                        pipeline(anthroRes, res, (err: Error | null) => {
                            cancelStreamTimeouts();
                            if (err) log.error(reqId, 'pipeline error: ' + scrubCredentials(err.message));
                        });
                    }
                });
                anthroReq.on('timeout', () => { anthroReq.destroy(); try { if (!res.headersSent && !res.destroyed) { res.writeHead(504); res.end(); } } catch (_) { /* socket may already be destroyed */ } });
                anthroReq.on('error', (err: Error) => {
                    log.error(reqId, 'passthrough upstream error: ' + scrubCredentials(err.message));
                    try {
                        if (!res.headersSent && !res.destroyed) {
                            res.writeHead(502);
                            res.end(JSON.stringify(formatError(502, null, isDev)));
                        }
                    } catch (_) { /* socket may already be destroyed */ }
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
                    const classification = classifyRequest(parsedBody);
                    const routeOverride = resolvePromptRoute(slot, classification, state.routing.promptRouter, state.routing);
                    if (routeOverride) {
                        log.info(reqId, 'prompt-router: ' + slot + ' ' + classification.tier + ' -> ' + routeOverride.providerKey + ':' + routeOverride.rewriteModel);
                        model = routeOverride.providerKey + ':' + routeOverride.rewriteModel;
                    }
                }
            }

            const resolved = resolveTarget(model, state.routing, state.slotOverrides, parsed.singleUrl, parsed.singleKey);

            if (resolved.error) {
                const err = formatError(502, { provider: 'unknown' }, isDev);
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

            // Tighten the request deadline for subagent slots: they run as
            // background tasks and a stall should be surfaced quickly so the
            // parent can retry or fail over rather than hanging indefinitely.
            if (slot === 'subagent') {
                clearRequestDeadline();
                setRequestDeadline(90_000, 'subagent');
            }

            let canaryEntry: CanaryEntry | null = null;
            if (slot && state.routing?.canary?.[slot] && state.routing?.providers) {
                const cfg = state.routing.canary[slot];
                const warmupPercent = cfg.warmupPercent ?? 10;
                const config: CanaryConfig = {
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
                        const resolvedKey = resolveKey(rawKey);
                        if (!(rawKey.startsWith('$aes256gcm:') && resolvedKey === null)) {
                            const entry = getOrCreateEntry(slot, config);
                            const hash = bodyHash(rawBody.toString(), slot);

                            if (shouldUseCanary(hash, entry.state, entry.config)) {
                                const canaryTarget: ResolvedTarget = {
                                    providerKey: config.targetProvider,
                                    url: providerEntry.url,
                                    key: resolvedKey,
                                    isBearer: providerEntry.auth === 'bearer',
                                    targetUrl: new URL(providerEntry.url),
                                    rewriteModel: cfg.targetModel,
                                    format: providerEntry.format || 'anthropic',
                                };

                                const originalPrimary = resolved.primary!;
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
                        const populated = await populateToolResults(parsedBody.messages as any[]);
                        if (populated) modified = true;
                    }

                    const conv = convertServerTools(parsedBody.tools as any[]);
                    if (conv.hasWebSearch || conv.hasWebFetch) {
                        parsedBody.tools = conv.tools as any[];
                        modified = true;
                    }

                    if (modified) { baseBody = Buffer.from(JSON.stringify(parsedBody)); bodyPreprocessed = true; }
                } catch (e) {
                    log.error(reqId, 'preprocessing error: ' + truncateForLog((e as Error).message));
                }
            }

            const resolvedResult = resolved as { primary: ResolvedTarget; fallbacks: ResolvedTarget[] };

            // Budget cap check -- stop forwarding if spend exceeds configured caps
            const budgetReason = checkBudget();
            if (budgetReason) {
              if (!res.headersSent && !res.destroyed) {
                const streamingClient = isStreamingClient(req.headers as Record<string, string | string[] | undefined>, parsedBody);
                if (streamingClient) {
                  const friendlyEvents = 'event: error\ndata: ' + JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: budgetReason } }) + '\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\ndata: [DONE]\n\n';
                  res.writeHead(200, (sseHeaders({}) as Record<string, string | number>));
                  res.write(friendlyEvents);
                  res.end();
                } else {
                  res.writeHead(402, { 'content-type': 'application/json', 'x-budget-cap': 'true' });
                  res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: budgetReason } }));
                }
              }
              return;
            }

            const chain: ResolvedTarget[] = [resolvedResult.primary, ...resolvedResult.fallbacks.filter(fb => isProviderHealthy(fb.providerKey))];
            if (chain.length > 3) {
                log.warn(reqId, 'Fallback chain truncated from ' + chain.length + ' to 3 providers');
                chain.length = 3;
            }

            // Session momentum: if this conversation has a history of successful
            // responses from a particular provider, prefer it at the front of fallbacks.
            const sk = sessionKey(parsedBody as Record<string, unknown>);
            if (sk && chain.length > 1) {
                const momentum = getMomentum(sk);
                if (momentum && momentum.preferredProvider && momentum.confidence >= 2) {
                    const fbIdx = chain.findIndex(
                        (t, i) => i > 0 && t.providerKey === momentum.preferredProvider
                    );
                    if (fbIdx > 1) {
                        const [preferred] = chain.splice(fbIdx, 1);
                        chain.splice(1, 0, preferred);
                    }
                }
            }

            let lastStatus: number | null = null;
            let lastRawBody: string | null = null;
            let lastQualityReason: string | null = null;
            let fallbackFromModel: string | null = null;
            const attemptedProviders: Array<{ providerKey: string }> = [];
            let lastAttemptMs = 0;

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
                    } catch (e) {
                        log.error(reqId, 'model rewrite error: ' + truncateForLog((e as Error).message));
                    }
                }

                // Protocol translation
                let streamTransformer: Transform | null = null;
                if (target.format === 'openai') {
                    try {
                        const reqParsed = JSON.parse(forwardedBody.toString());
                        const { openaiBody } = translateRequest(reqParsed);
                        forwardedBody = Buffer.from(JSON.stringify(openaiBody));
                        if (reqParsed.stream) {
                            const transformerModel = target.rewriteModel || model || reqParsed.model;
                            streamTransformer = createStreamTransformer(transformerModel);
                        }
                    } catch (e) {
                        log.error(reqId, 'protocol translation error: ' + truncateForLog((e as Error).message));
                    }
                }

                // Build upstream path
                const basePath = target.targetUrl.pathname.replace(/\/+$/, '');
                const upstreamPath = deduplicatePath(basePath, req.url || '');

                // Tighter upstream HTTP timeout for subagent slots: they are
                // background tasks and a hung connection should surface quickly.
                const upstreamTimeout = slot === 'subagent' ? 45_000 : 60_000;
                const options = {
                    hostname: target.targetUrl.hostname,
                    port: target.targetUrl.port || (target.targetUrl.protocol === 'https:' ? 443 : 80),
                    path: upstreamPath,
                    method: req.method || 'POST',
                    headers: { ...req.headers } as Record<string, string | string[] | undefined>,
                    timeout: upstreamTimeout,
                    agent: keepAliveAgent,
                };

                delete options.headers['host'];
                delete options.headers['connection'];
                delete options.headers['proxy-authorization'];
                delete options.headers['content-length'];
                delete options.headers['transfer-encoding'];
                delete options.headers['accept-encoding'];
                delete options.headers['cookie'];
                delete options.headers['set-cookie'];
                delete options.headers['x-forwarded-for'];
                delete options.headers['x-forwarded-proto'];
                delete options.headers['x-forwarded-host'];
                delete options.headers['x-forwarded-port'];
                delete options.headers['x-real-ip'];
                delete options.headers['forwarded'];

                if (target.isBearer) {
                    options.headers['authorization'] = 'Bearer ' + target.key;
                    delete options.headers['x-api-key'];
                } else {
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
                            injectThinkingBlocks(reqParsed.messages as any[]);
                            forwardedBody = Buffer.from(JSON.stringify(reqParsed));
                        }
                    } catch (e) {
                        log.error(reqId, 'thinking injection error: ' + truncateForLog((e as Error).message));
                    }
                } else if (target.format === 'openai') {
                    try {
                        const reqParsed = JSON.parse(forwardedBody.toString());
                        if (reqParsed.messages) {
                            // Strip thinking blocks (Anthropic format -> OpenAI format)
                            reqParsed.messages = reqParsed.messages.map((m: Record<string, unknown>) => {
                                if (m.role === 'assistant' && Array.isArray(m.content)) {
                                    m.content = (m.content as Array<{ type: string }>).filter(b => b.type !== 'thinking');
                                }
                                return m;
                            });
                            // Re-inject reasoning_content stripped by SDKs
                            reinjectReasoningContent(reqParsed.messages as any[]);
                            forwardedBody = Buffer.from(JSON.stringify(reqParsed));
                        }
                    } catch (e) {
                        log.error(reqId, 'thinking strip / reasoning inject error: ' + truncateForLog((e as Error).message));
                    }
                }

                // SSRF validation: ensure upstream URL doesn't point to private/internal IPs
                const upstreamUrl = target.url + upstreamPath;
                const ssrfResult = await validateUrl(upstreamUrl);
                if (!ssrfResult.valid) {
                    log.warn(reqId, 'SSRF validation failed for ' + target.providerKey + ': ' + (ssrfResult.reason || 'unknown'));
                    lastStatus = 502;
                    continue;  // skip this provider, try next in fallback chain
                }

                // Pin connection to validated IP to prevent DNS rebinding TOCTOU.
                // The original hostname is preserved in the Host header so the
                // upstream server can route correctly.  forward.ts should use
                // options.hostname (the pinned IP) and options.headers['Host']
                // (the original hostname) when making the HTTP request.
                if (ssrfResult.addresses && ssrfResult.addresses.length > 0) {
                    options.hostname = ssrfResult.addresses[0];
                    (options.headers as Record<string, string>)['Host'] = target.targetUrl.hostname;
                }

                const transport = target.targetUrl.protocol === 'https:' ? https : http;
                const t0 = Date.now();

                // Per-provider retry loop: retry transport errors with exponential
                // backoff before moving to the next fallback provider.
                let result: ForwardResult = { success: false };
                for (let provAttempt = 0; provAttempt <= MAX_PER_PROVIDER_RETRIES; provAttempt++) {
                    // Acquire per-slot concurrency slot before each attempt.
                    // Subagent requests use a dedicated pool to prevent starvation.
                    const { promise: slotPromise, cancel: cancelSlot } = concurrency.acquire(slot);
                    req.once('close', cancelSlot);
                    let release: (() => void) | null = null;
                    let slotReleased = false;
                    const onClose = () => {
                        if (!slotReleased) {
                            slotReleased = true;
                            release?.();
                        }
                    };
                    // Register onClose before awaiting slotPromise to eliminate the
                    // timing window where a client disconnect between the await and
                    // the registration would leak the slot.
                    res.once('close', onClose);
                    try {
                        release = await slotPromise;
                        // If client disconnected while waiting for slot, release
                        // immediately to prevent slot leak (the onClose handler
                        // already fired but release was null at that point).
                        if (slotReleased) {
                            release();
                            release = null;
                            return;
                        }
                    } catch {
                        slotReleased = true;
                        res.removeListener('close', onClose);
                        try {
                            if (!res.headersSent && !res.destroyed) {
                                res.writeHead(503, { 'content-type': 'application/json' });
                                res.end(JSON.stringify(formatError(503)));
                            }
                        } catch (_) { /* socket may already be destroyed */ }
                        return; // abort entire request -- can't get a slot
                    } finally {
                        req.removeListener('close', cancelSlot);
                    }

                    try {
                        result = await tryForward(transport as any, options as any, forwardedBody.toString(), streamTransformer, target.format === 'openai', parsedBody, model, reqId);
                    } finally {
                        if (!slotReleased) {
                            slotReleased = true;
                            release?.();
                        }
                        res.removeListener('close', onClose);
                    }

                    // Success -> stop retrying
                    if (result.success) break;

                    // Non-transport error (HTTP 4xx/5xx) -> stop retrying this provider
                    if (!result.transportError) break;

                    // Transport error, retries left -> backoff and retry
                    if (provAttempt < MAX_PER_PROVIDER_RETRIES) {
                        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, provAttempt);
                        log.warn(reqId, target.providerKey + ' ' + describeTransportError(new Error(result.error)) + ', retrying in ' + delay + 'ms (' + (MAX_PER_PROVIDER_RETRIES - provAttempt) + ' left)');
                        await new Promise(r => setTimeout(r, delay));
                    }
                }
                const ms = Date.now() - t0;
                lastAttemptMs = ms;

                if (result.success) {
                    recordStat(target.providerKey, true, ms);
                    recordRecentRequest({
                        timestamp: Date.now(),
                        model: model,
                        provider: target.providerKey,
                        status: result.status || 200,
                        ms: ms,
                        tokens: result.streamUsage ? { input: result.streamUsage.prompt_tokens || 0, output: result.streamUsage.completion_tokens || 0 } : null,
                        fallback: isRetry,
                    });
                    if (canaryEntry && attempt === 0) {
                        recordCanaryResult(true, canaryEntry.state, canaryEntry.config);
                    }
                    if (result.streamUsage) {
                        recordUsage(target.providerKey, result.streamUsage.prompt_tokens || 0, result.streamUsage.completion_tokens || 0);
                        const upstreamModel = target.rewriteModel || model;
                        if (upstreamModel) recordSpend(upstreamModel, result.streamUsage, target.providerKey).catch(() => {});
                    }
                    if (sk) recordMomentum(sk, target.providerKey, model || '');

                    const label = target.providerKey || 'upstream';
                    if (isRetry) {
                        log.info(reqId, req.method + ' ' + (model || '-') + ' -> ' + label + ' ' + result.status + ' ' + ms + 'ms (fallback #' + attempt + ')');
                    } else {
                        log.info(reqId, req.method + ' ' + (model || '-') + ' -> ' + label + ' ' + result.status + ' ' + ms + 'ms');
                    }

                    // Record request log entry
                    {
                        const logEntry: RequestLogEntry = {
                            timestamp: new Date().toISOString(),
                            requestId: reqId,
                            method: req.method || 'POST',
                            url: (req.url || '').split('?')[0],
                            model: model || '',
                            providerKey: target.providerKey,
                            slot: slot || '',
                            status: result.status || 200,
                            success: true,
                            fallbackUsed: isRetry,
                            fallbackChain: attemptedProviders.map(p => p.providerKey),
                            latencyMs: ms,
                            userAgent: (req.headers['user-agent'] as string) || undefined,
                        };
                        if (result.streamUsage) {
                            logEntry.tokensIn = result.streamUsage.prompt_tokens;
                            logEntry.tokensOut = result.streamUsage.completion_tokens;
                        }
                        logRequest(logEntry);
                    }

                    // Add fallback response headers
                    let outHeaders = result.headers || {};
                    if (isRetry) {
                        outHeaders = addFallbackHeaders(outHeaders, {
                            fallbackFromModel,
                            fallbackIndex: attempt,
                        });
                    }

                    // Register cleanup on client disconnect before the
                    // headersSent/destroyed check to eliminate the TOCTOU race
                    // where the client disconnects between the check and pipeline.
                    const clientStream = result.stream;
                    if (clientStream) {
                        res.once('close', () => {
                            if (!(clientStream as any).destroyed) (clientStream as any).destroy();
                        });
                    }

                    if (!res.headersSent && !res.destroyed) {
                        res.writeHead(result.status || 200, outHeaders as Record<string, string | number>);
                        if (result.body) {
                            res.end(result.body);
                            if (result.streamMetrics) {
                                recordStreamMetrics(target.providerKey, result.streamMetrics);
                            }
                        } else if (result.stream) {
                            result.stream.on('error', (err: Error) => {
                                log.error(reqId, 'Stream error for ' + model + ': ' + scrubCredentials(err.message));
                                try {
                                    if (!res.headersSent && !res.destroyed) {
                                        res.writeHead(502, { 'content-type': 'application/json' });
                                        res.end(JSON.stringify(formatError(502, null, isDev)));
                                    } else if (!res.destroyed) {
                                        res.write('event: error\ndata: ' + JSON.stringify(formatError(502, null, isDev)) + '\n\n');
                                        res.end();
                                    }
                                } catch (_) { /* socket may already be destroyed */ }
                            });
                            pipeline(result.stream, res, (err: Error | null) => {
                                if (result.streamTimings) {
                                    const streamMetrics = finalizeMetrics(result.streamTimings, result.streamUsage?.completion_tokens || 0);
                                    recordStreamMetrics(target.providerKey, streamMetrics);
                                }
                                if (result.streamUsage) {
                                    recordUsage(target.providerKey, result.streamUsage.prompt_tokens || 0, result.streamUsage.completion_tokens || 0);
                                    const upstreamModel = target.rewriteModel || model;
                                    if (upstreamModel) recordSpend(upstreamModel, result.streamUsage, target.providerKey).catch(() => {});
                                }
                                if (err) log.error(reqId, 'stream error: ' + scrubCredentials(err.message));
                            });
                        }
                    }
                    return;
                }

                recordStat(target.providerKey, false, ms, result.status);
                recordRecentRequest({
                    timestamp: Date.now(),
                    model: model,
                    provider: target.providerKey,
                    status: result.status || null,
                    ms: ms,
                    tokens: null,
                    fallback: isRetry,
                });
                if (canaryEntry && attempt === 0) {
                    recordCanaryResult(false, canaryEntry.state, canaryEntry.config);
                }
                lastStatus = result.status || null;
                lastRawBody = result.rawBody || null;

                const label = target.providerKey || 'upstream';

                // Quality failure -- continue to next fallback provider
                if (result.qualityFailure) {
                    lastQualityReason = result.qualityReason || null;
                    lastStatus = result.status || null;
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
                } else {
                    log.warn(reqId, req.method + ' ' + (model || '-') + ' -> ' + label + ' ERR ' + truncateForLog(result.error) + ' ' + ms + 'ms, trying next...');
                }
            }

            // All attempts exhausted
            {
                const logEntry: RequestLogEntry = {
                    timestamp: new Date().toISOString(),
                    requestId: reqId,
                    method: req.method || 'POST',
                    url: (req.url || '').split('?')[0],
                    model: model || '',
                    providerKey: attemptedProviders.length > 0 ? attemptedProviders[attemptedProviders.length - 1].providerKey : '',
                    slot: slot || '',
                    status: lastStatus || 502,
                    success: false,
                    fallbackUsed: attemptedProviders.length > 1,
                    fallbackChain: attemptedProviders.map(p => p.providerKey),
                    latencyMs: lastAttemptMs,
                    errorSummary: lastQualityReason || undefined,
                    userAgent: (req.headers['user-agent'] as string) || undefined,
                };
                logRequest(logEntry);
            }
            if (!res.headersSent && !res.destroyed) {
                log.info(reqId, 'all providers exhausted after ' + attemptedProviders.length + ' attempt(s) -- safe request headers: ' + JSON.stringify(safeHeaders.headers) + ' (' + safeHeaders.dropped + ' dropped)');
                const streamingClient = isStreamingClient(req.headers as Record<string, string | string[] | undefined>, parsedBody);
                const isChatClient = streamingClient ||
                    req.headers['anthropic-version'] ||
                    req.headers['x-api-key'] ||
                    isModelCall;

                if (streamingClient) {
                    const friendlyEvents = buildFriendlyStreamEvents(lastStatus, model, attemptedProviders, lastQualityReason);
                    try {
                        res.writeHead(200, sseHeaders({ 'x-fallback-exhausted': 'true' }) as Record<string, string | number>);
                        res.write(friendlyEvents);
                        res.end();
                    } catch (_) { /* socket may already be destroyed */ }
                } else if (isChatClient) {
                    const friendlyResp = buildFriendlyResponse(lastStatus, model, attemptedProviders, lastQualityReason);
                    try {
                        res.writeHead(friendlyResp.status, friendlyResp.headers);
                        res.end(friendlyResp.body);
                    } catch (_) { /* socket may already be destroyed */ }
                } else {
                    const exhaustedError = formatExhaustedError(lastStatus, lastRawBody, isDev, lastQualityReason);
                    const statusCode = (lastStatus && lastStatus >= 400 && lastStatus < 500) ? lastStatus : 502;
                    try {
                        res.writeHead(statusCode, { 'content-type': 'application/json', 'x-fallback-exhausted': 'true' });
                        res.end(JSON.stringify(exhaustedError));
                    } catch (_) { /* socket may already be destroyed */ }
                }
            }
        })().catch((err: Error) => {
            log.error(null, 'unhandled error in request handler: ' + truncateForLog(err.message || String(err)));
            try {
                if (!res.headersSent && !res.destroyed) { res.writeHead(502); res.end(JSON.stringify(formatError(502, null, isDev))); }
            } catch (_) { /* socket may already be destroyed */ }
        }).finally(() => {
            activeConnections--;
        });
    });
});

// Auto-probe scheduler for circuit breaker recovery
setInterval(() => {
    const keys = getRegisteredProviderKeys();
    for (const pk of keys) {
        const info = getProviderInfo(pk);
        if (!info) continue;
        const probeTarget = maybeStartProbe(pk);
        if (probeTarget) {
            const slot: ProbeSlot = {
                slot: '',
                providerKey: pk,
                model: probeTarget.model,
                url: probeTarget.url,
                key: probeTarget.key,
                isBearer: probeTarget.isBearer,
                format: probeTarget.format,
            };
            sendProbe(slot).then((result) => {
                const isHealthy = result.success || result.authFailed;
                recordProbeResult(pk, isHealthy);
                const action = isHealthy ? 'succeeded -- closing breaker' : 'failed -- extending cooldown';
                log.info(null, pk + ' circuit breaker HALF_OPEN probe ' + action);
            });
        }
    }
}, 15_000).unref();

// --- Startup health check ---
// Run provider preflight probes before accepting connections.
// If all providers are down, exit early so the user can fix config before
// Claude Code tries to use the proxy.
runStartupChecks().then((startupCheckResult) => {
    if (startupCheckResult.allDown) {
        log.error(null, 'All providers are down. Exiting.');
        process.exit(1);
    }
    if (startupCheckResult.someDown) {
        log.warn(null, 'Some providers are down. Continuing with degraded routing.');
    }

    // --- Lifecycle ---
    server.listen(0, '127.0.0.1', () => {
        const port = (server.address() as { port: number }).port;
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
}).catch((err: Error) => {
    log.error(null, 'Startup health check failed: ' + err.message);
    process.exit(1);
});

function gracefulShutdown(signal: string): void {
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

process.on('unhandledRejection', (reason: unknown) => {
    log.error(null, 'unhandledRejection: ' + scrubCredentials(String(reason)));
    gracefulShutdown('UNHANDLED_REJECTION');
});

process.on('uncaughtException', (err: Error) => {
    log.error(null, 'uncaughtException: ' + scrubCredentials(err.message || String(err)));
    if (typeof server !== 'undefined') {
        server.close(() => process.exit(1));
        setTimeout(() => process.exit(1), 10000);
    } else process.exit(1);
});
}
