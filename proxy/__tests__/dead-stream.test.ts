'use strict';

import { FIRST_BYTE_TIMEOUT_MS, STREAM_HEARTBEAT_MS, STREAM_READ_TIMEOUT_MS, peekFirstChunk } from '../forward';
import type { ForwardResult } from '../forward';

describe('dead stream constants', () => {
    test('FIRST_BYTE_TIMEOUT_MS is 15s', () => {
        expect(FIRST_BYTE_TIMEOUT_MS).toBe(15_000);
    });

    test('STREAM_HEARTBEAT_MS is 180s', () => {
        expect(STREAM_HEARTBEAT_MS).toBe(180_000);
    });

    test('FIRST_BYTE_TIMEOUT_MS < STREAM_READ_TIMEOUT_MS', () => {
        expect(FIRST_BYTE_TIMEOUT_MS).toBeLessThan(STREAM_READ_TIMEOUT_MS);
    });
});

describe('ForwardResult dead stream fields', () => {
    test('ForwardResult accepts deadStream and deadStreamReason', () => {
        const result: ForwardResult = {
            success: false,
            error: 'test',
            transportError: true,
            deadStream: true,
            deadStreamReason: 'first_byte_timeout',
        };
        expect(result.deadStream).toBe(true);
        expect(result.deadStreamReason).toBe('first_byte_timeout');
    });

    test('ForwardResult accepts heartbeat timeout reason', () => {
        const result: ForwardResult = {
            success: false,
            error: 'test',
            transportError: true,
            deadStream: true,
            deadStreamReason: 'heartbeat_timeout',
        };
        expect(result.deadStream).toBe(true);
        expect(result.deadStreamReason).toBe('heartbeat_timeout');
    });
});

describe('peekFirstChunk dead stream behavior', () => {
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

    test('peekFirstChunk times out after specified ms', async () => {
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

    test('peekFirstChunk succeeds for non-SSE content type', async () => {
        const mockStream = createMockStream('application/json');
        const result = await peekFirstChunk(mockStream as unknown as NodeJS.ReadableStream);
        expect(result.ok).toBe(true);
    });

    test('peekFirstChunk succeeds when chunk arrives before timeout', async () => {
        jest.useFakeTimers();
        try {
            const chunk = Buffer.from('data: hello world\n\n');
            const mockStream = createMockStream('text/event-stream', chunk);
            const promise = peekFirstChunk(mockStream as unknown as NodeJS.ReadableStream, 5000);
            mockStream.emit('readable');
            jest.advanceTimersByTime(100);
            const result = await promise;
            expect(result.ok).toBe(true);
            expect(result.firstChunk).toEqual(chunk);
        } finally {
            jest.useRealTimers();
        }
    });
});
