'use strict';

// Upstream forwarding with stream warmup, protocol translation, and
// fallback response headers.

import http from 'http';
import https from 'https';
import net from 'net';
import tls from 'tls';
import zlib from 'zlib';
import fs from 'fs';
import path from 'path';
import { pipeline, Transform } from 'stream';
import { buildSafeHeaders } from './util';
import { translateResponse } from './protocol-translate';
import { getTrustedModel } from './model-trust';
import { validateStreamEventConformance, validateResponseConformance } from './protocol-types';
import { extractThinkingBlocks, store } from './thinking-cache';
import type { Message as ThinkingMessage, MessageBlock } from './thinking-cache';
import { extractReasoningContent, store as storeReasoning } from './reasoning-cache';
import type { Message as ReasoningMessage } from './reasoning-cache';
import { describe as describeTransportError } from './transport-errors';
import { createLogger } from './log';
import { truncateForLog } from './truncate';
import { startStreamTimer, recordFirstToken, recordChunk } from './stream-metrics';
import type { StreamTimings, StreamMetrics } from './stream-metrics';

const log = createLogger('forward');

const upstreamAgent = new http.Agent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: 25 });

// --- Upstream proxy (Fiddler, mitmproxy, Charles, Burp Suite) ---
// Set DEEPCLAUDE_UPSTREAM_PROXY=http://127.0.0.1:8888 to route all upstream
// API calls through a debugging proxy.  Also reads ~/.deepclaude/upstream-proxy.flag
// (first line = proxy URL) so it can be toggled without restarting.
//
// HTTPS traffic uses HTTP CONNECT tunneling with a custom agent; HTTP traffic
// has its request path rewritten to the full upstream URL so the proxy forwards it.
//
// For Fiddler: export the root certificate (Tools → Options → HTTPS → Export)
// and set NODE_EXTRA_CA_CERTS=path/to/FiddlerRoot.pem so Node.js trusts it.

let _upstreamProxyUrl: string | null | undefined;
let _tunnelHttpsAgent: https.Agent | null = null;
let _tunnelHttpAgent: http.Agent | null = null;

function getUpstreamProxyUrl(): string | null {
  if (_upstreamProxyUrl !== undefined) return _upstreamProxyUrl;

  // 1. Env var
  const envUrl = process.env.DEEPCLAUDE_UPSTREAM_PROXY;
  if (envUrl) {
    _upstreamProxyUrl = envUrl.includes('://') ? envUrl : 'http://' + envUrl;
    log.info(null, 'Upstream proxy configured via DEEPCLAUDE_UPSTREAM_PROXY: ' + _upstreamProxyUrl);
    return _upstreamProxyUrl;
  }

  // 2. Flag file
  try {
    const flagPath = path.join(
      process.env.HOME || process.env.USERPROFILE || '.',
      '.deepclaude',
      'upstream-proxy.flag',
    );
    if (fs.existsSync(flagPath)) {
      const content = fs.readFileSync(flagPath, 'utf-8').trim();
      if (content) {
        _upstreamProxyUrl = content.includes('://') ? content : 'http://' + content;
        log.info(null, 'Upstream proxy configured via flag file: ' + _upstreamProxyUrl);
        return _upstreamProxyUrl;
      }
    }
  } catch (_) {
    /* flag file absent or unreadable */
  }

  _upstreamProxyUrl = null;
  return null;
}

function getUpstreamProxyAgents(): { httpAgent: http.Agent; httpsAgent: https.Agent } | null {
  const proxyUrl = getUpstreamProxyUrl();
  if (!proxyUrl) return null;

  if (_tunnelHttpAgent && _tunnelHttpsAgent) {
    return { httpAgent: _tunnelHttpAgent, httpsAgent: _tunnelHttpsAgent };
  }

  let u: { hostname: string; port: number };
  try {
    const parsed = new (require('url').URL)(proxyUrl);
    u = { hostname: parsed.hostname, port: parseInt(parsed.port) || 8888 };
  } catch {
    log.error(null, 'Invalid upstream proxy URL: ' + proxyUrl);
    _upstreamProxyUrl = null;
    return null;
  }

  // HTTPS: custom agent that establishes a CONNECT tunnel to the target
  // through the debugging proxy, then upgrades the tunneled socket to TLS.
  // This lets Fiddler/mitmproxy decrypt and inspect all upstream API calls.
  _tunnelHttpsAgent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 30000,
    maxSockets: 25,
  });
  (_tunnelHttpsAgent as unknown as Record<string, unknown>).createConnection = (
    opts: { hostname?: string; host?: string; servername?: string; port?: number },
    cb: (err: Error | null, socket?: net.Socket) => void,
  ): void => {
    const targetHost = opts.hostname || opts.host || opts.servername || 'unknown';
    const targetPort = opts.port || 443;

    const socket = net.connect({ host: u.hostname, port: u.port }, () => {
      socket.write(
        'CONNECT ' +
          targetHost +
          ':' +
          targetPort +
          ' HTTP/1.1\r\n' +
          'Host: ' +
          targetHost +
          ':' +
          targetPort +
          '\r\n' +
          'Proxy-Connection: Keep-Alive\r\n\r\n',
      );

      let buf = '';
      const onData = (chunk: Buffer): void => {
        buf += chunk.toString();
        if (buf.includes('\r\n\r\n')) {
          socket.removeListener('data', onData);
          const statusMatch = buf.match(/^HTTP\/\d\.\d\s+(\d+)/);
          const statusCode = statusMatch ? parseInt(statusMatch[1], 10) : 0;

          if (statusCode === 200) {
            // Tunnel established — upgrade to TLS so the HTTPS request
            // flows through the proxy as a transparent encrypted stream
            // that Fiddler/mitmproxy can decrypt and inspect.
            const rejectUnauthorized = process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0';
            const tlsOpts: tls.ConnectionOptions & { socket: net.Socket } = {
              socket,
              servername: targetHost,
              rejectUnauthorized,
            };
            // Trust the debugging proxy's root CA so Node.js accepts the
            // re-signed certificate Fiddler/mitmproxy presents.
            const proxyCa = getProxyCaCert();
            if (proxyCa) {
              tlsOpts.ca = proxyCa;
              if (typeof proxyCa === 'string') {
                log.info(null, 'Using upstream proxy CA cert (' + proxyCa.length + ' chars)');
              } else {
                log.info(null, 'Using upstream proxy CA cert (' + proxyCa.length + ' bytes)');
              }
            }
            const tlsSocket = tls.connect(tlsOpts, () =>
              cb(null, tlsSocket as unknown as net.Socket),
            );
            tlsSocket.on('error', (err: Error) => cb(err));
          } else {
            cb(
              new Error(
                'Upstream proxy CONNECT ' +
                  targetHost +
                  ':' +
                  targetPort +
                  ' failed: HTTP ' +
                  statusCode +
                  ' — is ' +
                  proxyUrl +
                  ' running?',
              ),
            );
          }
        }
      };
      socket.on('data', onData);
    });
    socket.on('error', (err: Error) => cb(err));
  };

  // HTTP: standard agent.  tryForward rewrites the request path to the
  // full upstream URL when an upstream proxy is active (see below).
  _tunnelHttpAgent = new http.Agent({
    keepAlive: true,
    keepAliveMsecs: 30000,
    maxSockets: 25,
  });

  log.info(null, 'Upstream proxy agents created for ' + proxyUrl);
  return { httpAgent: _tunnelHttpAgent, httpsAgent: _tunnelHttpsAgent };
}

// --- CA certificate loading for debugging proxies ---
// Fiddler, mitmproxy, Charles, and Burp Suite all use their own root CA
// to decrypt HTTPS.  Node.js must trust this CA to establish TLS through
// the CONNECT tunnel.  Two mechanisms, in priority order:
//   1. DEEPCLAUDE_UPSTREAM_PROXY_CA=path/to/cert.pem  (explicit path)
//   2. Auto-detect Fiddler cert on Windows: %USERPROFILE%\Documents\Fiddler2\FiddlerRoot.cer
// The cert is loaded once when the tunnel agent is first created.

let _proxyCaCert: string | Buffer | undefined;
let _proxyCaLoaded = false;

function getProxyCaCert(): string | Buffer | undefined {
  if (_proxyCaLoaded) return _proxyCaCert;
  _proxyCaLoaded = true;

  // 1. Explicit CA cert path
  const caPath = process.env.DEEPCLAUDE_UPSTREAM_PROXY_CA;
  if (caPath) {
    try {
      if (fs.existsSync(caPath)) {
        _proxyCaCert = fs.readFileSync(caPath);
        log.info(null, 'Upstream proxy CA loaded from ' + caPath);
        return _proxyCaCert;
      }
    } catch (e) {
      log.warn(
        null,
        'Failed to load upstream proxy CA from ' + caPath + ': ' + (e as Error).message,
      );
    }
  }

  // 2. Auto-detect Fiddler cert on Windows
  if (process.platform === 'win32') {
    const fiddlerCerts = [
      path.join(process.env.USERPROFILE || '', 'Documents', 'Fiddler2', 'FiddlerRoot.cer'),
      path.join(process.env.USERPROFILE || '', 'Documents', 'Fiddler2', 'FiddlerRoot.pem'),
      path.join(process.env.APPDATA || '', 'Fiddler', 'FiddlerRoot.cer'),
    ];
    for (const certPath of fiddlerCerts) {
      try {
        if (fs.existsSync(certPath)) {
          _proxyCaCert = fs.readFileSync(certPath);
          log.info(null, 'Auto-detected Fiddler root CA at ' + certPath);
          return _proxyCaCert;
        }
      } catch (_) {
        /* no cert at this path */
      }
    }
  }

  // 3. Common mitmproxy locations
  const mitmproxyCerts = [
    path.join(
      process.env.HOME || process.env.USERPROFILE || '',
      '.mitmproxy',
      'mitmproxy-ca-cert.pem',
    ),
  ];
  for (const certPath of mitmproxyCerts) {
    try {
      if (fs.existsSync(certPath)) {
        _proxyCaCert = fs.readFileSync(certPath);
        log.info(null, 'Auto-detected mitmproxy root CA at ' + certPath);
        return _proxyCaCert;
      }
    } catch (_) {
      /* no cert at this path */
    }
  }

  return _proxyCaCert;
}

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
// Increased to 30s (from 15s) for DeepSeek extended thinking, which can take
// >15s before emitting the first SSE byte. Configurable via env var.
export const FIRST_BYTE_TIMEOUT_MS =
  parseInt(process.env.DEEPCLAUDE_FIRST_BYTE_TIMEOUT_MS || '', 10) || 30_000;

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
  const defaultHeartbeat =
    parseInt(process.env.DEEPCLAUDE_STREAM_HEARTBEAT_MS || '', 10) || STREAM_HEARTBEAT_MS;
  const defaultDeadline = parseInt(process.env.DEEPCLAUDE_STREAM_DEADLINE_MS || '', 10) || 300_000;
  const defaultFirstByte = FIRST_BYTE_TIMEOUT_MS;
  const subagentHeartbeat =
    parseInt(process.env.DEEPCLAUDE_SUBAGENT_STREAM_HEARTBEAT_MS || '', 10) || 90_000;
  const subagentDeadline =
    parseInt(process.env.DEEPCLAUDE_SUBAGENT_STREAM_DEADLINE_MS || '', 10) || 90_000;
  const subagentFirstByte =
    parseInt(process.env.DEEPCLAUDE_SUBAGENT_FIRST_BYTE_TIMEOUT_MS || '', 10) || 15_000;
  if (slot === 'subagent') {
    return {
      firstByte: subagentFirstByte,
      heartbeat: subagentHeartbeat,
      deadline: subagentDeadline, // 90s default — matches start-proxy subagent request deadline
      bodyRead: 20_000, // 20s — subagent responses are small (tool results)
    };
  }
  return {
    firstByte: defaultFirstByte,
    heartbeat: defaultHeartbeat,
    deadline: defaultDeadline,
    bodyRead: 30_000, // 30s — default body read timeout
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
  streamUsage?: {
    prompt_tokens: number;
    completion_tokens: number;
    cache_hit_tokens: number;
    cache_miss_tokens: number;
  } | null;
  error?: string;
  rawBody?: string | null;
  _upstream?: NodeJS.WritableStream; // For cleanup on client disconnect
  transportError?: boolean;
  qualityFailure?: boolean;
  qualityReason?: string;
  deadStream?: boolean;
  deadStreamReason?: string;
  streamTimings?: StreamTimings;
  streamMetrics?: StreamMetrics;
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
  return Object.assign(
    {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
    extra || {},
  );
}
// --- Stream warmup: peek first SSE chunk before committing headers ---
// Returns { ok: true, firstChunk } on success, { ok: false, reason } on failure.
// This prevents committing to a provider that returns 200 but never sends data.

export function peekFirstChunk(
  proxyRes: NodeJS.ReadableStream,
  timeoutMs?: number,
): Promise<PeekResult> {
  timeoutMs = timeoutMs || FIRST_BYTE_TIMEOUT_MS;

  return new Promise((resolve) => {
    const contentType =
      (proxyRes as unknown as { headers: Record<string, string | string[] | undefined> }).headers[
        'content-type'
      ] || '';
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

// Shared interface for request options passed to http.request() / https.request().
// Fields match Node.js http.RequestOptions and are broad enough that callers
// don't need `as any` casts on the transport or options parameters.
export interface TryForwardOptions extends http.RequestOptions {
  hostname: string;
  port: number | string;
  path: string;
  method: string;
  headers: Record<string, string | string[] | undefined>;
  timeout: number;
  agent?: http.Agent | boolean;
}
export function tryForward(
  transport: Pick<typeof import('http'), 'request'>,
  options: TryForwardOptions,
  forwardedBody: string,
  streamTransformer: Transform | null,
  isOpenAI: boolean,
  parsed: Record<string, unknown> | null | undefined,
  model: string | null | undefined,
  reqId: string | number | null | undefined,
): Promise<ForwardResult> {
  // Extract slot for timeout differentiation — subagent requests get tighter limits.
  const slot = model ? (model.match(/^(sonnet|opus|haiku|subagent|fable):/) || [null])[1] : null;
  const to = getStreamTimeouts(slot);

  return new Promise((resolve) => {
    const streamUsage: {
      prompt_tokens: number;
      completion_tokens: number;
      cache_hit_tokens: number;
      cache_miss_tokens: number;
    } = { prompt_tokens: 0, completion_tokens: 0, cache_hit_tokens: 0, cache_miss_tokens: 0 };
    let timings: StreamTimings | null = null;
    let responseStarted = false;
    let firstByteTimer: ReturnType<typeof setTimeout> | null = null;
    // Upstream proxy (Fiddler/mitmproxy/Charles) — when configured, route
    // all upstream API calls through the debugging proxy so the operator can
    // inspect request/response bodies in real time.
    const tunnelAgents = getUpstreamProxyAgents();
    const isHttpsTarget = (transport as unknown) === (https as unknown);
    let effectiveOptions = { ...options };
    let effectiveAgent = options.agent ?? (isHttpsTarget ? undefined : upstreamAgent);

    if (tunnelAgents) {
      if (isHttpsTarget) {
        // HTTPS: use the CONNECT-tunneling agent — everything else
        // (hostname, path, headers) stays the same; the tunnel agent
        // establishes a CONNECT to the target through the proxy, then
        // upgrades to TLS.  Fiddler/mitmproxy decrypts and inspects.
        effectiveAgent = tunnelAgents.httpsAgent;
      } else {
        // HTTP: rewrite the request so it goes THROUGH the proxy rather
        // than directly to the upstream.  The proxy expects:
        //   GET http://upstream-host:port/path HTTP/1.1
        //   Host: upstream-host:port
        const proxyUrl = getUpstreamProxyUrl()!;
        const pu = new (require('url').URL)(proxyUrl);
        const origHostname = effectiveOptions.hostname || 'localhost';
        const origPort = effectiveOptions.port || 80;
        const origPath = effectiveOptions.path || '/';
        const fullUrl = 'http://' + origHostname + ':' + origPort + origPath;
        effectiveOptions = {
          ...effectiveOptions,
          hostname: pu.hostname,
          port: parseInt(pu.port) || 8888,
          path: fullUrl,
        };
        effectiveOptions.headers = {
          ...(effectiveOptions.headers as Record<string, string>),
          Host: origHostname + ':' + origPort,
        };
        effectiveAgent = tunnelAgents.httpAgent;
      }
    }

    const proxy = transport.request(
      { ...effectiveOptions, agent: effectiveAgent },
      (
        proxyRes: NodeJS.ReadableStream & {
          statusCode?: number;
          headers: Record<string, string | string[] | undefined>;
        },
      ) => {
        responseStarted = true;
        if (firstByteTimer !== null) clearTimeout(firstByteTimer);
        if (proxyRes.statusCode && proxyRes.statusCode >= 400) {
          const errChunks: Buffer[] = [];
          let errSize = 0;
          proxyRes.on('data', (c: Buffer) => {
            errSize += c.length;
            if (errSize <= 10000) errChunks.push(c);
          });
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
            if (
              proxyRes.statusCode === 413 ||
              lowerBody.includes('max_tokens') ||
              lowerBody.includes('too large') ||
              lowerBody.includes('too long') ||
              lowerBody.includes('output token') ||
              lowerBody.includes('context length') ||
              lowerBody.includes('token limit') ||
              lowerBody.includes('maximum context') ||
              lowerBody.includes('reduce the length') ||
              lowerBody.includes('request too large')
            ) {
              qualityFailure = true;
              qualityReason =
                'Upstream rejected request as too large (HTTP ' +
                proxyRes.statusCode +
                ')' +
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
          peekFirstChunk(proxyRes, to.firstByte).then((peek) => {
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
                  (
                    proxyRes as unknown as NodeJS.ReadableStream & { destroy(err?: Error): void }
                  ).destroy(err);
                });
                sourceStream = gunzip;
                log.info(reqId, 'Decompressing gzip-encoded streaming response');
              } catch (err) {
                log.error(
                  reqId,
                  'Failed to create gunzip: ' + truncateForLog((err as Error).message),
                );
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
              if (streamHeartbeat) {
                clearTimeout(streamHeartbeat);
                streamHeartbeat = null;
              }
              if (streamDeadline) {
                clearTimeout(streamDeadline);
                streamDeadline = null;
              }
            };
            // Heartbeat: reset on every data chunk to detect silent stalls.
            const resetHeartbeat = () => {
              if (streamHeartbeat) clearTimeout(streamHeartbeat);
              streamHeartbeat = setTimeout(() => {
                (
                  proxyRes as unknown as NodeJS.ReadableStream & { destroy(err?: Error): void }
                ).destroy(
                  new Error(
                    'Upstream stream read timeout (heartbeat) after ' +
                      to.heartbeat / 1000 +
                      's, received ' +
                      streamBytes +
                      ' bytes',
                  ),
                );
              }, to.heartbeat);
              if (streamHeartbeat && typeof streamHeartbeat === 'object')
                (streamHeartbeat as NodeJS.Timeout).unref();
            };
            // Deadline: set ONCE at stream start, never reset.  This is a hard
            // wall-clock cap on total streaming duration — unlike the heartbeat,
            // it is not extended by new data.
            const startStreamDeadline = () => {
              if (streamDeadline) clearTimeout(streamDeadline);
              streamDeadline = setTimeout(() => {
                (
                  proxyRes as unknown as NodeJS.ReadableStream & { destroy(err?: Error): void }
                ).destroy(
                  new Error(
                    'Upstream stream read timeout (deadline) after ' +
                      to.deadline / 1000 +
                      's, received ' +
                      streamBytes +
                      ' bytes',
                  ),
                );
              }, to.deadline);
              if (streamDeadline && typeof streamDeadline === 'object')
                (streamDeadline as NodeJS.Timeout).unref();
            };
            resetHeartbeat();
            startStreamDeadline();
            sourceStream.on('data', (chunk: Buffer | string) => {
              streamBytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
              if (streamBytes > MAX_TOTAL_STREAM_BYTES) {
                cancelStreamTimeouts();
                (
                  proxyRes as unknown as NodeJS.ReadableStream & { destroy(err?: Error): void }
                ).destroy(new Error('Stream response exceeds max size: ' + streamBytes + ' bytes'));
                return;
              }
              resetHeartbeat();
            });
            sourceStream.once('end', () => {
              streamEndedNormally = true;
              cancelStreamTimeouts();

              // Flush any remaining partial SSE event in the usage buffer
              // (the last received chunk may not end with \n\n).
              if (rawUsageBuf.trim()) {
                const dataLines = [...rawUsageBuf.matchAll(/^data: ?(.*)$/gm)];
                if (dataLines.length) {
                  const payload = dataLines.map((m) => m[1]).join('\n');
                  extractStreamUsage(payload, streamUsage);
                  // Final content_block_stop if pending (parsed separately for blocks)
                  try {
                    if (payload !== '[DONE]') {
                      const parsedFinal = JSON.parse(payload);
                      if (parsedFinal.type === 'content_block_stop') pushAccumulatedBlock();
                    }
                  } catch (_) {
                    /* non-fatal */
                  }
                }
              }

              // For Anthropic-format providers: extract thinking blocks from
              // the accumulated streaming response and cache them for the next
              // turn's injectThinkingBlocks call in start-proxy.ts. This is
              // the streaming equivalent of the non-streaming path at line ~530.
              if (!isOpenAI && accumulatedBlocks.length > 0 && parsed && parsed.messages) {
                try {
                  const responseMsg = { role: 'assistant', content: accumulatedBlocks };
                  const fullMessages = [
                    ...(parsed.messages as Array<Record<string, unknown>>),
                    responseMsg,
                  ];
                  const tc = extractThinkingBlocks(fullMessages as ThinkingMessage[]);
                  if (tc) {
                    store(tc.sk, tc.firstToolUseId, tc.blocks);
                  }
                } catch (e) {
                  log.error(
                    reqId,
                    'streaming thinking extraction error: ' + truncateForLog((e as Error).message),
                  );
                }
              }
            });
            sourceStream.once('error', cancelStreamTimeouts);
            sourceStream.once('close', () => {
              cancelStreamTimeouts();
              // All SSE events have been processed (end handler fires before close).
              // Mark streamUsage as complete so callers know cache tokens are populated.
              (streamUsage as Record<string, unknown>)._complete = true;
              if (streamEndedNormally) {
                log.info(reqId, 'Stream completed normally, total bytes received: ' + streamBytes);
              } else {
                // Abnormal stream termination (gzip failure, timeout, etc.).
                // The 'end' handler never ran, so thinking blocks were not cached.
                // Try to extract from whatever was accumulated so the client's
                // retry can hit the DeepSeek cache instead of paying full miss cost.
                if (!isOpenAI && accumulatedBlocks.length > 0 && parsed && parsed.messages) {
                  try {
                    const responseMsg = { role: 'assistant', content: accumulatedBlocks };
                    const fullMessages = [
                      ...(parsed.messages as Array<Record<string, unknown>>),
                      responseMsg,
                    ];
                    const tc = extractThinkingBlocks(fullMessages as ThinkingMessage[]);
                    if (tc) {
                      store(tc.sk, tc.firstToolUseId, tc.blocks);
                      log.info(
                        reqId,
                        'cached thinking blocks on abnormal stream close (' +
                          accumulatedBlocks.length +
                          ' blocks)',
                      );
                    }
                  } catch (_e) {
                    // non-fatal — best-effort fallback cache
                  }
                }
              }
            });

            const outHeaders = sseHeaders(
              buildSafeHeaders(proxyRes.headers as Record<string, string | string[] | undefined>),
            );
            if (!outHeaders['content-type']) {
              outHeaders['content-type'] =
                (proxyRes.headers['content-type'] as string) || 'text/event-stream';
            }
            let outStream: NodeJS.ReadableStream = sourceStream;
            if (streamTransformer) {
              pipeline(
                outStream as NodeJS.ReadableStream,
                streamTransformer,
                (err: Error | null) => {
                  if (err)
                    log.error(reqId, 'transformer pipeline error: ' + truncateForLog(err.message));
                },
              );
              outStream = streamTransformer;
            }
            // Extract token usage from raw upstream SSE data.
            let rawUsageBuf = '';
            // For Anthropic-format providers: accumulate response content blocks
            // from SSE events so we can extract & cache thinking blocks for
            // multi-turn tool conversations. The non-streaming path does this in
            // one shot below; the streaming path must reconstruct the blocks.
            const accumulatedBlocks: MessageBlock[] = [];
            interface BlockAccumulator {
              type: string;
              thinking?: string;
              signature?: string;
              text?: string;
              id?: unknown;
              name?: unknown;
              input?: Record<string, unknown>;
              _partialInput?: string;
            }
            let blockAccumulator: BlockAccumulator | null = null;
            function pushAccumulatedBlock(): void {
              if (!blockAccumulator) return;
              // Parse accumulated input JSON for tool_use blocks
              if (blockAccumulator.type === 'tool_use' && blockAccumulator._partialInput) {
                try {
                  blockAccumulator.input = JSON.parse(blockAccumulator._partialInput);
                } catch (_) {
                  /* best-effort */
                }
                delete blockAccumulator._partialInput;
              }
              accumulatedBlocks.push(blockAccumulator as MessageBlock);
              blockAccumulator = null;
            }
            sourceStream.on('data', (chunk: Buffer | string) => {
              if (timings) {
                recordFirstToken(timings);
                recordChunk(timings);
              }
              rawUsageBuf += typeof chunk === 'string' ? chunk : chunk.toString();
              if (rawUsageBuf.length > MAX_SSE_BUFFER) {
                log.warn(
                  reqId,
                  'usage buffer exceeded 1MB — discarding accumulated SSE data to prevent unbounded memory growth (possible upstream stream missing SSE delimiters)',
                );
                // Before discarding, extract usage from the complete events
                // that will be dropped. The final usage event (token counts)
                // is typically at the end of the stream — losing it means
                // zeroed cost tracking. Also reset content block accumulator
                // since the malformed stream invalidates block reconstruction.
                const lastSplit = rawUsageBuf.lastIndexOf('\n\n');
                if (lastSplit >= 0) {
                  const completeEvents = rawUsageBuf.slice(0, lastSplit);
                  for (const event of completeEvents.split('\n\n')) {
                    if (!event.trim()) continue;
                    const dataLines = [...event.matchAll(/^data: ?(.*)$/gm)];
                    if (!dataLines.length) continue;
                    const payload = dataLines.map((m) => m[1]).join('\n');
                    if (payload === '[DONE]') continue;
                    extractStreamUsage(payload, streamUsage);
                  }
                  rawUsageBuf = rawUsageBuf.slice(lastSplit + 2);
                } else {
                  rawUsageBuf = '';
                }
                // Reset block accumulator — we can't trust partial block state
                pushAccumulatedBlock();
                blockAccumulator = null;
                return;
              }
              const parts = rawUsageBuf.split('\n\n');
              rawUsageBuf = parts.pop() || '';
              for (const part of parts) {
                const dataLines = [...part.matchAll(/^data: ?(.*)$/gm)];
                if (!dataLines.length) continue;
                const payload = dataLines.map((m) => m[1]).join('\n');
                if (payload === '[DONE]') continue;
                extractStreamUsage(payload, streamUsage);

                // --- Accumulate content blocks for thinking cache ---
                // For Anthropic-format providers, reconstruct the response
                // content blocks from SSE events so thinking blocks can be
                // extracted and cached for multi-turn tool conversations.
                // This mirrors what the non-streaming path does with the
                // already-parsed response body.
                if (!isOpenAI && parsed && parsed.messages) {
                  // Parse the SSE payload once for content-block reconstruction.
                  // parsedPayload was a ReferenceError before the fix — JSON.parse
                  // is required to turn the raw SSE data into a usable object.
                  let parsedPayload: Record<string, unknown> | null = null;
                  try {
                    parsedPayload = JSON.parse(payload) as Record<string, unknown>;
                  } catch {
                    continue;
                  }
                  // Runtime protocol conformance: detect new Anthropic SSE types
                  if (typeof parsedPayload.type === 'string') {
                    const conf = validateStreamEventConformance(parsedPayload.type, parsedPayload);
                    if (!conf.valid) {
                      log.warn(reqId, 'STREAM_PROTOCOL_GAP: ' + JSON.stringify(conf));
                    }
                  }
                  // Accumulate content blocks from SSE content_block_* events for
                  // thinking-block extraction at stream end.
                  try {
                    if (
                      parsedPayload.type === 'content_block_start' &&
                      parsedPayload.content_block
                    ) {
                      pushAccumulatedBlock();
                      const cb = parsedPayload.content_block as Record<string, unknown>;
                      blockAccumulator = { type: cb.type };
                      if (cb.type === 'thinking') {
                        blockAccumulator.thinking = (cb.thinking as string) || '';
                        blockAccumulator.signature = (cb.signature as string) || '';
                      } else if (cb.type === 'text') {
                        blockAccumulator.text = (cb.text as string) || '';
                      } else if (cb.type === 'tool_use' || cb.type === 'server_tool_use') {
                        blockAccumulator.id = cb.id;
                        blockAccumulator.name = cb.name;
                        blockAccumulator.input = cb.input || {};
                      } else if (cb.type === 'search_result') {
                        blockAccumulator.source = cb.source;
                        blockAccumulator.title = cb.title;
                        blockAccumulator._contentBlocks = [];
                      } else if (cb.type === 'compaction') {
                        blockAccumulator.content = (cb.content as string) || '';
                        blockAccumulator.encrypted_content = (cb.encrypted_content as string) || '';
                      } else if (
                        cb.type === 'fallback' ||
                        cb.type === 'mid_conv_system' ||
                        cb.type === 'web_search_tool_result' ||
                        cb.type === 'web_fetch_tool_result'
                      ) {
                        // Pass-through block types (no accumulation needed for thinking cache).
                        // fallback marks provider transitions. mid_conv_system carries system
                        // instructions. web_*_tool_result blocks are response-only metadata.
                      } else {
                        // Unrecognized content block type — log so operators
                        // know when Anthropic adds a new block type.
                        log.warn(
                          reqId,
                          'Unrecognized content block type in SSE stream: ' + (cb.type as string),
                        );
                      }
                    } else if (
                      parsedPayload.type === 'content_block_delta' &&
                      parsedPayload.delta &&
                      blockAccumulator
                    ) {
                      const delta = parsedPayload.delta as Record<string, unknown>;
                      if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
                        blockAccumulator.thinking =
                          ((blockAccumulator.thinking as string) || '') + delta.thinking;
                        if (typeof delta.estimated_tokens === 'number') {
                          blockAccumulator._estimatedTokens = delta.estimated_tokens;
                        }
                      } else if (
                        delta.type === 'signature_delta' &&
                        typeof delta.signature === 'string'
                      ) {
                        blockAccumulator.signature = delta.signature;
                      } else if (delta.type === 'text_delta' && typeof delta.text === 'string') {
                        blockAccumulator.text =
                          ((blockAccumulator.text as string) || '') + delta.text;
                      } else if (
                        delta.type === 'input_json_delta' &&
                        typeof delta.partial_json === 'string'
                      ) {
                        blockAccumulator._partialInput =
                          (blockAccumulator._partialInput || '') + delta.partial_json;
                      } else if (delta.type === 'compaction_delta') {
                        if (typeof delta.content === 'string') {
                          blockAccumulator.content =
                            ((blockAccumulator.content as string) || '') + delta.content;
                        }
                        if (typeof delta.encrypted_content === 'string') {
                          blockAccumulator.encrypted_content = delta.encrypted_content;
                        }
                      } else if (delta.type === 'citations_delta') {
                        // Citations land as full objects (not incremental), so store them.
                        (blockAccumulator._citations = blockAccumulator._citations || []).push(
                          delta.citation,
                        );
                      }
                    } else if (parsedPayload.type === 'content_block_stop') {
                      pushAccumulatedBlock();
                    }
                  } catch (_) {
                    /* non-fatal — reconstruction shouldn't break the stream */
                  }
                }
              }
            });

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
                  s.destroy(new Error('SSE event too large'));
                  return;
                }
              }
              if (sseBuf.length > MAX_SSE_BUFFER) {
                log.error(reqId, 'SSE event exceeded 1MB limit -- aborting stream');
                const s = outStream as NodeJS.ReadableStream & { destroy(err?: Error): void };
                s.destroy(new Error('SSE event too large'));
                return;
              }
            });

            resolve({
              success: true,
              status: proxyRes.statusCode,
              headers: outHeaders,
              stream: outStream,
              streamUsage,
              streamTimings: timings || undefined,
              _upstream: proxy,
            });
          });
        } else {
          (
            proxyRes as unknown as NodeJS.ReadableStream & {
              setTimeout(ms: number, cb: () => void): void;
            }
          ).setTimeout(to.bodyRead, () => {
            (proxyRes as unknown as NodeJS.ReadableStream & { destroy(): void }).destroy();
            resolve({
              success: false,
              error: 'Response read timeout after ' + to.bodyRead / 1000 + 's',
              transportError: true,
            });
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
            const originalBodyBuf = responseBody; // Keep before decompression for usage extraction
            // Decompress gzip-encoded responses if upstream ignored accept-encoding
            if (
              typeof proxyRes.headers['content-encoding'] === 'string' &&
              proxyRes.headers['content-encoding'].includes('gzip')
            ) {
              try {
                responseBody = zlib.gunzipSync(responseBody);
              } catch (_) {
                /* decompression failure — fall through to existing error handling */
              }
            }
            // Parse response once to avoid redundant JSON.parse blocking the event loop
            let parsedResponse: Record<string, unknown> | null = null;
            try {
              parsedResponse = JSON.parse(responseBody.toString());
            } catch (_) {
              /* defer to translation error handling */
            }
            let translationFailed = false;
            if (isOpenAI) {
              if (!parsedResponse) {
                log.error(reqId, 'response translation error: Failed to parse upstream response');
                translationFailed = true;
              } else {
                const openaiResp = parsedResponse;

                // Extract reasoning content from OpenAI response before translation
                try {
                  const responseMsg = openaiResp.choices?.[0]?.message;
                  if (
                    responseMsg &&
                    responseMsg.reasoning_content &&
                    responseMsg.tool_calls &&
                    responseMsg.tool_calls.length > 0 &&
                    parsed &&
                    parsed.messages
                  ) {
                    const fullMessages = [
                      ...(parsed.messages as Array<Record<string, unknown>>),
                      {
                        role: 'assistant',
                        content: responseMsg.content,
                        tool_calls: responseMsg.tool_calls,
                        reasoning_content: responseMsg.reasoning_content,
                      },
                    ];
                    const rc = extractReasoningContent(fullMessages as ReasoningMessage[]);
                    if (rc)
                      storeReasoning(
                        rc.sk,
                        rc.firstToolCallId,
                        rc.reasoningContent,
                        fullMessages.length,
                      );
                  }
                } catch (_) {
                  /* non-fatal */
                }
                const anthropicResp = translateResponse(openaiResp, model || '');
                responseBody = Buffer.from(JSON.stringify(anthropicResp));
              }
            } else {
              if (!parsedResponse) {
                log.error(reqId, 'thinking extraction error: Failed to parse upstream response');
              } else {
                const resp = parsedResponse;
                let respModified = false;

                // Runtime non-streaming conformance: detect new response fields
                {
                  const conf = validateResponseConformance(resp);
                  if (!conf.valid) {
                    log.warn(reqId, 'RESPONSE_PROTOCOL_GAP: ' + JSON.stringify(conf));
                  }
                }

                // Extract and cache thinking blocks
                if (resp.content && Array.isArray(resp.content)) {
                  const responseMsg = { role: 'assistant', content: resp.content };
                  const fullMessages =
                    parsed && parsed.messages
                      ? [...(parsed.messages as Array<Record<string, unknown>>), responseMsg]
                      : [responseMsg];
                  const tc = extractThinkingBlocks(fullMessages as ThinkingMessage[]);
                  if (tc) {
                    store(tc.sk, tc.firstToolUseId, tc.blocks);
                    resp.content = resp.content.filter(
                      (b: { type: string }) =>
                        b.type !== 'thinking' && b.type !== 'redacted_thinking',
                    );
                    respModified = true;
                  }
                }

                // Inject server_tool_use count for "Did N searches" display.
                // Claude Code reads usage.server_tool_use from the response to set
                // searchCount in toolUseResult. Without this the display shows 0.
                if (resp.content && Array.isArray(resp.content)) {
                  let ws = 0,
                    wf = 0;
                  for (const block of resp.content as Array<{ type: string; name?: string }>) {
                    if (block.type === 'tool_use') {
                      if (block.name === 'web_search') ws++;
                      else if (block.name === 'web_fetch') wf++;
                    }
                  }
                  if (ws > 0 || wf > 0) {
                    if (!resp.usage) resp.usage = {};
                    // Only inject server_tool_use if the upstream provider
                    // didn't include it. Anthropic returns it natively;
                    // other providers don't. Prefer upstream.
                    if (!(resp.usage as Record<string, unknown>).server_tool_use) {
                      (resp.usage as Record<string, unknown>).server_tool_use = {
                        web_search_requests: ws,
                        web_fetch_requests: wf,
                      };
                      // Rewrite response model so CC trusts server_tool_use.
                      // CC only reads server_tool_use from Claude models.
                      // getTrustedModel maps ANY CC model (including slot
                      // overrides like haiku:deepseek-v4-flash) to a claude-*
                      // name that CC trusts.
                      const upstreamModel = (resp as Record<string, unknown>).model;
                      const trustModel = getTrustedModel(
                        (parsed && typeof (parsed as Record<string, unknown>).model === 'string'
                          ? ((parsed as Record<string, unknown>).model as string)
                          : null) ||
                          model ||
                          null,
                      );
                      if (
                        trustModel &&
                        upstreamModel &&
                        typeof upstreamModel === 'string' &&
                        !upstreamModel.startsWith('claude-')
                      ) {
                        (resp as Record<string, unknown>).model = trustModel;
                      }
                    }
                    respModified = true;
                  }
                }

                if (respModified) {
                  responseBody = Buffer.from(JSON.stringify(resp));
                }
              }
            }
            const outHeaders = buildSafeHeaders(
              proxyRes.headers as Record<string, string | string[] | undefined>,
              { 'content-length': String(responseBody.length) },
            );
            if (translationFailed) {
              resolve({ success: false, status: 502, error: 'Protocol translation failed' });
            } else {
              // Extract usage from original response body for non-streaming requests
              try {
                const originalText = originalBodyBuf.toString();
                const original = JSON.parse(originalText);
                if (original.usage) {
                  const pt =
                    original.usage.prompt_tokens !== undefined
                      ? original.usage.prompt_tokens
                      : original.usage.input_tokens;
                  const ct =
                    original.usage.completion_tokens !== undefined
                      ? original.usage.completion_tokens
                      : original.usage.output_tokens;
                  if (pt !== undefined || ct !== undefined) {
                    streamUsage.prompt_tokens = pt || 0;
                    streamUsage.completion_tokens = ct || 0;
                  }
                  // Cache tokens: support both OpenAI and Anthropic field names
                  if (typeof original.usage.prompt_cache_hit_tokens === 'number') {
                    streamUsage.cache_hit_tokens = original.usage.prompt_cache_hit_tokens;
                    streamUsage.cache_miss_tokens =
                      (original.usage.prompt_cache_miss_tokens as number) || 0;
                  } else if (typeof original.usage.cache_read_input_tokens === 'number') {
                    streamUsage.cache_hit_tokens = original.usage.cache_read_input_tokens;
                    streamUsage.cache_miss_tokens =
                      (original.usage.cache_creation_input_tokens as number) || 0;
                  }
                }
              } catch (_) {
                /* non-fatal */
              }
              // Quality checks on non-streaming response — reuse parsed objects
              let qualityReason = '';
              if (!qualityReason && streamUsage && streamUsage.completion_tokens > 0) {
                try {
                  const reqBody = JSON.parse(forwardedBody);
                  if (typeof reqBody.max_tokens === 'number') {
                    const limit = reqBody.max_tokens * 2;
                    if (streamUsage.completion_tokens > limit) {
                      qualityReason =
                        'Completion tokens (' +
                        streamUsage.completion_tokens +
                        ') exceed max_tokens limit (' +
                        reqBody.max_tokens +
                        ')';
                    }
                  }
                } catch (_) {
                  /* non-fatal */
                }
              }
              if (!qualityReason) {
                const bodyStr = responseBody.toString().trim();
                if (bodyStr.length === 0) {
                  qualityReason = 'Response body is empty';
                }
              }
              if (!qualityReason) {
                if (
                  parsedResponse &&
                  parsedResponse.content &&
                  Array.isArray(parsedResponse.content) &&
                  parsedResponse.content.length === 0
                ) {
                  qualityReason = 'Response contains no content';
                }
              }
              if (!qualityReason) {
                if (!parsedResponse) {
                  qualityReason = 'Response body is not valid JSON';
                }
              }
              if (qualityReason) {
                resolve({
                  success: false,
                  status: proxyRes.statusCode,
                  headers: outHeaders,
                  body: responseBody,
                  streamUsage,
                  error: qualityReason,
                  qualityFailure: true,
                  qualityReason,
                  streamMetrics: undefined,
                });
              } else {
                resolve({
                  success: true,
                  status: proxyRes.statusCode,
                  headers: outHeaders,
                  body: responseBody,
                  streamUsage,
                  streamMetrics: undefined,
                  _upstream: proxy,
                });
              }
            }
          });
        }
      },
    );

    (
      proxy as NodeJS.WritableStream & {
        on(event: string, cb: (...args: unknown[]) => void): NodeJS.WritableStream;
      }
    ).on('timeout', () => {
      if (firstByteTimer !== null) clearTimeout(firstByteTimer);
      (proxy as NodeJS.WritableStream & { destroy(): void }).destroy();
      resolve({ success: false, error: 'Upstream timeout after 60s', transportError: true });
    });

    (
      proxy as NodeJS.WritableStream & {
        on(event: string, cb: (...args: unknown[]) => void): NodeJS.WritableStream;
      }
    ).on('error', (err: Error) => {
      if (firstByteTimer !== null) clearTimeout(firstByteTimer);
      const label = describeTransportError(err);
      resolve({ success: false, error: label, transportError: true });
    });

    // If the upstream accepts the connection but never sends a response
    // within the slot's first-byte window, treat it as a dead stream.
    firstByteTimer = setTimeout(() => {
      if (responseStarted) return;
      (proxy as NodeJS.WritableStream & { destroy(): void }).destroy();
      resolve({
        success: false,
        error: 'No response within ' + to.firstByte / 1000 + 's',
        transportError: true,
        deadStream: true,
        deadStreamReason: 'first_byte_timeout',
      });
    }, to.firstByte);

    timings = startStreamTimer();
    proxy.write(forwardedBody);
    proxy.end();
  });
}
// --- Fallback response headers ---
// Annotate a working response with fallback metadata so clients can see
// what happened when the primary provider failed.

export function addFallbackHeaders(
  headers: ForwardHeaders,
  meta?: FallbackMeta | null,
): ForwardHeaders {
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

// ── SSE usage extraction ────────────────────────────────────────────
// Parses a single SSE data payload (one complete event between \n\n
// delimiters) and updates streamUsage with any token counts found.
// Handles both OpenAI field names (prompt_cache_hit/miss) and Anthropic
// field names (cache_read/cache_creation_input_tokens).
// Exported for testing.

export interface StreamUsageAccumulator {
  prompt_tokens: number;
  completion_tokens: number;
  cache_hit_tokens: number;
  cache_miss_tokens: number;
}

export function extractStreamUsage(ssePayload: string, acc: StreamUsageAccumulator): void {
  if (!ssePayload || ssePayload === '[DONE]') return;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(ssePayload) as Record<string, unknown>;
  } catch {
    return;
  }
  const usage = parsed.usage as Record<string, unknown> | null | undefined;
  if (!usage) return;

  const pt =
    usage.prompt_tokens !== undefined
      ? (usage.prompt_tokens as number)
      : (usage.input_tokens as number);
  const ct =
    usage.completion_tokens !== undefined
      ? (usage.completion_tokens as number)
      : (usage.output_tokens as number);
  if (pt !== undefined || ct !== undefined) {
    acc.prompt_tokens = pt || 0;
    acc.completion_tokens = ct || 0;
  }

  if (typeof usage.prompt_cache_hit_tokens === 'number') {
    acc.cache_hit_tokens = usage.prompt_cache_hit_tokens as number;
    acc.cache_miss_tokens = (usage.prompt_cache_miss_tokens as number) || 0;
  } else if (typeof usage.cache_read_input_tokens === 'number') {
    acc.cache_hit_tokens = usage.cache_read_input_tokens as number;
    acc.cache_miss_tokens = (usage.cache_creation_input_tokens as number) || 0;
  }
}
