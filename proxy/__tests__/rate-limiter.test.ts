'use strict';

import { createRateLimiter } from '../rate-limiter';

afterEach(() => {
    jest.useRealTimers();
});

describe('createRateLimiter', () => {

    describe('basic functionality', () => {
        test('allows first request from an IP', () => {
            const limiter = createRateLimiter({ maxPerWindow: 5, windowMs: 60_000 });
            const result = limiter.check('127.0.0.1');
            expect(result).toEqual({ allowed: true });
        });

        test('allows requests up to maxPerWindow', () => {
            const limiter = createRateLimiter({ maxPerWindow: 5, windowMs: 60_000 });
            for (let i = 0; i < 5; i++) {
                const result = limiter.check('127.0.0.1');
                expect(result).toEqual({ allowed: true });
            }
        });

        test('blocks requests exceeding maxPerWindow', () => {
            const limiter = createRateLimiter({ maxPerWindow: 3, windowMs: 60_000 });
            for (let i = 0; i < 3; i++) {
                limiter.check('127.0.0.1');
            }
            const result = limiter.check('127.0.0.1');
            expect(result.allowed).toBe(false);
            expect(result.retryAfter).toBeDefined();
            expect(typeof result.retryAfter).toBe('number');
            expect(result.retryAfter).toBeGreaterThan(0);
        });

        test('returns retryAfter seconds when blocked', () => {
            const limiter = createRateLimiter({ maxPerWindow: 1, windowMs: 10_000 });
            jest.useFakeTimers();
            jest.setSystemTime(new Date(100_000));

            limiter.check('127.0.0.1');
            const result = limiter.check('127.0.0.1');

            expect(result.allowed).toBe(false);
            // windowStart = 100000, windowMs = 10000, now = 100000
            // retryAfter = ceil((100000 + 10000 - 100000) / 1000) = ceil(10) = 10
            expect(result.retryAfter).toBe(10);
        });

        test('retryAfter decreases as time passes in the window', () => {
            const limiter = createRateLimiter({ maxPerWindow: 1, windowMs: 10_000 });
            jest.useFakeTimers();
            jest.setSystemTime(new Date(100_000));

            limiter.check('127.0.0.1');

            // Advance 3 seconds into the window
            jest.advanceTimersByTime(3000);
            const result = limiter.check('127.0.0.1');

            expect(result.allowed).toBe(false);
            // retryAfter = ceil((100000 + 10000 - 103000) / 1000) = ceil(7) = 7
            expect(result.retryAfter).toBe(7);
        });
    });

    describe('window reset', () => {
        test('resets count after window expires', () => {
            const limiter = createRateLimiter({ maxPerWindow: 2, windowMs: 10_000 });
            jest.useFakeTimers();
            jest.setSystemTime(new Date(100_000));

            // Use up the 2 allowed requests
            expect(limiter.check('127.0.0.1').allowed).toBe(true);
            expect(limiter.check('127.0.0.1').allowed).toBe(true);
            // Should be blocked
            expect(limiter.check('127.0.0.1').allowed).toBe(false);

            // Advance past the window boundary
            jest.advanceTimersByTime(10_001);

            // Should be allowed again — new window started
            expect(limiter.check('127.0.0.1').allowed).toBe(true);
        });

        test('count does not reset before window expires', () => {
            const limiter = createRateLimiter({ maxPerWindow: 2, windowMs: 10_000 });
            jest.useFakeTimers();
            jest.setSystemTime(new Date(100_000));

            limiter.check('127.0.0.1');
            limiter.check('127.0.0.1');
            expect(limiter.check('127.0.0.1').allowed).toBe(false);

            // Advance almost to the window end, but not past it
            jest.advanceTimersByTime(9_999);

            // Should still be blocked (same window)
            expect(limiter.check('127.0.0.1').allowed).toBe(false);
        });

        test('blocked IP becomes allowed at exact window boundary', () => {
            const limiter = createRateLimiter({ maxPerWindow: 1, windowMs: 5_000 });
            jest.useFakeTimers();
            jest.setSystemTime(new Date(100_000));

            limiter.check('127.0.0.1');
            expect(limiter.check('127.0.0.1').allowed).toBe(false);

            // Advance to exactly the window boundary
            jest.advanceTimersByTime(5_000);

            // now - windowStart = 5000 which is >= windowMs (5000), so new window
            expect(limiter.check('127.0.0.1').allowed).toBe(true);
        });
    });

    describe('multiple IPs', () => {
        test('tracks different IPs independently', () => {
            const limiter = createRateLimiter({ maxPerWindow: 2, windowMs: 60_000 });

            // IP A exhausts its quota
            limiter.check('A');
            limiter.check('A');
            expect(limiter.check('A').allowed).toBe(false);

            // IP B should still have a full quota
            expect(limiter.check('B').allowed).toBe(true);
            expect(limiter.check('B').allowed).toBe(true);
            expect(limiter.check('B').allowed).toBe(false);

            // IP C should be allowed
            expect(limiter.check('C').allowed).toBe(true);
        });

        test('many blocked IPs do not affect new IPs', () => {
            const limiter = createRateLimiter({ maxPerWindow: 1, windowMs: 60_000 });

            // Exhaust 5 different IPs
            for (let i = 0; i < 5; i++) {
                const ip = `blocked-${i}`;
                limiter.check(ip);
                expect(limiter.check(ip).allowed).toBe(false);
            }

            // A new IP should be unaffected
            expect(limiter.check('fresh-ip').allowed).toBe(true);
        });
    });

    describe('custom options', () => {
        test('respects custom maxPerWindow', () => {
            const limiter = createRateLimiter({ maxPerWindow: 10, windowMs: 60_000 });
            for (let i = 0; i < 10; i++) {
                expect(limiter.check('127.0.0.1').allowed).toBe(true);
            }
            expect(limiter.check('127.0.0.1').allowed).toBe(false);
        });

        test('respects custom windowMs', () => {
            const limiter = createRateLimiter({ maxPerWindow: 2, windowMs: 5_000 });
            jest.useFakeTimers();
            jest.setSystemTime(new Date(100_000));

            expect(limiter.check('127.0.0.1').allowed).toBe(true);
            expect(limiter.check('127.0.0.1').allowed).toBe(true);
            expect(limiter.check('127.0.0.1').allowed).toBe(false);

            // Advance past the custom-length window
            jest.advanceTimersByTime(5_001);
            expect(limiter.check('127.0.0.1').allowed).toBe(true);
        });

        test('respects custom maxEntries', () => {
            const limiter = createRateLimiter({ maxPerWindow: 100, windowMs: 60_000, maxEntries: 7 });
            expect(limiter.status().maxEntries).toBe(7);

            for (let i = 0; i < 20; i++) {
                limiter.check(`ip-${i}`);
            }

            // Should never exceed maxEntries
            expect(limiter.status().tracked).toBe(7);
        });
    });

    describe('LRU eviction', () => {
        test('evicts oldest entry when at maxEntries capacity', () => {
            const limiter = createRateLimiter({ maxPerWindow: 100, windowMs: 60_000, maxEntries: 3 });

            // Fill with 3 distinct IPs
            limiter.check('A');
            limiter.check('B');
            limiter.check('C');
            expect(limiter.status().tracked).toBe(3);

            // Add a 4th IP — should evict the oldest (A)
            limiter.check('D');
            expect(limiter.status().tracked).toBe(3);

            // Add a 5th IP — should evict the next oldest (B)
            limiter.check('E');
            expect(limiter.status().tracked).toBe(3);

            // C, D, E should remain; A and B were evicted
            // Since A was evicted, it gets a fresh window — verify it's treated as new
            expect(limiter.check('A').allowed).toBe(true);
        });

        test('eviction maintains maxEntries under high IP churn', () => {
            const limiter = createRateLimiter({ maxPerWindow: 50, windowMs: 60_000, maxEntries: 10 });

            for (let i = 0; i < 1000; i++) {
                limiter.check(`ip-${i}`);
            }

            expect(limiter.status().tracked).toBe(10);
        });
    });

    describe('status', () => {
        test('status() returns current state', () => {
            const limiter = createRateLimiter({ maxPerWindow: 50, windowMs: 30_000, maxEntries: 100 });

            expect(limiter.status()).toEqual({
                tracked: 0,
                maxEntries: 100,
                maxPerWindow: 50,
                windowMs: 30_000,
            });

            limiter.check('A');
            limiter.check('B');
            expect(limiter.status().tracked).toBe(2);
            expect(limiter.status().maxEntries).toBe(100);
            expect(limiter.status().maxPerWindow).toBe(50);
            expect(limiter.status().windowMs).toBe(30_000);
        });

        test('status() reflects custom options', () => {
            const limiter = createRateLimiter({ maxPerWindow: 10, windowMs: 5000, maxEntries: 50 });
            expect(limiter.status()).toEqual({
                tracked: 0,
                maxEntries: 50,
                maxPerWindow: 10,
                windowMs: 5000,
            });
        });

        test('status().tracked increases and decreases with evictions', () => {
            const limiter = createRateLimiter({ maxPerWindow: 100, windowMs: 60_000, maxEntries: 3 });

            expect(limiter.status().tracked).toBe(0);

            limiter.check('A');
            expect(limiter.status().tracked).toBe(1);

            limiter.check('B');
            expect(limiter.status().tracked).toBe(2);

            limiter.check('C');
            expect(limiter.status().tracked).toBe(3);

            // Adding D evicts A, tracked stays at 3
            limiter.check('D');
            expect(limiter.status().tracked).toBe(3);
        });
    });

    describe('edge cases', () => {
        test('handles empty IP string', () => {
            const limiter = createRateLimiter({ maxPerWindow: 2, windowMs: 60_000 });
            expect(limiter.check('').allowed).toBe(true);
            expect(limiter.check('').allowed).toBe(true);
            expect(limiter.check('').allowed).toBe(false);
        });

        test('default options when no opts passed', () => {
            const limiter = createRateLimiter();
            const status = limiter.status();
            expect(status.maxPerWindow).toBe(500);
            expect(status.windowMs).toBe(60_000);
            expect(status.maxEntries).toBe(10_000);
            expect(status.tracked).toBe(0);
        });

        test('handles very long IP strings', () => {
            const limiter = createRateLimiter({ maxPerWindow: 3, windowMs: 60_000 });
            const longIp = '2001:0db8:85a3:0000:0000:8a2e:0370:7334' + 'x'.repeat(200);
            expect(limiter.check(longIp).allowed).toBe(true);
            expect(limiter.check(longIp).allowed).toBe(true);
            expect(limiter.check(longIp).allowed).toBe(true);
            expect(limiter.check(longIp).allowed).toBe(false);
        });

        test('single IP can be tracked without being blocked', () => {
            const limiter = createRateLimiter({ maxPerWindow: 5, windowMs: 60_000 });
            for (let i = 0; i < 5; i++) {
                expect(limiter.check('steady-ip').allowed).toBe(true);
            }
        });

        test('does not leak memory when many IPs cycle through', () => {
            const limiter = createRateLimiter({ maxPerWindow: 5, windowMs: 60_000, maxEntries: 100 });
            for (let i = 0; i < 500; i++) {
                limiter.check(`cycle-${i}`);
            }
            expect(limiter.status().tracked).toBe(100);
        });
    });

});
