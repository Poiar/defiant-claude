'use strict';

// Response cache: intercept identical request bodies and replay cached SSE
// streams.  Claude Code sometimes retries tool calls with the exact same
// request body — this skips the upstream round-trip entirely.
//
// Cache scope:
//   - Keys are SHA-256 of the final forwarded body (after all stripping)
//   - Values are arrays of { event, data } objects captured from the SSE stream
//   - TTL: 60 seconds (short — only catches retry storms, not session restarts)
//   - Max entries: 256 (bounds memory; hit rate plateaus quickly)

import crypto from 'node:crypto';
import http from 'node:http';
import { Transform, TransformCallback } from 'node:stream';
import { LruCache } from './lru-cache';
import { createLogger } from './log';

const log = createLogger('response-cache');

const TTL_MS = 60_000; // 1 minute — catches retry bursts
const MAX_ENTRIES = 256;

interface CachedSSEEvent {
  event: string;
  data: string;
}

const cache = new LruCache<CachedSSEEvent[]>({
  ttlMs: TTL_MS,
  maxEntries: MAX_ENTRIES,
});

let hits = 0;
let misses = 0;

export function cacheStats(): { hits: number; misses: number; size: number } {
  return { hits, misses, size: cache.size };
}

export function resetCacheStats(): void {
  hits = 0;
  misses = 0;
}

/** SHA-256 of the forwarded body bytes. */
export function hashBody(body: Buffer): string {
  return crypto.createHash('sha256').update(body).digest('hex').slice(0, 32);
}

/** Check if a cached response exists for this hash. */
export function checkCache(hash: string): CachedSSEEvent[] | undefined {
  const entry = cache.get(hash);
  if (entry) {
    hits++;
    return entry;
  }
  misses++;
  return undefined;
}

/** Replay a cached SSE stream to the response. */
export function replayCachedStream(
  res: http.ServerResponse,
  events: CachedSSEEvent[],
  reqId: string | null,
): void {
  log.info(reqId, `replaying cached response (${events.length} events)`);
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    'x-response-cache': 'hit',
  });

  let i = 0;
  function writeNext(): void {
    if (i >= events.length || res.destroyed) {
      res.end();
      return;
    }
    const { event, data } = events[i];
    i++;
    const line = `event: ${event}\ndata: ${data}\n\n`;
    const canContinue = res.write(line);
    if (canContinue) {
      setImmediate(writeNext);
    } else {
      res.once('drain', () => setImmediate(writeNext));
    }
  }
  setImmediate(writeNext);
}

/**
 * Transform stream that collects SSE event-data pairs while passing data
 * through to the client response.  On stream end, stores the captured
 * events in the response cache so identical retry requests skip upstream.
 */
export function createSseCollector(hash: string, reqId: string | null): Transform {
  const events: CachedSSEEvent[] = [];
  let buffer = '';
  let currentEvent = 'message';

  function processChunk(chunk: string): void {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    let dataLines: string[] = [];

    for (const line of lines) {
      if (line.startsWith('event: ')) {
        currentEvent = line.slice(7).trim();
      } else if (line.startsWith('data: ')) {
        dataLines.push(line.slice(6));
      } else if (line === '' && dataLines.length > 0) {
        events.push({ event: currentEvent, data: dataLines.join('\n') });
        dataLines = [];
      }
    }
  }

  function flushRemaining(): void {
    if (buffer.trim()) {
      const lines = buffer.split('\n');
      let dataLines: string[] = [];
      for (const line of lines) {
        if (line.startsWith('event: ')) {
          currentEvent = line.slice(7).trim();
        } else if (line.startsWith('data: ')) {
          dataLines.push(line.slice(6));
        } else if (line === '' && dataLines.length > 0) {
          events.push({ event: currentEvent, data: dataLines.join('\n') });
          dataLines = [];
        }
      }
      if (dataLines.length > 0) {
        events.push({ event: currentEvent, data: dataLines.join('\n') });
      }
    }
  }

  return new Transform({
    transform(chunk: Buffer, _encoding: string, callback: TransformCallback): void {
      processChunk(chunk.toString('utf-8'));
      callback(null, chunk);
    },
    flush(callback: TransformCallback): void {
      flushRemaining();
      if (events.length > 0) {
        cache.set(hash, events);
        log.info(reqId, `cached ${events.length} SSE events for hash ${hash}`);
      }
      callback();
    },
  });
}
