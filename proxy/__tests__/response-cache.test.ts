'use strict';

import {
  hashBody,
  checkCache,
  resetCacheStats,
  cacheStats,
  createSseCollector,
} from '../response-cache';
import { Readable, Writable, pipeline } from 'node:stream';

describe('hashBody', () => {
  test('same content produces same hash', () => {
    const a = Buffer.from('hello');
    const b = Buffer.from('hello');
    expect(hashBody(a)).toBe(hashBody(b));
  });

  test('different content produces different hash', () => {
    expect(hashBody(Buffer.from('a'))).not.toBe(hashBody(Buffer.from('b')));
  });

  test('hash is 32 hex chars', () => {
    expect(hashBody(Buffer.from('test'))).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('checkCache', () => {
  beforeEach(() => {
    resetCacheStats();
  });

  test('returns undefined on cache miss (nothing cached yet)', () => {
    expect(checkCache('never-seen')).toBeUndefined();
    const s = cacheStats();
    expect(s.misses).toBe(1);
  });
});

describe('createSseCollector + cache round-trip', () => {
  test('collects SSE events and makes them available via checkCache', async () => {
    resetCacheStats();

    // Build an SSE stream
    const sseChunks = [
      'event: message_start\ndata: {"type":"message_start"}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];

    const source = Readable.from(sseChunks);
    const collector = createSseCollector('test-hash', null);

    // Sink that captures the output
    const chunks: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding: string, callback: (err?: Error | null) => void): void {
        chunks.push(chunk.toString('utf-8'));
        callback(null);
      },
    });

    await new Promise<void>((resolve, reject) => {
      pipeline(source, collector, sink, (err: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
    });

    // Output should match input
    expect(chunks.join('')).toBe(sseChunks.join(''));

    // Now checkCache should find the events
    const cached = checkCache('test-hash');
    expect(cached).toBeDefined();
    expect(cached!.length).toBe(3);

    // Hit count incremented
    const s = cacheStats();
    expect(s.hits).toBe(1);
  });

  test('different hash gets different events', () => {
    resetCacheStats();
    // 'test-hash-2' was never cached
    expect(checkCache('test-hash-2')).toBeUndefined();
  });
});

describe('cacheStats', () => {
  test('resetCacheStats zeroes hits and misses', () => {
    // Call checkCache to increment misses, then reset
    checkCache('something-never-cached');
    expect(cacheStats().misses).toBeGreaterThanOrEqual(1);
    resetCacheStats();
    expect(cacheStats().hits).toBe(0);
    expect(cacheStats().misses).toBe(0);
  });
});
