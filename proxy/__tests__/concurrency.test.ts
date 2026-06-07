'use strict';

import { createSlotLimiter, DEFAULT_MAX_CONCURRENT } from '../concurrency';

describe('createSlotLimiter', () => {
    test('acquires immediately when under limit', async () => {
        const limiter = createSlotLimiter(5);
        const { promise, cancel } = limiter.acquire();
        expect(typeof cancel).toBe('function');
        const release = await promise;
        expect(typeof release).toBe('function');

        const status = limiter.status();
        expect(status.active).toBe(1);
        expect(status.waiting).toBe(0);

        release();
        expect(limiter.status().active).toBe(0);
    });

    test('queues when at limit', async () => {
        const limiter = createSlotLimiter(2);

        const { promise: p1 } = limiter.acquire();
        const { promise: p2 } = limiter.acquire();
        const r1 = await p1;
        const r2 = await p2;

        expect(limiter.status().active).toBe(2);

        let acquired = false;
        const { promise: p3 } = limiter.acquire();
        const pending = p3.then(release => {
            acquired = true;
            release();
        });

        await new Promise(r => setTimeout(r, 50));
        expect(acquired).toBe(false);
        expect(limiter.status().waiting).toBe(1);

        r1();
        await pending;
        expect(acquired).toBe(true);
        expect(limiter.status().active).toBe(1);

        r2();
        expect(limiter.status().active).toBe(0);
    });

    test('release wakes waiters in FIFO order', async () => {
        const limiter = createSlotLimiter(1);
        const order: number[] = [];

        const { promise: p1 } = limiter.acquire();
        const r1 = await p1;

        const p2 = limiter.acquire().promise.then(r => { order.push(2); r(); });
        const p3 = limiter.acquire().promise.then(r => { order.push(3); r(); });

        await new Promise(r => setTimeout(r, 50));
        expect(order).toEqual([]);

        r1();
        await p2;
        expect(order).toEqual([2, 3]);

        await p3;
    });

    test('status reports utilization', async () => {
        const limiter = createSlotLimiter(10);
        const releases: Array<() => void> = [];
        for (let i = 0; i < 5; i++) {
            const { promise } = limiter.acquire();
            releases.push(await promise);
        }

        const s = limiter.status();
        expect(s.active).toBe(5);
        expect(s.limit).toBe(10);
        expect(s.utilization).toBe(0.5);

        for (const r of releases) r();
        expect(limiter.status().active).toBe(0);
    });

    test('defaults to DEFAULT_MAX_CONCURRENT', () => {
        const limiter = createSlotLimiter();
        expect(limiter.status().limit).toBe(DEFAULT_MAX_CONCURRENT);
    });
});
