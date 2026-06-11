'use strict';

// Upstream forwarding with stream warmup, protocol translation, and
// fallback response headers.

import http from 'http';
import zlib from 'zlib';
import { pipeline, Transform } from 'stream';
import { buildSafeHeaders } from './util';
import { translateResponse } from './protocol-translate';
import { extractThinkingBlocks, store } from './thinking-cache';
import type { Message as ThinkingMessage } from './thinking-cache';
import { extractReasoningContent, store as storeReasoning } from './reasoning-cache';
import type { Message as ReasoningMessage } from './reasoning-cache';
import { describe as describeTransportError } from './transport-errors';
import { createLogger } from './log';
import { truncateForLog } from './truncate';
import { startStreamTimer, recordFirstToken, recordChunk, finalizeMetrics } from './stream-metrics';
import type { StreamTimings, StreamMetrics } from './stream-metrics';

const log = createLogger('forward');

const upstreamAgent = new http.Agent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: 25 });

// Max buffer size per SSE event before we abort (prevents unbounded memory
// from a misbehaving upstream).
export const MAX_SSE_BUFFER = 1_048_576; // 1MB

// Total byte cap for a single streaming response (prevents unbounded memory
// consumption from infinite/malformed SSE streams).
export const MAX_TOTAL_STREAM_BYTES = 500 * 1024 * 1024; // 500MB

// Read timeout for upstream SSE streams during the active streaming phase.
// If no data arrives within this window the stream is destroyed, preventing
// the proxy from hanging forever on silently-dropped connections.
// Set to 300s (5 min) to accommodate reasoning models (DeepSeek R1, o1 etc.)
// that may think for several minutes on complex problems.
export const STREAM_READ_TIMEOUT_MS = 300_000;

// First-byte timeout: if the upstream accepts the connection but never sends
// a single byte within this window, treat it as a dead stream and fail over.
export const FIRST_BYTE_TIMEOUT_MS = 15_000;

// Per-chunk heartbeat: if no data arrives during active streaming within
// this window the connection is considered silently dead.  The timer resets
// on every data chunk (not just SSE events).
// Set to 180s (3 min) to accommodate reasoning/thinking models (DeepSeek R1,
// o1) that can think for 2+ minutes without sending SSE data. Configurable
// via DEEPCLAUDE_STREAM_HEARTBEAT_MS env var.
export const STREAM_HEARTBEAT_MS = 180_000;

// Slot-aware stream timeout overrides. Subagent requests use tighter limits
// since they run as background tasks and should fail fast on stalls.
// Heartbeat timeouts are configurable via environment variables so operators
// can tune per-deployment for reasoning models (DeepSeek R1, o1 etc.) that
// may think for 2+ minutes without sending SSE data.
function getStreamTimeouts(slot: string | null): {
    firstByte: number;
    heartbeat: number;
    deadline: number;
    bodyRead: number;
} {
    const defaultHeartbeat = parseInt(process.env.DEEPCLAUDE_STREAM_HEARTBEAT_MS || '', 10) || STREAM_HEARTBEAT_MS;
    const subagentHeartbeat = parseInt(process.env.DEEPCLAUDE_SUBAGENT_STREAM_HEARTBEAT_MS || '', 10) || 90_000;
    if (slot === 'subagent') {
        return {
            firstByte: 10_000,   // 10s — subagents shouldn't have cold-start delays
            heartbeat: subagentHeartbeat,
            deadline: 90_000,    // 90s — matches start-proxy subagent request deadline
            bodyRead: 20_000,    // 20s — subagent responses are small (tool results)
        };
    }
    return {
        firstByte: FIRST_BYTE_TIMEOUT_MS,
        heartbeat: defaultHeartbeat,
        deadline: 120_000,         // 120s — matches start-proxy request deadline
        bodyRead: 30_000,        // 30s — default body read timeout
    };
}

// --- Types ---

export interface ForwardHeaders {
    [key: string]: string | string[] | undefined;
}
export interface ForwardResult {
    success: boolean;
    status?: number;
    headers?: ForwardHeaders;
    body?: Buffer;
    stream?: NodeJS.ReadableStream;
    streamUsage?: { prompt_tokens: number; completion_tokens: number } | null;
    error?: string;
    rawBody?: string | null;
    transportError?: boolean;
    qualityFailure?: boolean;
    qualityReason?: string;
    deadStream?: boolean;
    deadStreamReason?: string;
    streamTimings?: StreamTimings;
    streamMetrics?: StreamMetrics;
    _upstream?: NodeJS.WritableStream; // For cleanup on client disconnect
}
interface PeekResult {
    ok: boolean;
    firstChunk?: Buffer | null;
    reason?: string;
    message?: string;
}
interface FallbackMeta {
    fallbackFromModel?: string | null;
    fallbackIndex?: number;
    fallbackExhausted?: boolean;
}
// --- SSE response headers ---
// Sets standard headers for streaming responses. Includes no-transform
// to prevent intermediate proxies from applying compression, which would
// buffer the stream and destroy time-to-first-token latency.

export function sseHeaders(extra?: ForwardHeaders): ForwardHeaders {
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

export function peekFirstChunk(proxyRes: NodeJS.ReadableStream, timeoutMs?: number): Promise<PeekResult> {
    timeoutMs = timeoutMs || FIRST_BYTE_TIMEOUT_MS;

    return new Promise((resolve) => {
        const contentType = (proxyRes as unknown as { headers: Record<string, string | string[] | undefined> }).headers['content-type'] || '';
        if (!contentType.includes('text/event-stream')) {
            return resolve({ ok: true, firstChunk: null });
        }
        let resolved = false;
        const timer = setTimeout(() => {
            if (resolved) return;
            resolved = true;
            proxyRes.removeListener('readable', onReadable);
            proxyRes.removeListener('error', onError);
            (proxyRes as NodeJS.ReadableStream & { destroy(): void }).destroy();
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
                proxyRes.removeListener('end', onEnd);
                (proxyRes as NodeJS.ReadableStream & { unshift(chunk: Buffer): void }).unshift(chunk);
                resolve({ ok: true, firstChunk: chunk as Buffer });
        }
        };

        const onError = () => {
            if (resolved) return;
            resolved = true;
            clearTimeout(timer);
            proxyRes.removeListener('readable', onReadable);
            proxyRes.removeListener('error', onError);
            proxyRes.removeListener('end', onEnd);
            resolve({ ok: false, reason: 'error', message: 'stream error during peek' });
        };

        const onEnd = () => {
            if (resolved) return;
            resolved = true;
            clearTimeout(timer);
            proxyRes.removeListener('readable', onReadable);
            proxyRes.removeListener('error', onError);
            proxyRes.removeListener('end', onEnd);
            resolve({ ok: true, firstChunk: null });
        };

        proxyRes.on('readable', onReadable);

        // Check for data already buffered before listener was attached;
        // otherwise readable may never re-fire and we'd timeout a valid stream.
        const bufferedData = proxyRes.read();
        if (bufferedData !== null) {
            if (resolved) return;
            resolved = true;
            clearTimeout(timer);
            proxyRes.removeListener('readable', onReadable);
            proxyRes.removeListener('error', onError);
            proxyRes.removeListener('end', onEnd);
            (proxyRes as NodeJS.ReadableStream & { unshift(chunk: Buffer): void }).unshift(bufferedData);
            resolve({ ok: true, firstChunk: bufferedData as Buffer });
            return;
        }

        proxyRes.once('error', onError);
        proxyRes.once('end', onEnd);
    });
}
// --- Forward request to upstream provider ---
// Handles both streaming and non-streaming responses.
// On stream success, attaches a 'data' listener that enforces MAX_SSE_BUFFER.

interface TryForwardOptions {
    hostname: string;
    port: number | string;
    path: string;
    method: string;
    headers: Record<string, string | string[] | undefined>;
    timeout: number;
    agent?: http.Agent | boolean;
}
export function tryForward(
    transport: { request: (opts: TryForwardOptions, callback: (res: NodeJS.ReadableStream & { statusCode?: number; headers: Record<string, string | string[] | undefined> }) => void) => NodeJS.WritableStream },
    options: TryForwardOptions,
    forwardedBody: string,
    streamTransformer: Transform | null,
    isOpenAI: boolean,
    parsed: Record<string, unknown> | null | undefined,
    model: string | null | undefined,
    reqId: string | number | null | undefined
): Promise<ForwardResult> {
    // Extract slot for timeout differentiation — subagent requests get tighter limits.
    const slot = model ? (model.match(/^(sonnet|opus|haiku|subagent|fable):/) || [null])[1] : null;
    const to = getStreamTimeouts(slot);
    const forwardStart = Date.now();

    return new Promise((resolve) => {
        const streamUsage: { prompt_tokens: number; completion_tokens: number } = { prompt_tokens: 0, completion_tokens: 0 };
        let timings: StreamTimings | null = null;
        let responseStarted = false;
        let firstByteTimer: ReturnType<typeof setTimeout> | null = null;
        const proxy = transport.request({ ...options, agent: options.agent ?? upstreamAgent }, (proxyRes: NodeJS.ReadableStream & { statusCode?: number; headers: Record<string, string | string[] | undefined> }) => {
            responseStarted = true;
            if (firstByteTimer !== null) clearTimeout(firstByteTimer);
            if (proxyRes.statusCode && proxyRes.statusCode >= 400) {
                const errChunks: Buffer[] = [];
                let errSize = 0;
                proxyRes.on('data', (c: Buffer) => { errSize += c.length; if (errSize <= 10000) errChunks.push(c); });
                proxyRes.on('end', () => {
                    const errBody = Buffer.concat(errChunks).toString();

                    // Detect output-size / payload-too-large errors in the
                    // upstream response body.  Different providers have
                    // different output token limits — flagging these as
                    // quality failures tells the fallback loop to try the
                    // next provider instead of stopping.
                    let qualityFailure = false;
                    let qualityReason = '';
                    const lowerBody = errBody.toLowerCase();
                    if (proxyRes.statusCode === 413 ||
                        lowerBody.includes('max_tokens') ||
                        lowerBody.includes('too large') ||
                        lowerBody.includes('too long') ||
                        lowerBody.includes('output token') ||
                        lowerBody.includes('context length') ||
                        lowerBody.includes('token limit') ||
                        lowerBody.includes('maximum context') ||
                        lowerBody.includes('reduce the length') ||
                        lowerBody.includes('request too large')) {
                        qualityFailure = true;
                        qualityReason = 'Upstream rejected request as too large (HTTP ' + proxyRes.statusCode + ')' +
                            (errBody ? ': ' + errBody.slice(0, 200) : '');
                    }

                    // Mark transient 5xx errors as transport errors so the
                    // per-provider retry loop in start-proxy.ts retries them.
                    // 5xx from upstreams (especially 502/503/504) are often
                    // transient and a single retry succeeds.
                    const isRetryable5xx = proxyRes.statusCode >= 500 && proxyRes.statusCode < 600;

                    return resolve({
                        success: false,
                        status: proxyRes.statusCode,
                        error: qualityReason || 'HTTP ' + proxyRes.statusCode,
                        rawBody: errBody || null,
                        qualityFailure,
                        qualityReason: qualityReason || undefined,
                        transportError: isRetryable5xx || undefined,
                    });
                });
                proxyRes.on('error', (err: Error) => {
                    resolve({ success: false, error: describeTransportError(err), transportError: true });
                });
                return;
            }
            const ct = (proxyRes.headers['content-type'] as string) || '';
            const isStream = ct.includes('text/event-stream');

            if (isStream) {
                peekFirstChunk(proxyRes, to.firstByte).then(peek => {
                    if (!peek.ok) {
                        (proxy as NodeJS.WritableStream & { destroy(): void }).destroy();
                        return resolve({ success: false, error: 'Stream peek: ' + peek.reason });
                    }
                    // If the upstream ignored accept-encoding and returned gzip,
                    // decompress before SSE parsing so the downstream transformer
                    // and client receive clean text.
                    const ce = proxyRes.headers['content-encoding'];
                    const isGzip = typeof ce === 'string' && ce.includes('gzip');
                    let sourceStream: NodeJS.ReadableStream = proxyRes;
                    if (isGzip) {
                        try {
                            const gunzip = zlib.createGunzip();
                            proxyRes.pipe(gunzip);
                            proxyRes.on('error', (err: Error) => gunzip.destroy(err));
                            gunzip.on('error', (err: Error) => {
                                log.error(reqId, 'gunzip decompression error: ' + err.message);
                                (proxyRes as unknown as NodeJS.ReadableStream & { destroy(err?: Error): void }).destroy(err);
                            });
                            sourceStream = gunzip;
                            log.info(reqId, 'Decompressing gzip-encoded streaming response');
                        } catch (err) {
                            log.error(reqId, 'Failed to create gunzip: ' + truncateForLog((err as Error).message));
                            // Fall through — SSE parsing will likely fail but that
                            // is handled by existing error paths.
                        }
                    }
                    // Heartbeat: if no chunk arrives within the slot's heartbeat
                    // window the connection is silently dead.  Hard cap: total streaming
                    // duration is bounded by the slot's deadline.
                    let streamHeartbeat: ReturnType<typeof setTimeout> | null = null;
                    let streamDeadline: ReturnType<typeof setTimeout> | null = null;
                    let streamBytes = 0;
                    let streamEndedNormally = false;
                    const cancelStreamTimeouts = () => {
                        if (streamHeartbeat) { clearTimeout(streamHeartbeat); streamHeartbeat = null; }
                        if (streamDeadline) { clearTimeout(streamDeadline); streamDeadline = null; }
                    };
                    const resetStreamHeartbeat = () => {
                        if (streamHeartbeat) clearTimeout(streamHeartbeat);
                        streamHeartbeat = setTimeout(() => {
                            (proxyRes as unknown as NodeJS.ReadableStream & { destroy(err?: Error): void }).destroy(
                                new Error('Upstream stream read timeout (heartbeat) after ' + to.heartbeat / 1000 + 's, received ' + streamBytes + ' bytes')
                            );
                        }, to.heartbeat);
                        if (streamHeartbeat && typeof streamHeartbeat === 'object') (streamHeartbeat as NodeJS.Timeout).unref();
                    };
                    const elapsed = Date.now() - forwardStart;
                    const remainingDeadline = Math.max(5000, to.deadline - elapsed);
                    streamDeadline = setTimeout(() => {
                        cancelStreamTimeouts();
                        (proxyRes as unknown as NodeJS.ReadableStream & { destroy(err?: Error): void }).destroy(
                            new Error('Upstream stream read timeout (deadline) after ' + to.deadline / 1000 + 's, received ' + streamBytes + ' bytes')
                        );
                    }, remainingDeadline);
                    if (streamDeadline && typeof streamDeadline === 'object') (streamDeadline as NodeJS.Timeout).unref();
                    resetStreamHeartbeat();
                    sourceStream.on('data', (chunk: Buffer | string) => {
                        streamBytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
                        if (streamBytes > MAX_TOTAL_STREAM_BYTES) {
                            cancelStreamTimeouts();
                            (proxyRes as unknown as NodeJS.ReadableStream & { destroy(err?: Error): void }).destroy(
                                new Error('Stream response exceeds max size: ' + streamBytes + ' bytes')
                            );
                            return;
                        }
                        resetStreamHeartbeat();
                    });
                    sourceStream.once('end', () => {
                        streamEndedNormally = true;
                        cancelStreamTimeouts();
                    });
                    sourceStream.once('error', cancelStreamTimeouts);
                    sourceStream.once('close', () => {
                        if (streamEndedNormally) {
                            log.info(reqId, 'Stream completed normally, total bytes received: ' + streamBytes);
                        }
                    });

                    const outHeaders = sseHeaders(buildSafeHeaders(proxyRes.headers as Record<string, string | string[] | undefined>));
                    if (!outHeaders['content-type']) {
                        outHeaders['content-type'] = (proxyRes.headers['content-type'] as string) || 'text/event-stream';
                    }
                    let outStream: NodeJS.ReadableStream = sourceStream;
                    if (streamTransformer) {
                        pipeline(outStream as NodeJS.ReadableStream, streamTransformer, (err: Error | null) => {
                            if (err) log.error(reqId, 'transformer pipeline error: ' + truncateForLog(err.message));
                        });
                        outStream = streamTransformer;
                    }
                    // Extract token usage from raw upstream SSE data.
                    let rawUsageBuf = '';
                    sourceStream.on('data', (chunk: Buffer | string) => {
                        if (timings) {
                            recordFirstToken(timings);
                            recordChunk(timings);
                        }
                        rawUsageBuf += typeof chunk === 'string' ? chunk : chunk.toString();
                        if (rawUsageBuf.length > MAX_SSE_BUFFER) {
                            // Malformed upstream stream (missing SSE delimiters) — discard
                            // usage buffer to prevent unbounded memory growth, same guard
                            // as the outStream SSE buffer below, but preserve trailing partial event.
                            const lastSplit = rawUsageBuf.lastIndexOf('\n\n');
                            if (lastSplit >= 0) {
                                rawUsageBuf = rawUsageBuf.slice(lastSplit + 2);
                            } else {
                                rawUsageBuf = '';
                            }
                            return;
                        }
                        const parts = rawUsageBuf.split('\n\n');
                        rawUsageBuf = parts.pop() || '';
                        for (const part of parts) {
                            const dataLines = [...part.matchAll(/^data: ?(.*)$/gm)];
                            if (!dataLines.length) continue;
                            const payload = dataLines.map(m => m[1]).join('\n');
                            if (payload === '[DONE]') continue;
                            try {
                                const parsedPayload = JSON.parse(payload);
                                if (parsedPayload.usage) {
                                    const pt = parsedPayload.usage.prompt_tokens !== undefined ? parsedPayload.usage.prompt_tokens : parsedPayload.usage.input_tokens;
                                    const ct = parsedPayload.usage.completion_tokens !== undefined ? parsedPayload.usage.completion_tokens : parsedPayload.usage.output_tokens;
                                    if (pt !== undefined || ct !== undefined) {
                                        streamUsage.prompt_tokens = pt || 0; streamUsage.completion_tokens = ct || 0;
                                    }
                                }
                            } catch (_) { /* non-fatal */ }
                        }
                    }
                    );

                    // Enforce MAX_SSE_BUFFER per accumulated SSE event
                    let sseBuf = '';
                    outStream.on('data', (chunk: Buffer | string) => {
                        sseBuf += typeof chunk === 'string' ? chunk : chunk.toString();
                        const events = sseBuf.split('\n\n');
                        sseBuf = events.pop() || '';
                        for (const evt of events) {
                            if (evt.length > MAX_SSE_BUFFER) {
                                log.error(reqId, 'SSE event exceeded 1MB limit -- aborting stream');
                                const s = outStream as NodeJS.ReadableStream & { destroy(err?: Error): void };
                                process.nextTick(() => s.destroy(new Error('SSE event too large')));
                                return;
                            }
                        }
                        if (sseBuf.length > MAX_SSE_BUFFER) {
                            log.error(reqId, 'SSE event exceeded 1MB limit -- aborting stream');
                            const s = outStream as NodeJS.ReadableStream & { destroy(err?: Error): void };
                            process.nextTick(() => s.destroy(new Error('SSE event too large')));
                            return;
                        }
                    }
                    );

                    resolve({ success: true, status: proxyRes.statusCode, headers: outHeaders, stream: outStream, streamUsage, streamTimings: timings || undefined, _upstream: proxy });
                });
            } else {
                (proxyRes as unknown as NodeJS.ReadableStream & { setTimeout(ms: number, cb: () => void): void }).setTimeout(to.bodyRead, () => {
                    (proxyRes as unknown as NodeJS.ReadableStream & { destroy(): void }).destroy();
                    resolve({ success: false, error: 'Response read timeout after ' + to.bodyRead / 1000 + 's', transportError: true });
                });
                const chunks: Buffer[] = [];
                let totalSize = 0;
                proxyRes.on('data', (c: Buffer) => {
                    totalSize += c.length;
                    if (totalSize > 20_000_000) {
                        (proxyRes as unknown as NodeJS.ReadableStream & { destroy(): void }).destroy();
                        return resolve({ success: false, error: 'Response body too large' });
                    }
                    chunks.push(c);
                });
                proxyRes.on('error', (err: Error) => {
                    resolve({ success: false, error: err.message });
                });
                proxyRes.on('end', () => {
                    let responseBody = Buffer.concat(chunks);
                    // Decompress gzip-encoded responses if upstream ignored accept-encoding
                    if (typeof proxyRes.headers['content-encoding'] === 'string' && proxyRes.headers['content-encoding'].includes('gzip')) {
                        try {
                            responseBody = zlib.gunzipSync(responseBody);
                        } catch (_) { /* decompression failure — fall through to existing error handling */ }
                    }
                    let translationFailed = false;
                    if (isOpenAI) {
                        try {
                            const openaiResp = JSON.parse(responseBody.toString());

                            // Extract reasoning content from OpenAI response before translation
                            try {
                                const responseMsg = openaiResp.choices?.[0]?.message;
                                if (responseMsg && responseMsg.reasoning_content && responseMsg.tool_calls && responseMsg.tool_calls.length > 0 && parsed && parsed.messages) {
                                    const fullMessages = [...(parsed.messages as Array<Record<string, unknown>>), {
                                        role: 'assistant',
                                        content: responseMsg.content,
                                        tool_calls: responseMsg.tool_calls,
                                        reasoning_content: responseMsg.reasoning_content,
                                    }];
                                    const rc = extractReasoningContent(fullMessages as ReasoningMessage[]);
                                    if (rc) storeReasoning(rc.sk, rc.firstToolCallId, rc.reasoningContent);
                                }
                            } catch (_) { /* non-fatal */ }
                            const anthropicResp = translateResponse(openaiResp, model || '');
                            responseBody = Buffer.from(JSON.stringify(anthropicResp));
                        } catch (e) {
                            log.error(reqId, 'response translation error: ' + truncateForLog((e as Error).message));
                            translationFailed = true;
                        }
                    } else {
                        try {
                            const resp = JSON.parse(responseBody.toString());
                            if (resp.content && Array.isArray(resp.content)) {
                                const responseMsg = { role: 'assistant', content: resp.content };
                                const fullMessages = parsed && parsed.messages ? [...(parsed.messages as Array<Record<string, unknown>>), responseMsg] : [responseMsg];
                                const tc = extractThinkingBlocks(fullMessages as ThinkingMessage[]);
                                if (tc) {
                                    store(tc.sk, tc.firstToolUseId, tc.blocks, undefined, tc.fp);
                                    resp.content = resp.content.filter(
                                        (b: { type: string }) => b.type !== 'thinking' && b.type !== 'redacted_thinking'
                                    );
                                    responseBody = Buffer.from(JSON.stringify(resp));
                                }
                            }
                        } catch (e) {
                            log.error(reqId, 'thinking extraction error: ' + truncateForLog((e as Error).message));
                        }
                    }
                    const outHeaders = buildSafeHeaders(proxyRes.headers as Record<string, string | string[] | undefined>, { 'content-length': String(responseBody.length) });
                    if (translationFailed) {
                        resolve({ success: false, status: 502, error: 'Protocol translation failed' });
                    } else {
                        // Extract usage from original response body for non-streaming requests
                        try {
                            const originalText = Buffer.concat(chunks).toString();
                            const original = JSON.parse(originalText);
                            if (original.usage) {
                                const pt = original.usage.prompt_tokens !== undefined ? original.usage.prompt_tokens : original.usage.input_tokens;
                                const ct = original.usage.completion_tokens !== undefined ? original.usage.completion_tokens : original.usage.output_tokens;
                                if (pt !== undefined || ct !== undefined) {
                                    streamUsage.prompt_tokens = pt || 0; streamUsage.completion_tokens = ct || 0;
                                }
                            }
                        } catch (_) { /* non-fatal */ }
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
                            } catch (_) { /* non-fatal */ }
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
                            } catch (_) { /* non-fatal */ }
                        }
                        if (!qualityReason) {
                            try {
                                JSON.parse(responseBody.toString());
                            } catch (_) {
                                qualityReason = 'Response body is not valid JSON';
                            }
                        }
                        if (qualityReason) {
                            resolve({ success: false, status: proxyRes.statusCode, headers: outHeaders, body: responseBody, streamUsage, error: qualityReason, qualityFailure: true, qualityReason, streamMetrics: undefined });
                        } else {
                            resolve({ success: true, status: proxyRes.statusCode, headers: outHeaders, body: responseBody, streamUsage, streamMetrics: undefined, _upstream: proxy });
                        }
                    }
                });
        }
        });

        (proxy as NodeJS.WritableStream & { on(event: string, cb: (...args: unknown[]) => void): NodeJS.WritableStream }).on('timeout', () => {
            if (firstByteTimer !== null) clearTimeout(firstByteTimer);
            (proxy as NodeJS.WritableStream & { destroy(): void }).destroy();
            resolve({ success: false, error: 'Upstream timeout after 60s', transportError: true });
        });

        (proxy as NodeJS.WritableStream & { on(event: string, cb: (...args: unknown[]) => void): NodeJS.WritableStream }).on('error', (err: Error) => {
            if (firstByteTimer !== null) clearTimeout(firstByteTimer);
            const label = describeTransportError(err);
            resolve({ success: false, error: label, transportError: true });
        });

        // If the upstream accepts the connection but never sends a response
        // within the slot's first-byte window, treat it as a dead stream.
        firstByteTimer = setTimeout(() => {
            if (responseStarted) return;
            (proxy as NodeJS.WritableStream & { destroy(): void }).destroy();
            resolve({ success: false, error: 'No response within ' + to.firstByte / 1000 + 's', transportError: true, deadStream: true, deadStreamReason: 'first_byte_timeout' });
        }, to.firstByte);

        timings = startStreamTimer();
        proxy.write(forwardedBody);
        proxy.end();
    });
}
// --- Fallback response headers ---
// Annotate a working response with fallback metadata so clients can see
// what happened when the primary provider failed.

export function addFallbackHeaders(headers: ForwardHeaders, meta?: FallbackMeta | null): ForwardHeaders {
    if (!meta) return headers;
    const result: ForwardHeaders = { ...headers };
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
