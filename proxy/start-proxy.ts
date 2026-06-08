'use strict';

import http from 'http';
import https from 'https';
import { pipeline, Transform } from 'stream';

import { translateRequest, createStreamTransformer } from './protocol-translate';
import { injectThinkingBlocks } from './thinking-cache';
import { reinjectReasoningContent } from './reasoning-cache';
import { deduplicatePath } from './util';
import { parseArgs, loadConfig, checkReload, validateConfig } from './config';
import { resolveTarget, ResolvedTarget } from './routing';
import { tryForward, addFallbackHeaders, sseHeaders, type ForwardHeaders, type ForwardResult } from './forward';
import { convertServerTools, populateToolResults } from './server-tools';
import { isProviderHealthy, recordStat, recordUsage, getFullHealthSnapshot, nextRequestId } from './stats';
import { formatError, formatExhaustedError, scrubCredentials, isStreamingClient } from './error-codes';
import { truncateForLog } from './truncate';
import { createSlotLimiter } from './concurrency';
import { createLogger } from './log';
import { buildFriendlyResponse, buildFriendlyStreamEvents } from './friendly-error';
import { describe as describeTransportError } from './transport-errors';
import { createRateLimiter } from './rate-limiter';
import { sanitizeHeaders } from './header-sanitizer';
import { sessionKey, getMomentum, record as recordMomentum } from './momentum';
import { validateUrl } from './ssrf';

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

const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 50, keepAliveMsecs: 30000 });
const parsed = parseArgs(process.argv);
const state = loadConfig(parsed);

// Validate at startup (warn but don't block)
const configWarnings = validateConfig(state);
for (const w of configWarnings) {
    log.warn(null, w);
}

// Load provider registry for data-driven hooks (optional -- proxy works without it)
let providerRegistry: { providers: Record<string, { endpoint: string; extraHeaders?: Record<string, string> }> } | null = null;
try { providerRegistry = require('./providers.json'); } catch (_) { /* file not found, continue without registry */ }

const concurrency = createSlotLimiter();
const rateLimiter = createRateLimiter();
const isDev = process.env.DEEPCLAUDE_DEV === '1' || process.env.NODE_ENV === 'development';

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
        }
        chunks.push(chunk);
    });

    req.on('end', () => {
        if (body === null) return; // body read was cancelled (size limit exceeded)
        req.setTimeout(0);  // Clear slow-body guard — streaming phase may have long idle gaps
        activeConnections++;
        const rawBody = Buffer.concat(chunks);
        const reqId = nextRequestId();
        (async () => {
            let model: string | null = null;
            let parsedBody: Record<string, unknown> | null = null;
            try { const parsed = JSON.parse(rawBody.toString()) as Record<string, unknown>; parsedBody = parsed; model = parsed.model as string; } catch (e) {
                log.error(reqId, 'body parse error: ' + truncateForLog((e as Error).message));
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
                        pipeline(anthroRes, res, (err: Error | null) => {
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

            const resolved = resolveTarget(model, state.routing, state.slotOverrides, parsed.singleUrl, parsed.singleKey);

            if (resolved.error) {
                const err = formatError(502, { provider: 'unknown' }, isDev);
                err.message = resolved.error;
                res.writeHead(502);
                res.end(JSON.stringify(err));
                return;
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
            let fallbackFromModel: string | null = null;
            const attemptedProviders: Array<{ providerKey: string }> = [];

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
                        if (reqParsed.stream) streamTransformer = createStreamTransformer(model || reqParsed.model);
                    } catch (e) {
                        log.error(reqId, 'protocol translation error: ' + truncateForLog((e as Error).message));
                    }
                }

                // Build upstream path
                const basePath = target.targetUrl.pathname.replace(/\/+$/, '');
                const upstreamPath = deduplicatePath(basePath, req.url || '');

                const options = {
                    hostname: target.targetUrl.hostname,
                    port: target.targetUrl.port || (target.targetUrl.protocol === 'https:' ? 443 : 80),
                    path: upstreamPath,
                    method: req.method || 'POST',
                    headers: { ...req.headers } as Record<string, string | string[] | undefined>,
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

                const transport = target.targetUrl.protocol === 'https:' ? https : http;
                const t0 = Date.now();

                // Per-provider retry loop: retry transport errors with exponential
                // backoff before moving to the next fallback provider.
                let result: ForwardResult = { success: false };
                for (let provAttempt = 0; provAttempt <= MAX_PER_PROVIDER_RETRIES; provAttempt++) {
                    // Acquire concurrency slot before each attempt
                    const { promise: slotPromise, cancel: cancelSlot } = concurrency.acquire();
                    req.once('close', cancelSlot);
                    let release: () => void;
                    try {
                        release = await slotPromise;
                    } catch {
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
                    const onClose = () => release();
                    res.once('close', onClose);

                    try {
                        result = await tryForward(transport as any, options as any, forwardedBody.toString(), streamTransformer, target.format === 'openai', parsedBody, model, reqId);
                    } finally {
                        release();
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

                if (result.success) {
                    recordStat(target.providerKey, true, ms);
                    if (result.streamUsage) {
                        recordUsage(target.providerKey, result.streamUsage.prompt_tokens || 0, result.streamUsage.completion_tokens || 0);
                    }
                    if (sk) recordMomentum(sk, target.providerKey, model || '');

                    const label = target.providerKey || 'upstream';
                    if (isRetry) {
                        log.info(reqId, req.method + ' ' + (model || '-') + ' -> ' + label + ' ' + result.status + ' ' + ms + 'ms (fallback #' + attempt + ')');
                    } else {
                        log.info(reqId, req.method + ' ' + (model || '-') + ' -> ' + label + ' ' + result.status + ' ' + ms + 'ms');
                    }

                    // Add fallback response headers
                    let outHeaders = result.headers || {};
                    if (isRetry) {
                        outHeaders = addFallbackHeaders(outHeaders, {
                            fallbackFromModel,
                            fallbackIndex: attempt,
                        });
                    }

                    if (!res.headersSent && !res.destroyed) {
                        res.writeHead(result.status || 200, outHeaders as Record<string, string | number>);
                        if (result.body) {
                            res.end(result.body);
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
                                if (result.streamUsage) {
                                    recordUsage(target.providerKey, result.streamUsage.prompt_tokens || 0, result.streamUsage.completion_tokens || 0);
                                }
                                if (err) log.error(reqId, 'stream error: ' + scrubCredentials(err.message));
                            });
                            // Propagate client disconnect to upstream
                            res.on('close', () => {
                                const s = result.stream as NodeJS.ReadableStream & { destroyed: boolean; destroy(): void };
                                if (s && !s.destroyed) s.destroy();
                            });
                        }
                    }
                    return;
                }

                recordStat(target.providerKey, false, ms);
                lastStatus = result.status || null;
                lastRawBody = result.rawBody || null;

                const label = target.providerKey || 'upstream';

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
            if (!res.headersSent && !res.destroyed) {
                log.info(reqId, 'all providers exhausted after ' + attemptedProviders.length + ' attempt(s) -- safe request headers: ' + JSON.stringify(safeHeaders.headers) + ' (' + safeHeaders.dropped + ' dropped)');
                const streamingClient = isStreamingClient(req.headers as Record<string, string | string[] | undefined>, parsedBody);
                const isChatClient = streamingClient ||
                    req.headers['anthropic-version'] ||
                    req.headers['x-api-key'] ||
                    isModelCall;

                if (streamingClient) {
                    const friendlyEvents = buildFriendlyStreamEvents(lastStatus, model, attemptedProviders);
                    try {
                        res.writeHead(200, sseHeaders({ 'x-fallback-exhausted': 'true' }) as Record<string, string | number>);
                        res.write(friendlyEvents);
                        res.end();
                    } catch (_) { /* socket may already be destroyed */ }
                } else if (isChatClient) {
                    const friendlyResp = buildFriendlyResponse(lastStatus, model, attemptedProviders);
                    try {
                        res.writeHead(friendlyResp.status, friendlyResp.headers);
                        res.end(friendlyResp.body);
                    } catch (_) { /* socket may already be destroyed */ }
                } else {
                    const exhaustedError = formatExhaustedError(lastStatus, lastRawBody, isDev);
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

// --- Lifecycle ---

server.listen(0, '127.0.0.1', () => {
    const port = (server.address() as { port: number }).port;
    process.stdout.write('PORT:' + String(port));
});
server.timeout = 0;

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
    process.exit(1);
});

process.on('uncaughtException', (err: Error) => {
    log.error(null, 'uncaughtException: ' + scrubCredentials(err.message || String(err)));
    if (typeof server !== 'undefined') {
        server.close(() => process.exit(1));
        setTimeout(() => process.exit(1), 10000);
    } else process.exit(1);
});
