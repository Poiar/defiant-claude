'use strict';

import {
  addFallbackHeaders,
  sseHeaders,
  peekFirstChunk,
  MAX_SSE_BUFFER,
  extractStreamUsage,
  StreamUsageAccumulator,
} from '../forward';

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
