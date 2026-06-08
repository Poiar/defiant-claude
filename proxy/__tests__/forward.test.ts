'use strict';

import { addFallbackHeaders, sseHeaders, peekFirstChunk, MAX_SSE_BUFFER } from '../forward';

describe('addFallbackHeaders', () => {
    test('adds fallback-from header', () => {
        const headers = addFallbackHeaders({ 'content-type': 'application/json' }, {
            fallbackFromModel: 'deepseek-v4-pro',
        });
        expect(headers['x-fallback-from']).toBe('deepseek-v4-pro');
        expect(headers['content-type']).toBe('application/json');
    });

    test('adds fallback-index header', () => {
        const headers = addFallbackHeaders({}, {
            fallbackIndex: 2,
        });
        expect(headers['x-fallback-index']).toBe('2');
    });

    test('adds exhausted header', () => {
        const headers = addFallbackHeaders({}, {
            fallbackExhausted: true,
        });
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
        const headers = addFallbackHeaders({}, {
            fallbackFromModel: 'big-pickle',
            fallbackIndex: 1,
            fallbackExhausted: false,
        });
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
                    handlers[event] = handlers[event].filter(h => h !== handler);
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
                    handlers[event].forEach(h => h(...args));
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
