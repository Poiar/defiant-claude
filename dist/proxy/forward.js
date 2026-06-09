'use strict';
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.STREAM_HEARTBEAT_MS = exports.FIRST_BYTE_TIMEOUT_MS = exports.STREAM_READ_TIMEOUT_MS = exports.MAX_SSE_BUFFER = void 0;
exports.sseHeaders = sseHeaders;
exports.peekFirstChunk = peekFirstChunk;
exports.tryForward = tryForward;
exports.addFallbackHeaders = addFallbackHeaders;
// Upstream forwarding with stream warmup, protocol translation, and
// fallback response headers.
const http_1 = __importDefault(require("http"));
const stream_1 = require("stream");
const util_1 = require("./util");
const protocol_translate_1 = require("./protocol-translate");
const thinking_cache_1 = require("./thinking-cache");
const reasoning_cache_1 = require("./reasoning-cache");
const transport_errors_1 = require("./transport-errors");
const log_1 = require("./log");
const truncate_1 = require("./truncate");
const log = (0, log_1.createLogger)('forward');
const upstreamAgent = new http_1.default.Agent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: 25 });
// Max buffer size per SSE event before we abort (prevents unbounded memory
// from a misbehaving upstream).
exports.MAX_SSE_BUFFER = 1_048_576; // 1MB
// Read timeout for upstream SSE streams during the active streaming phase.
// If no data arrives within this window the stream is destroyed, preventing
// the proxy from hanging forever on silently-dropped connections.
exports.STREAM_READ_TIMEOUT_MS = 120_000;
// First-byte timeout: if the upstream accepts the connection but never sends
// a single byte within this window, treat it as a dead stream and fail over.
exports.FIRST_BYTE_TIMEOUT_MS = 15_000;
// Per-chunk heartbeat: if no data arrives during active streaming within
// this window the connection is considered silently dead.  The timer resets
// on every data chunk (not just SSE events).
exports.STREAM_HEARTBEAT_MS = 30_000;
// --- SSE response headers ---
// Sets standard headers for streaming responses. Includes no-transform
// to prevent intermediate proxies from applying compression, which would
// buffer the stream and destroy time-to-first-token latency.
function sseHeaders(extra) {
    return Object.assign({
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        'connection': 'keep-alive',
        'x-accel-buffering': 'no',
    }, extra || {});
}
// --- Stream warmup: peek first SSE chunk before committing headers ---
// Returns { ok: true, firstChunk } on success, { ok: false, reason } on failure.
// This prevents committing to a provider that returns 200 but never sends data.
function peekFirstChunk(proxyRes, timeoutMs) {
    timeoutMs = timeoutMs || 15000;
    return new Promise((resolve) => {
        const contentType = proxyRes.headers['content-type'] || '';
        if (!contentType.includes('text/event-stream')) {
            return resolve({ ok: true, firstChunk: null });
        }
        let resolved = false;
        const timer = setTimeout(() => {
            if (resolved)
                return;
            resolved = true;
            proxyRes.removeListener('readable', onReadable);
            proxyRes.removeListener('error', onError);
            proxyRes.destroy();
            resolve({ ok: false, reason: 'timeout' });
        }, timeoutMs);
        const onReadable = () => {
            if (resolved)
                return;
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
            if (resolved)
                return;
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
function tryForward(transport, options, forwardedBody, streamTransformer, isOpenAI, parsed, model, reqId) {
    return new Promise((resolve) => {
        let streamUsage = null;
        let responseStarted = false;
        let firstByteTimer = null;
        const proxy = transport.request({ ...options, agent: options.agent ?? upstreamAgent }, (proxyRes) => {
            responseStarted = true;
            if (firstByteTimer !== null)
                clearTimeout(firstByteTimer);
            if (proxyRes.statusCode && proxyRes.statusCode >= 400) {
                const errChunks = [];
                let errSize = 0;
                proxyRes.on('data', (c) => { errSize += c.length; if (errSize <= 10000)
                    errChunks.push(c); });
                proxyRes.on('end', () => {
                    const errBody = Buffer.concat(errChunks).toString();
                    return resolve({
                        success: false,
                        status: proxyRes.statusCode,
                        error: 'HTTP ' + proxyRes.statusCode,
                        rawBody: errBody || null,
                    });
                });
                proxyRes.on('error', (err) => {
                    resolve({ success: false, error: (0, transport_errors_1.describe)(err), transportError: true });
                });
                return;
            }
            const ct = proxyRes.headers['content-type'] || '';
            const isStream = ct.includes('text/event-stream');
            if (isStream) {
                peekFirstChunk(proxyRes).then(peek => {
                    if (!peek.ok) {
                        proxy.destroy();
                        return resolve({ success: false, error: 'Stream peek: ' + peek.reason });
                    }
                    // Heartbeat: if no chunk arrives within STREAM_HEARTBEAT_MS the
                    // connection is silently dead.  Hard cap: total streaming duration
                    // is bounded by STREAM_READ_TIMEOUT_MS.
                    let streamHeartbeat = null;
                    let streamDeadline = null;
                    const cancelStreamTimeouts = () => {
                        if (streamHeartbeat) {
                            clearTimeout(streamHeartbeat);
                            streamHeartbeat = null;
                        }
                        if (streamDeadline) {
                            clearTimeout(streamDeadline);
                            streamDeadline = null;
                        }
                    };
                    const resetStreamHeartbeat = () => {
                        if (streamHeartbeat)
                            clearTimeout(streamHeartbeat);
                        streamHeartbeat = setTimeout(() => {
                            proxyRes.destroy(new Error('Upstream stream read timeout (heartbeat) after ' + exports.STREAM_HEARTBEAT_MS / 1000 + 's'));
                        }, exports.STREAM_HEARTBEAT_MS);
                    };
                    streamDeadline = setTimeout(() => {
                        cancelStreamTimeouts();
                        proxyRes.destroy(new Error('Upstream stream read timeout (deadline) after ' + exports.STREAM_READ_TIMEOUT_MS / 1000 + 's'));
                    }, exports.STREAM_READ_TIMEOUT_MS);
                    resetStreamHeartbeat();
                    proxyRes.on('data', resetStreamHeartbeat);
                    proxyRes.once('end', cancelStreamTimeouts);
                    proxyRes.once('error', cancelStreamTimeouts);
                    const outHeaders = sseHeaders((0, util_1.buildSafeHeaders)(proxyRes.headers));
                    if (!outHeaders['content-type']) {
                        outHeaders['content-type'] = proxyRes.headers['content-type'] || 'text/event-stream';
                    }
                    let outStream = proxyRes;
                    if (streamTransformer) {
                        (0, stream_1.pipeline)(outStream, streamTransformer, (err) => {
                            if (err)
                                log.error(reqId, 'transformer pipeline error: ' + (0, truncate_1.truncateForLog)(err.message));
                        });
                        outStream = streamTransformer;
                    }
                    // Extract token usage from raw upstream SSE data.
                    let rawUsageBuf = '';
                    proxyRes.on('data', (chunk) => {
                        rawUsageBuf += typeof chunk === 'string' ? chunk : chunk.toString();
                        if (rawUsageBuf.length > exports.MAX_SSE_BUFFER) {
                            // Malformed upstream stream (missing SSE delimiters) — discard
                            // usage buffer to prevent unbounded memory growth, same guard
                            // as the outStream SSE buffer below.
                            rawUsageBuf = '';
                            return;
                        }
                        const parts = rawUsageBuf.split('\n\n');
                        rawUsageBuf = parts.pop() || '';
                        for (const part of parts) {
                            const dataMatch = part.match(/^data: (.+)/m);
                            if (!dataMatch)
                                continue;
                            const payload = dataMatch[1];
                            if (payload === '[DONE]')
                                continue;
                            try {
                                const parsedPayload = JSON.parse(payload);
                                if (parsedPayload.usage) {
                                    const pt = parsedPayload.usage.prompt_tokens !== undefined ? parsedPayload.usage.prompt_tokens : parsedPayload.usage.input_tokens;
                                    const ct = parsedPayload.usage.completion_tokens !== undefined ? parsedPayload.usage.completion_tokens : parsedPayload.usage.output_tokens;
                                    if (pt !== undefined || ct !== undefined) {
                                        streamUsage = { prompt_tokens: pt || 0, completion_tokens: ct || 0 };
                                    }
                                }
                            }
                            catch (_) { /* non-fatal */ }
                        }
                    });
                    // Enforce MAX_SSE_BUFFER per accumulated SSE event
                    let sseBuf = '';
                    outStream.on('data', (chunk) => {
                        sseBuf += typeof chunk === 'string' ? chunk : chunk.toString();
                        const events = sseBuf.split('\n\n');
                        sseBuf = events.pop() || '';
                        for (const evt of events) {
                            if (evt.length > exports.MAX_SSE_BUFFER) {
                                log.error(reqId, 'SSE event exceeded 1MB limit -- aborting stream');
                                outStream.destroy(new Error('SSE event too large'));
                                return;
                            }
                        }
                        if (sseBuf.length > exports.MAX_SSE_BUFFER) {
                            log.error(reqId, 'SSE event exceeded 1MB limit -- aborting stream');
                            outStream.destroy(new Error('SSE event too large'));
                        }
                    });
                    resolve({ success: true, status: proxyRes.statusCode, headers: outHeaders, stream: outStream, streamUsage });
                });
            }
            else {
                proxyRes.setTimeout(30000, () => {
                    proxyRes.destroy();
                    resolve({ success: false, error: 'Response read timeout after 30s', transportError: true });
                });
                const chunks = [];
                let totalSize = 0;
                proxyRes.on('data', (c) => {
                    totalSize += c.length;
                    if (totalSize > 20_000_000) {
                        proxyRes.destroy();
                        return resolve({ success: false, error: 'Response body too large' });
                    }
                    chunks.push(c);
                });
                proxyRes.on('error', (err) => {
                    resolve({ success: false, error: err.message });
                });
                proxyRes.on('end', () => {
                    let responseBody = Buffer.concat(chunks);
                    let translationFailed = false;
                    if (isOpenAI) {
                        try {
                            const openaiResp = JSON.parse(responseBody.toString());
                            // Extract reasoning content from OpenAI response before translation
                            try {
                                const responseMsg = openaiResp.choices?.[0]?.message;
                                if (responseMsg && responseMsg.reasoning_content && responseMsg.tool_calls && responseMsg.tool_calls.length > 0 && parsed && parsed.messages) {
                                    const fullMessages = [...parsed.messages, {
                                            role: 'assistant',
                                            content: responseMsg.content,
                                            tool_calls: responseMsg.tool_calls,
                                            reasoning_content: responseMsg.reasoning_content,
                                        }];
                                    const rc = (0, reasoning_cache_1.extractReasoningContent)(fullMessages);
                                    if (rc)
                                        (0, reasoning_cache_1.store)(rc.sk, rc.firstToolCallId, rc.reasoningContent);
                                }
                            }
                            catch (_) { /* non-fatal */ }
                            const anthropicResp = (0, protocol_translate_1.translateResponse)(openaiResp, model || '');
                            responseBody = Buffer.from(JSON.stringify(anthropicResp));
                        }
                        catch (e) {
                            log.error(reqId, 'response translation error: ' + (0, truncate_1.truncateForLog)(e.message));
                            translationFailed = true;
                        }
                    }
                    else {
                        try {
                            const resp = JSON.parse(responseBody.toString());
                            if (resp.content && Array.isArray(resp.content)) {
                                const responseMsg = { role: 'assistant', content: resp.content };
                                const fullMessages = parsed && parsed.messages ? [...parsed.messages, responseMsg] : [responseMsg];
                                const tc = (0, thinking_cache_1.extractThinkingBlocks)(fullMessages);
                                if (tc) {
                                    (0, thinking_cache_1.store)(tc.sk, tc.firstToolUseId, tc.blocks, undefined, tc.fp);
                                    resp.content = resp.content.filter((b) => b.type !== 'thinking' && b.type !== 'redacted_thinking');
                                    responseBody = Buffer.from(JSON.stringify(resp));
                                }
                            }
                        }
                        catch (e) {
                            log.error(reqId, 'thinking extraction error: ' + (0, truncate_1.truncateForLog)(e.message));
                        }
                    }
                    const outHeaders = (0, util_1.buildSafeHeaders)(proxyRes.headers, { 'content-length': String(responseBody.length) });
                    if (translationFailed) {
                        resolve({ success: false, status: 502, error: 'Protocol translation failed' });
                    }
                    else {
                        // Extract usage from original response body for non-streaming requests
                        try {
                            const originalText = Buffer.concat(chunks).toString();
                            const original = JSON.parse(originalText);
                            if (original.usage) {
                                const pt = original.usage.prompt_tokens !== undefined ? original.usage.prompt_tokens : original.usage.input_tokens;
                                const ct = original.usage.completion_tokens !== undefined ? original.usage.completion_tokens : original.usage.output_tokens;
                                if (pt !== undefined || ct !== undefined) {
                                    streamUsage = { prompt_tokens: pt || 0, completion_tokens: ct || 0 };
                                }
                            }
                        }
                        catch (_) { /* non-fatal */ }
                        // Quality checks on non-streaming response
                        let qualityReason = '';
                        if (!qualityReason && streamUsage && streamUsage.completion_tokens > 0) {
                            try {
                                const reqBody = JSON.parse(forwardedBody);
                                if (typeof reqBody.max_tokens === 'number') {
                                    const limit = reqBody.max_tokens * 2;
                                    if (streamUsage.completion_tokens > limit) {
                                        qualityReason = 'Completion tokens (' + streamUsage.completion_tokens + ') exceed max_tokens limit (' + reqBody.max_tokens + ')';
                                    }
                                }
                            }
                            catch (_) { /* non-fatal */ }
                        }
                        if (!qualityReason) {
                            const bodyStr = responseBody.toString().trim();
                            if (bodyStr.length === 0) {
                                qualityReason = 'Response body is empty';
                            }
                        }
                        if (!qualityReason) {
                            try {
                                const parsed = JSON.parse(responseBody.toString());
                                if (parsed.content && Array.isArray(parsed.content) && parsed.content.length === 0) {
                                    qualityReason = 'Response contains no content';
                                }
                            }
                            catch (_) { /* non-fatal */ }
                        }
                        if (!qualityReason) {
                            try {
                                JSON.parse(responseBody.toString());
                            }
                            catch (_) {
                                qualityReason = 'Response body is not valid JSON';
                            }
                        }
                        if (qualityReason) {
                            resolve({ success: false, status: proxyRes.statusCode, headers: outHeaders, body: responseBody, streamUsage, error: qualityReason, qualityFailure: true, qualityReason });
                        }
                        else {
                            resolve({ success: true, status: proxyRes.statusCode, headers: outHeaders, body: responseBody, streamUsage });
                        }
                    }
                });
            }
        });
        proxy.on('timeout', () => {
            if (firstByteTimer !== null)
                clearTimeout(firstByteTimer);
            proxy.destroy();
            resolve({ success: false, error: 'Upstream timeout after 60s', transportError: true });
        });
        proxy.on('error', (err) => {
            if (firstByteTimer !== null)
                clearTimeout(firstByteTimer);
            const label = (0, transport_errors_1.describe)(err);
            resolve({ success: false, error: label, transportError: true });
        });
        // If the upstream accepts the connection but never sends a response
        // within FIRST_BYTE_TIMEOUT_MS, treat it as a dead stream.
        firstByteTimer = setTimeout(() => {
            if (responseStarted)
                return;
            proxy.destroy();
            resolve({ success: false, error: 'No response within ' + exports.FIRST_BYTE_TIMEOUT_MS / 1000 + 's', transportError: true, deadStream: true, deadStreamReason: 'first_byte_timeout' });
        }, exports.FIRST_BYTE_TIMEOUT_MS);
        proxy.write(forwardedBody);
        proxy.end();
    });
}
// --- Fallback response headers ---
// Annotate a working response with fallback metadata so clients can see
// what happened when the primary provider failed.
function addFallbackHeaders(headers, meta) {
    if (!meta)
        return headers;
    const result = { ...headers };
    if (meta.fallbackFromModel) {
        result['x-fallback-from'] = meta.fallbackFromModel;
    }
    if (meta.fallbackIndex !== undefined && meta.fallbackIndex >= 0) {
        result['x-fallback-index'] = String(meta.fallbackIndex);
    }
    if (meta.fallbackExhausted) {
        result['x-fallback-exhausted'] = 'true';
    }
    return result;
}
