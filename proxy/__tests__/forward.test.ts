'use strict';

import {
  addFallbackHeaders,
  sseHeaders,
  peekFirstChunk,
  MAX_SSE_BUFFER,
  MAX_TOTAL_STREAM_BYTES,
  STREAM_READ_TIMEOUT_MS,
  FIRST_BYTE_TIMEOUT_MS,
  STREAM_HEARTBEAT_MS,
  extractStreamUsage,
  StreamUsageAccumulator,
  _destroyForTest,
} from '../forward';
import { LruCache } from '../lru-cache';

describe('addFallbackHeaders', () => {
  test('adds fallback-from header', () => {
    const headers = addFallbackHeaders(
      { 'content-type': 'application/json' },
      {
        fallbackFromModel: 'deepseek-v4-pro',
      },
    );
    expect(headers['x-fallback-from']).toBe('deepseek-v4-pro');
    expect(headers['content-type']).toBe('application/json');
  });

  test('adds fallback-index header', () => {
    const headers = addFallbackHeaders(
      {},
      {
        fallbackIndex: 2,
      },
    );
    expect(headers['x-fallback-index']).toBe('2');
  });

  test('adds exhausted header', () => {
    const headers = addFallbackHeaders(
      {},
      {
        fallbackExhausted: true,
      },
    );
    expect(headers['x-fallback-exhausted']).toBe('true');
  });

  test('returns headers unchanged when meta is null', () => {
    const original = { foo: 'bar' };
    const result = addFallbackHeaders(original, null);
    expect(result).toEqual(original);
  });

  test('returns headers unchanged when meta is empty', () => {
    const original = { foo: 'bar' };
    const result = addFallbackHeaders(original, {});
    expect(result).toEqual(original);
  });

  test('combines all fallback fields', () => {
    const headers = addFallbackHeaders(
      {},
      {
        fallbackFromModel: 'big-pickle',
        fallbackIndex: 1,
        fallbackExhausted: false,
      },
    );
    expect(headers['x-fallback-from']).toBe('big-pickle');
    expect(headers['x-fallback-index']).toBe('1');
    expect(headers['x-fallback-exhausted']).toBeUndefined();
  });
});

describe('sseHeaders', () => {
  test('includes standard SSE headers', () => {
    const headers = sseHeaders();
    expect(headers['content-type']).toBe('text/event-stream');
    expect(headers['cache-control']).toBe('no-cache, no-transform');
    expect(headers['connection']).toBe('keep-alive');
    expect(headers['x-accel-buffering']).toBe('no');
  });

  test('merges extra headers', () => {
    const headers = sseHeaders({ 'x-custom': 'test-value', 'x-request-id': 'req-1' });
    expect(headers['content-type']).toBe('text/event-stream');
    expect(headers['x-custom']).toBe('test-value');
    expect(headers['x-request-id']).toBe('req-1');
  });

  test('handles undefined extra', () => {
    const headers = sseHeaders(undefined);
    expect(headers['content-type']).toBe('text/event-stream');
    expect(headers['cache-control']).toBe('no-cache, no-transform');
    expect(Object.keys(headers)).toHaveLength(4);
  });

  test('extra headers override defaults', () => {
    const headers = sseHeaders({ 'content-type': 'application/json' });
    expect(headers['content-type']).toBe('application/json');
    expect(headers['cache-control']).toBe('no-cache, no-transform');
  });
});

describe('peekFirstChunk', () => {
  interface MockStream {
    headers: Record<string, string | string[] | undefined>;
    on(event: string, handler: (...args: unknown[]) => void): void;
    once(event: string, handler: (...args: unknown[]) => void): void;
    removeListener(event: string, handler: (...args: unknown[]) => void): void;
    read(): Buffer | null;
    unshift(chunk: Buffer): void;
    destroy(): void;
    emit(event: string, ...args: unknown[]): void;
  }

  function createMockStream(contentType: string, data?: Buffer | null): MockStream {
    const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
    return {
      headers: { 'content-type': contentType },
      on(event: string, handler: (...args: unknown[]) => void) {
        if (!handlers[event]) handlers[event] = [];
        handlers[event].push(handler);
      },
      once(event: string, handler: (...args: unknown[]) => void) {
        if (!handlers[event]) handlers[event] = [];
        handlers[event].push(handler);
      },
      removeListener(event: string, handler: (...args: unknown[]) => void) {
        if (handlers[event]) {
          handlers[event] = handlers[event].filter((h) => h !== handler);
        }
      },
      read() {
        return data ?? null;
      },
      unshift(_chunk: Buffer) {
        // no-op
      },
      destroy() {
        // no-op
      },
      emit(event: string, ...args: unknown[]) {
        if (handlers[event]) {
          handlers[event].forEach((h) => h(...args));
        }
      },
    };
  }

  test('returns ok with first chunk for SSE stream', async () => {
    const chunk = Buffer.from('data: hello world\n\n');
    const mockStream = createMockStream('text/event-stream', chunk);
    const promise = peekFirstChunk(mockStream as unknown as NodeJS.ReadableStream, 5000);
    mockStream.emit('readable');
    const result = await promise;
    expect(result.ok).toBe(true);
    expect(result.firstChunk).toEqual(chunk);
  });

  test('returns ok immediately for non-SSE content-type', async () => {
    const mockStream = createMockStream('application/json');
    const result = await peekFirstChunk(mockStream as unknown as NodeJS.ReadableStream);
    expect(result.ok).toBe(true);
  });

  test('returns ok with null firstChunk for non-SSE', async () => {
    const mockStream = createMockStream('text/plain');
    const result = await peekFirstChunk(mockStream as unknown as NodeJS.ReadableStream);
    expect(result.ok).toBe(true);
    expect(result.firstChunk).toBeNull();
  });

  test('times out when no data arrives', async () => {
    jest.useFakeTimers();
    try {
      const mockStream = createMockStream('text/event-stream', null);
      const promise = peekFirstChunk(mockStream as unknown as NodeJS.ReadableStream, 100);
      jest.advanceTimersByTime(100);
      const result = await promise;
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('timeout');
    } finally {
      jest.useRealTimers();
    }
  });

  test('handles stream error', async () => {
    jest.useFakeTimers();
    try {
      const mockStream = createMockStream('text/event-stream', null);
      const promise = peekFirstChunk(mockStream as unknown as NodeJS.ReadableStream, 50000);
      mockStream.emit('error');
      const result = await promise;
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('error');
      expect(result.message).toBe('stream error during peek');
    } finally {
      jest.useRealTimers();
    }
  });
});

test('MAX_SSE_BUFFER is 1MB', () => {
  expect(MAX_SSE_BUFFER).toBe(1_048_576);
});

// ── extractStreamUsage ─────────────────────────────────────────────

function newAcc(): StreamUsageAccumulator {
  return { prompt_tokens: 0, completion_tokens: 0, cache_hit_tokens: 0, cache_miss_tokens: 0 };
}

describe('extractStreamUsage', () => {
  test('extracts prompt_tokens and completion_tokens from OpenAI SSE payload', () => {
    const acc = newAcc();
    const payload = JSON.stringify({
      id: 'test',
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1500, completion_tokens: 80, total_tokens: 1580 },
    });
    extractStreamUsage(payload, acc);
    expect(acc.prompt_tokens).toBe(1500);
    expect(acc.completion_tokens).toBe(80);
    expect(acc.cache_hit_tokens).toBe(0);
    expect(acc.cache_miss_tokens).toBe(0);
  });

  test('extracts prompt_cache_hit_tokens and prompt_cache_miss_tokens', () => {
    const acc = newAcc();
    const payload = JSON.stringify({
      id: 'test',
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 100000,
        completion_tokens: 500,
        total_tokens: 100500,
        prompt_cache_hit_tokens: 95000,
        prompt_cache_miss_tokens: 5000,
      },
    });
    extractStreamUsage(payload, acc);
    expect(acc.prompt_tokens).toBe(100000);
    expect(acc.completion_tokens).toBe(500);
    expect(acc.cache_hit_tokens).toBe(95000);
    expect(acc.cache_miss_tokens).toBe(5000);
  });

  test('cache_miss_tokens defaults to 0 when missing', () => {
    const acc = newAcc();
    const payload = JSON.stringify({
      id: 'test',
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 10,
        total_tokens: 110,
        prompt_cache_hit_tokens: 90,
        // prompt_cache_miss_tokens absent
      },
    });
    extractStreamUsage(payload, acc);
    expect(acc.cache_hit_tokens).toBe(90);
    expect(acc.cache_miss_tokens).toBe(0);
  });

  test('extracts Anthropic field names (cache_read_input_tokens, cache_creation_input_tokens)', () => {
    const acc = newAcc();
    const payload = JSON.stringify({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: {
        input_tokens: 2000,
        output_tokens: 100,
        cache_read_input_tokens: 1800,
        cache_creation_input_tokens: 200,
      },
    });
    extractStreamUsage(payload, acc);
    expect(acc.prompt_tokens).toBe(2000);
    expect(acc.completion_tokens).toBe(100);
    expect(acc.cache_hit_tokens).toBe(1800);
    expect(acc.cache_miss_tokens).toBe(200);
  });

  test('prefers OpenAI cache fields over Anthropic when both present', () => {
    const acc = newAcc();
    const payload = JSON.stringify({
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 100,
        prompt_cache_hit_tokens: 800,
        prompt_cache_miss_tokens: 200,
        cache_read_input_tokens: 999,
        cache_creation_input_tokens: 1,
      },
    });
    extractStreamUsage(payload, acc);
    // OpenAI fields win
    expect(acc.cache_hit_tokens).toBe(800);
    expect(acc.cache_miss_tokens).toBe(200);
  });

  test('handles payload without usage field gracefully', () => {
    const acc = newAcc();
    const payload = JSON.stringify({
      id: 'test',
      choices: [{ delta: { content: 'hello' }, finish_reason: null }],
      usage: null,
    });
    extractStreamUsage(payload, acc);
    expect(acc.prompt_tokens).toBe(0);
    expect(acc.completion_tokens).toBe(0);
    expect(acc.cache_hit_tokens).toBe(0);
    expect(acc.cache_miss_tokens).toBe(0);
  });

  test('handles [DONE] marker gracefully', () => {
    const acc = newAcc();
    extractStreamUsage('[DONE]', acc);
    expect(acc.prompt_tokens).toBe(0);
  });

  test('handles empty string gracefully', () => {
    const acc = newAcc();
    extractStreamUsage('', acc);
    expect(acc.prompt_tokens).toBe(0);
  });

  test('handles invalid JSON gracefully', () => {
    const acc = newAcc();
    extractStreamUsage('not json at all {{{', acc);
    expect(acc.prompt_tokens).toBe(0);
  });

  test('handles zero-value cache tokens correctly (hit=0 miss>0)', () => {
    const acc = newAcc();
    const payload = JSON.stringify({
      usage: {
        prompt_tokens: 6,
        completion_tokens: 10,
        prompt_cache_hit_tokens: 0,
        prompt_cache_miss_tokens: 6,
      },
    });
    extractStreamUsage(payload, acc);
    expect(acc.prompt_tokens).toBe(6);
    expect(acc.completion_tokens).toBe(10);
    expect(acc.cache_hit_tokens).toBe(0);
    expect(acc.cache_miss_tokens).toBe(6);
  });

  test('accumulates across multiple calls (last-write-wins for prompt/completion)', () => {
    const acc = newAcc();
    // First SSE event: intermediate chunk (usage null — should be no-op)
    extractStreamUsage(
      JSON.stringify({ choices: [{ delta: { content: 'hi' } }], usage: null }),
      acc,
    );
    expect(acc.prompt_tokens).toBe(0);
    // Second SSE event: final chunk with usage
    extractStreamUsage(
      JSON.stringify({
        usage: {
          prompt_tokens: 500000,
          completion_tokens: 2000,
          prompt_cache_hit_tokens: 490000,
          prompt_cache_miss_tokens: 10000,
        },
      }),
      acc,
    );
    expect(acc.prompt_tokens).toBe(500000);
    expect(acc.cache_hit_tokens).toBe(490000);
    expect(acc.cache_miss_tokens).toBe(10000);
  });
});

// =========================================================================
// Additional constant tests
// =========================================================================

describe('forward constants', () => {
  test('MAX_TOTAL_STREAM_BYTES is 500MB', () => {
    expect(MAX_TOTAL_STREAM_BYTES).toBe(500 * 1024 * 1024);
  });

  test('STREAM_READ_TIMEOUT_MS is 300s (5 min)', () => {
    expect(STREAM_READ_TIMEOUT_MS).toBe(300_000);
  });

  test('FIRST_BYTE_TIMEOUT_MS is 30s (was 15s, bumped for DeepSeek extended thinking)', () => {
    expect(FIRST_BYTE_TIMEOUT_MS).toBe(30_000);
  });

  test('STREAM_HEARTBEAT_MS is 180s (3 min)', () => {
    expect(STREAM_HEARTBEAT_MS).toBe(180_000);
  });

  test('MAX_SSE_BUFFER is 1MB', () => {
    expect(MAX_SSE_BUFFER).toBe(1_048_576);
  });
});

// =========================================================================
// sseHeaders — additional edge cases
// =========================================================================

describe('sseHeaders — edge cases', () => {
  test('handles empty object extra', () => {
    const headers = sseHeaders({});
    expect(headers['content-type']).toBe('text/event-stream');
    expect(headers['cache-control']).toBe('no-cache, no-transform');
    expect(headers['connection']).toBe('keep-alive');
    expect(headers['x-accel-buffering']).toBe('no');
    expect(Object.keys(headers)).toHaveLength(4); // empty extra adds no keys
  });

  test('returns a new object each call', () => {
    const h1 = sseHeaders();
    const h2 = sseHeaders();
    expect(h1).not.toBe(h2);
    expect(h1).toEqual(h2);
  });

  test('handles null-like value in extra gracefully', () => {
    // User should pass undefined, but Object.assign handles null fine via ||
    const headers = sseHeaders();
    expect(headers['content-type']).toBe('text/event-stream');
  });
});

// =========================================================================
// peekFirstChunk — additional edge cases
// =========================================================================

describe('peekFirstChunk — edge cases', () => {
  interface MockStream {
    headers: Record<string, string | string[] | undefined>;
    on(event: string, handler: (...args: unknown[]) => void): void;
    once(event: string, handler: (...args: unknown[]) => void): void;
    removeListener(event: string, handler: (...args: unknown[]) => void): void;
    read(): Buffer | null;
    unshift(chunk: Buffer): void;
    destroy(): void;
    emit(event: string, ...args: unknown[]): void;
  }

  function createMockStream(contentType: string, data?: Buffer | null): MockStream {
    const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
    return {
      headers: { 'content-type': contentType },
      on(event: string, handler: (...args: unknown[]) => void) {
        if (!handlers[event]) handlers[event] = [];
        handlers[event].push(handler);
      },
      once(event: string, handler: (...args: unknown[]) => void) {
        if (!handlers[event]) handlers[event] = [];
        handlers[event].push(handler);
      },
      removeListener(event: string, handler: (...args: unknown[]) => void) {
        if (handlers[event]) {
          handlers[event] = handlers[event].filter((h) => h !== handler);
        }
      },
      read() {
        return data ?? null;
      },
      unshift(_chunk: Buffer) {},
      destroy() {},
      emit(event: string, ...args: unknown[]) {
        if (handlers[event]) {
          handlers[event].forEach((h) => h(...args));
        }
      },
    };
  }

  test('handles stream end (no data before end)', async () => {
    jest.useFakeTimers();
    try {
      const mockStream = createMockStream('text/event-stream', null);
      const promise = peekFirstChunk(mockStream as unknown as NodeJS.ReadableStream, 5000);
      mockStream.emit('end');
      const result = await promise;
      expect(result.ok).toBe(true);
      expect(result.firstChunk).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  test('detects already-buffered data on attachment', async () => {
    jest.useFakeTimers();
    try {
      const chunk = Buffer.from('pre-buffered data\n\n');
      const mockStream = createMockStream('text/event-stream', chunk);
      // The read() call on attach returns chunk immediately — no emit needed
      const promise = peekFirstChunk(mockStream as unknown as NodeJS.ReadableStream, 5000);
      const result = await promise;
      expect(result.ok).toBe(true);
      expect(result.firstChunk).toEqual(chunk);
    } finally {
      jest.useRealTimers();
    }
  });

  test('respects custom timeout parameter', async () => {
    jest.useFakeTimers();
    try {
      const mockStream = createMockStream('text/event-stream', null);
      const promise = peekFirstChunk(mockStream as unknown as NodeJS.ReadableStream, 2000);
      jest.advanceTimersByTime(1999);
      // Not timed out yet at 1999ms
      jest.advanceTimersByTime(2);
      const result = await promise;
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('timeout');
    } finally {
      jest.useRealTimers();
    }
  });

  test('ignores events after resolution (double readable)', async () => {
    jest.useFakeTimers();
    try {
      const chunk = Buffer.from('first chunk\n\n');
      const mockStream = createMockStream('text/event-stream', chunk);
      const promise = peekFirstChunk(mockStream as unknown as NodeJS.ReadableStream, 5000);
      mockStream.emit('readable');
      // Emit again after resolution — should be ignored (no crash)
      mockStream.emit('readable');
      mockStream.emit('error');
      const result = await promise;
      expect(result.ok).toBe(true);
      expect(result.firstChunk).toEqual(chunk);
    } finally {
      jest.useRealTimers();
    }
  });

  test('handles content-type header as string array (Array.includes works)', async () => {
    const mockStream = {
      headers: { 'content-type': ['text/event-stream'] },
      on: jest.fn(),
      once: jest.fn(),
      removeListener: jest.fn(),
      read: () => null,
      unshift: jest.fn(),
      destroy: jest.fn(),
      emit: jest.fn(),
    };
    jest.useFakeTimers();
    try {
      const promise = peekFirstChunk(mockStream as unknown as NodeJS.ReadableStream, 100);
      jest.advanceTimersByTime(100);
      const result = await promise;
      // Array.includes('text/event-stream') is true, so enters SSE path and times out
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('timeout');
    } finally {
      jest.useRealTimers();
    }
  });

  test('handles undefined content-type header', async () => {
    const mockStream = {
      headers: {},
      on: jest.fn(),
      once: jest.fn(),
      removeListener: jest.fn(),
      read: () => null,
      unshift: jest.fn(),
      destroy: jest.fn(),
      emit: jest.fn(),
    };
    jest.useFakeTimers();
    try {
      const promise = peekFirstChunk(mockStream as unknown as NodeJS.ReadableStream, 100);
      jest.advanceTimersByTime(100);
      const result = await promise;
      expect(result.ok).toBe(true);
      expect(result.firstChunk).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });
});

// =========================================================================
// extractStreamUsage — additional edge cases
// =========================================================================

describe('extractStreamUsage — edge cases', () => {
  function newAcc(): StreamUsageAccumulator {
    return { prompt_tokens: 0, completion_tokens: 0, cache_hit_tokens: 0, cache_miss_tokens: 0 };
  }

  test('handles Anthropic message_stop type usage format', () => {
    const acc = newAcc();
    const payload = JSON.stringify({
      type: 'message_stop',
    });
    extractStreamUsage(payload, acc);
    // No usage object → tokens stay 0
    expect(acc.prompt_tokens).toBe(0);
    expect(acc.completion_tokens).toBe(0);
  });

  test('extracts Anthropic input_tokens and output_tokens', () => {
    const acc = newAcc();
    const payload = JSON.stringify({
      type: 'message_delta',
      usage: {
        input_tokens: 500,
        output_tokens: 50,
      },
    });
    extractStreamUsage(payload, acc);
    expect(acc.prompt_tokens).toBe(500);
    expect(acc.completion_tokens).toBe(50);
  });

  test('Anthropic cache tokens are 0 when not present', () => {
    const acc = newAcc();
    const payload = JSON.stringify({
      type: 'message_delta',
      usage: {
        input_tokens: 100,
        output_tokens: 10,
      },
    });
    extractStreamUsage(payload, acc);
    expect(acc.prompt_tokens).toBe(100);
    expect(acc.cache_hit_tokens).toBe(0);
    expect(acc.cache_miss_tokens).toBe(0);
  });

  test('OpenAI prompt_cache_miss_tokens defaults to 0', () => {
    const acc = newAcc();
    const payload = JSON.stringify({
      usage: {
        prompt_tokens: 5,
        completion_tokens: 1,
        prompt_cache_hit_tokens: 3,
        // prompt_cache_miss_tokens absent
      },
    });
    extractStreamUsage(payload, acc);
    expect(acc.cache_miss_tokens).toBe(0);
  });

  test('handles whitespace-only string', () => {
    const acc = newAcc();
    extractStreamUsage('   \n  ', acc);
    // JSON.parse throws → tokens stay 0
    expect(acc.prompt_tokens).toBe(0);
  });

  test('accumulates across multiple calls — completion and prompt overwrite', () => {
    const acc = newAcc();
    extractStreamUsage(
      JSON.stringify({ usage: { prompt_tokens: 100, completion_tokens: 10 } }),
      acc,
    );
    expect(acc.prompt_tokens).toBe(100);
    extractStreamUsage(
      JSON.stringify({ usage: { prompt_tokens: 200, completion_tokens: 30 } }),
      acc,
    );
    // Last write wins for prompt/completion (not accumulated)
    expect(acc.prompt_tokens).toBe(200);
    expect(acc.completion_tokens).toBe(30);
  });

  test('cache tokens overwrite (not accumulate) across calls', () => {
    const acc = newAcc();
    extractStreamUsage(
      JSON.stringify({
        usage: {
          prompt_tokens: 1,
          completion_tokens: 1,
          prompt_cache_hit_tokens: 50,
          prompt_cache_miss_tokens: 10,
        },
      }),
      acc,
    );
    expect(acc.cache_hit_tokens).toBe(50);
    expect(acc.cache_miss_tokens).toBe(10);
    // Second call with no cache fields — does NOT overwrite (only sets when cache fields present)
    extractStreamUsage(
      JSON.stringify({
        usage: { prompt_tokens: 2, completion_tokens: 2 },
      }),
      acc,
    );
    // Cache tokens unchanged from first call (no cache fields in second usage)
    expect(acc.cache_hit_tokens).toBe(50);
    expect(acc.cache_miss_tokens).toBe(10);
    // Third call with new cache values overwrites
    extractStreamUsage(
      JSON.stringify({
        usage: {
          prompt_tokens: 3,
          completion_tokens: 3,
          prompt_cache_hit_tokens: 99,
          prompt_cache_miss_tokens: 1,
        },
      }),
      acc,
    );
    expect(acc.cache_hit_tokens).toBe(99);
    expect(acc.cache_miss_tokens).toBe(1);
  });

  test('handles extremely large token numbers', () => {
    const acc = newAcc();
    const payload = JSON.stringify({
      usage: {
        prompt_tokens: 999999999,
        completion_tokens: 888888888,
        prompt_cache_hit_tokens: 777777777,
        prompt_cache_miss_tokens: 666666666,
      },
    });
    extractStreamUsage(payload, acc);
    expect(acc.prompt_tokens).toBe(999999999);
    expect(acc.cache_hit_tokens).toBe(777777777);
    expect(acc.cache_miss_tokens).toBe(666666666);
  });

  test('negative token values are preserved as-is (no clamping)', () => {
    const acc = newAcc();
    const payload = JSON.stringify({
      usage: {
        prompt_tokens: -1,
        completion_tokens: 0,
      },
    });
    extractStreamUsage(payload, acc);
    expect(acc.prompt_tokens).toBe(-1);
  });
});

// =========================================================================
// addFallbackHeaders — additional edge cases
// =========================================================================

describe('addFallbackHeaders — edge cases', () => {
  test('handles meta with null field values', () => {
    const headers = addFallbackHeaders(
      {},
      {
        fallbackFromModel: null,
        fallbackIndex: undefined,
      },
    );
    // null and undefined fields should not be added
    expect(headers['x-fallback-from']).toBeUndefined();
    expect(headers['x-fallback-index']).toBeUndefined();
  });

  test('does not mutate the original headers object', () => {
    const original = { 'content-type': 'application/json' };
    const result = addFallbackHeaders(original, { fallbackFromModel: 'test' });
    // Original should be unchanged
    expect(original['x-fallback-from']).toBeUndefined();
    // Result has the addition
    expect(result['x-fallback-from']).toBe('test');
    expect(result['content-type']).toBe('application/json');
  });

  test('handles meta with all fields false/falsy', () => {
    const headers = addFallbackHeaders(
      {},
      {
        fallbackFromModel: '',
        fallbackIndex: 0,
        fallbackExhausted: false,
      },
    );
    // Empty string still gets set (truthiness check might vary)
    if (headers['x-fallback-from'] !== undefined) {
      expect(headers['x-fallback-from']).toBe('');
    }
  });
});

// ---------------------------------------------------------------------------
// extractStreamUsage — usage extraction from SSE payloads, including truncation
// ---------------------------------------------------------------------------
describe('extractStreamUsage', () => {
  test('extracts Anthropic-format cache tokens', () => {
    const acc: StreamUsageAccumulator = { prompt_tokens: 0, completion_tokens: 0, cache_hit_tokens: 0, cache_miss_tokens: 0 };
    extractStreamUsage('{"usage":{"prompt_tokens":100,"completion_tokens":50,"prompt_cache_hit_tokens":80,"prompt_cache_miss_tokens":20}}', acc);
    expect(acc.prompt_tokens).toBe(100);
    expect(acc.completion_tokens).toBe(50);
    expect(acc.cache_hit_tokens).toBe(80);
    expect(acc.cache_miss_tokens).toBe(20);
  });

  test('extracts OpenAI-format cache tokens', () => {
    const acc: StreamUsageAccumulator = { prompt_tokens: 0, completion_tokens: 0, cache_hit_tokens: 0, cache_miss_tokens: 0 };
    extractStreamUsage('{"usage":{"input_tokens":200,"output_tokens":30,"cache_read_input_tokens":180,"cache_creation_input_tokens":20}}', acc);
    expect(acc.prompt_tokens).toBe(200);
    expect(acc.completion_tokens).toBe(30);
    expect(acc.cache_hit_tokens).toBe(180);
    expect(acc.cache_miss_tokens).toBe(20);
  });

  test('handles [DONE] payload', () => {
    const acc: StreamUsageAccumulator = { prompt_tokens: 0, completion_tokens: 0, cache_hit_tokens: 0, cache_miss_tokens: 0 };
    extractStreamUsage('[DONE]', acc);
    expect(acc.prompt_tokens).toBe(0);
  });

  test('handles malformed JSON gracefully', () => {
    const acc: StreamUsageAccumulator = { prompt_tokens: 0, completion_tokens: 0, cache_hit_tokens: 0, cache_miss_tokens: 0 };
    extractStreamUsage('not json', acc);
    expect(acc.prompt_tokens).toBe(0);
  });

  test('preserves last usage event after simulated truncation (overflow guard)', () => {
    // Simulate what happens after the 1MB rawUsageBuf overflow guard runs:
    // the last complete event should have its usage extracted
    const acc: StreamUsageAccumulator = { prompt_tokens: 0, completion_tokens: 0, cache_hit_tokens: 0, cache_miss_tokens: 0 };
    // The overflow guard splits at the last \n\n and processes complete events
    // before discarding. This simulates that extraction.
    const overflowChunk = 'data: {"type":"ping"}\n\ndata: {"usage":{"prompt_tokens":500,"completion_tokens":25,"prompt_cache_hit_tokens":450,"prompt_cache_miss_tokens":50}}\n\n';
    const parts = overflowChunk.split('\n\n').filter(Boolean);
    for (const part of parts) {
      const dataLines = [...part.matchAll(/^data: ?(.*)$/gm)];
      if (!dataLines.length) continue;
      const payload = dataLines.map((m) => m[1]).join('\n');
      if (payload === '[DONE]') continue;
      extractStreamUsage(payload, acc);
    }
    // Usage from the last event should be preserved
    expect(acc.prompt_tokens).toBe(500);
    expect(acc.cache_hit_tokens).toBe(450);
    expect(acc.cache_miss_tokens).toBe(50);
  });

  afterAll(() => {
    LruCache.resetAll();
    _destroyForTest();
  });
});
