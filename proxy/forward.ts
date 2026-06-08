'use strict';

// Upstream forwarding with stream warmup, protocol translation, and
// fallback response headers.

import { pipeline, Transform } from 'stream';
import { buildSafeHeaders } from './util';
import { translateResponse } from './protocol-translate';
import { extractThinkingBlocks, store } from './thinking-cache';
import { extractReasoningContent, store as storeReasoning } from './reasoning-cache';
import { describe as describeTransportError } from './transport-errors';
import { createLogger } from './log';
import { truncateForLog } from './truncate';

const log = createLogger('forward');

// Max buffer size per SSE event before we abort (prevents unbounded memory
// from a misbehaving upstream).
export const MAX_SSE_BUFFER = 1_048_576; // 1MB

// --- Types ---

interface ForwardHeaders {
    [key: string]: string | string[] | undefined;
}
interface ForwardResult {
    success: boolean;
    status?: number;
    headers?: ForwardHeaders;
    body?: Buffer;
    stream?: Transform;
    streamUsage?: { prompt_tokens: number; completion_tokens: number } | null;
    error?: string;
    rawBody?: string | null;
    transportError?: boolean;
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
    timeoutMs = timeoutMs || 15000;

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
            resolve({ ok: false, reason: 'error', message: 'stream error during peek' });
        };

        proxyRes.on('readable', onReadable);
        proxyRes.once('error', onError);
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
    agent?: unknown;
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
    return new Promise((resolve) => {
        let streamUsage: { prompt_tokens: number; completion_tokens: number } | null = null;
        const proxy = transport.request(options, (proxyRes: NodeJS.ReadableStream & { statusCode?: number; headers: Record<string, string | string[] | undefined> }) => {
            if (proxyRes.statusCode && proxyRes.statusCode >= 400) {
                const errChunks: Buffer[] = [];
                let errSize = 0;
                proxyRes.on('data', (c: Buffer) => { errSize += c.length; if (errSize <= 10000) errChunks.push(c); });
                proxyRes.on('end', () => {
                    const errBody = Buffer.concat(errChunks).toString();
                    return resolve({
                        success: false,
                        status: proxyRes.statusCode,
                        error: 'HTTP ' + proxyRes.statusCode,
                        rawBody: errBody || null,
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
                peekFirstChunk(proxyRes).then(peek => {
                    if (!peek.ok) {
                        (proxy as NodeJS.WritableStream & { destroy(): void }).destroy();
                        return resolve({ success: false, error: 'Stream peek: ' + peek.reason });
                    }
                    const outHeaders = sseHeaders(buildSafeHeaders(proxyRes.headers as Record<string, string | string[] | undefined>));
                    if (!outHeaders['content-type']) {
                        outHeaders['content-type'] = (proxyRes.headers['content-type'] as string) || 'text/event-stream';
                    }
                    let outStream: NodeJS.ReadableStream = proxyRes;
                    if (streamTransformer) {
                        pipeline(outStream as NodeJS.ReadableStream, streamTransformer, (err: Error | null) => {
                            if (err) log.error(reqId, 'transformer pipeline error: ' + truncateForLog(err.message));
                        });
                        outStream = streamTransformer;
                    }
                    // Extract token usage from raw upstream SSE data.
                    let rawUsageBuf = '';
                    proxyRes.on('data', (chunk: Buffer | string) => {
                        rawUsageBuf += typeof chunk === 'string' ? chunk : chunk.toString();
                        const parts = rawUsageBuf.split('\n\n');
                        rawUsageBuf = parts.pop() || '';
                        for (const part of parts) {
                            const dataMatch = part.match(/^data: (.+)/m);
                            if (!dataMatch) continue;
                            const payload = dataMatch[1];
                            if (payload === '[DONE]') continue;
                            try {
                                const parsedPayload = JSON.parse(payload);
                                if (parsedPayload.usage) {
                                    const pt = parsedPayload.usage.prompt_tokens !== undefined ? parsedPayload.usage.prompt_tokens : parsedPayload.usage.input_tokens;
                                    const ct = parsedPayload.usage.completion_tokens !== undefined ? parsedPayload.usage.completion_tokens : parsedPayload.usage.output_tokens;
                                    if (pt !== undefined || ct !== undefined) {
                                        streamUsage = { prompt_tokens: pt || 0, completion_tokens: ct || 0 };
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
                                (outStream as NodeJS.ReadableStream & { destroy(err?: Error): void }).destroy(new Error('SSE event too large'));
                                return;
                            }
                        }
                        if (sseBuf.length > MAX_SSE_BUFFER) {
                            log.error(reqId, 'SSE event exceeded 1MB limit -- aborting stream');
                            (outStream as NodeJS.ReadableStream & { destroy(err?: Error): void }).destroy(new Error('SSE event too large'));
                        }
                    }
                    );

                    resolve({ success: true, status: proxyRes.statusCode, headers: outHeaders, stream: outStream as Transform, streamUsage });
                });
            } else {
                (proxyRes as unknown as NodeJS.ReadableStream & { setTimeout(ms: number, cb: () => void): void }).setTimeout(30000, () => {
                    (proxyRes as unknown as NodeJS.ReadableStream & { destroy(): void }).destroy();
                    resolve({ success: false, error: 'Response read timeout after 30s', transportError: true });
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
                                    const rc = extractReasoningContent(fullMessages as unknown as never[]);
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
                                const tc = extractThinkingBlocks(fullMessages as never[]);
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
                                    streamUsage = { prompt_tokens: pt || 0, completion_tokens: ct || 0 };
                                }
                            }
                        } catch (_) { /* non-fatal */ }
                        resolve({ success: true, status: proxyRes.statusCode, headers: outHeaders, body: responseBody, streamUsage });
                    }
                });
        }
        });

        (proxy as NodeJS.WritableStream & { on(event: string, cb: (...args: unknown[]) => void): NodeJS.WritableStream }).on('timeout', () => {
            (proxy as NodeJS.WritableStream & { destroy(): void }).destroy();
            resolve({ success: false, error: 'Upstream timeout after 60s', transportError: true });
        });

        (proxy as NodeJS.WritableStream & { on(event: string, cb: (...args: unknown[]) => void): NodeJS.WritableStream }).on('error', (err: Error) => {
            const label = describeTransportError(err);
            resolve({ success: false, error: label, transportError: true });
        });

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
