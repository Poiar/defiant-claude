'use strict';

import { LruCache } from '../lru-cache';

describe('LruCache', () => {
    test('stores and retrieves values', () => {
        const cache = new LruCache({ ttlMs: 60_000 });
        cache.set('a', 1);
        expect(cache.get('a')).toBe(1);
    });

    test('returns undefined for missing keys', () => {
        const cache = new LruCache();
        expect(cache.get('nope')).toBeUndefined();
    });

    test('expires entries after TTL', async () => {
        const cache = new LruCache({ ttlMs: 50 });
        cache.set('a', 1);
        expect(cache.get('a')).toBe(1);

        await new Promise(r => setTimeout(r, 60));
        expect(cache.get('a')).toBeUndefined();
    });

    test('get() promotes to most-recently-used', () => {
        const cache = new LruCache({ ttlMs: 60_000, maxEntries: 3 });
        cache.set('a', 1);
        cache.set('b', 2);
        cache.set('c', 3);

        cache.get('a');

        cache.set('d', 4);
        expect(cache.get('a')).toBe(1);
        expect(cache.get('b')).toBeUndefined();
        expect(cache.get('c')).toBe(3);
        expect(cache.get('d')).toBe(4);
    });

    test('evicts oldest on overflow', () => {
        const cache = new LruCache({ maxEntries: 2, ttlMs: 60_000 });
        cache.set('a', 1);
        cache.set('b', 2);
        cache.set('c', 3);

        expect(cache.get('a')).toBeUndefined();
        expect(cache.get('b')).toBe(2);
        expect(cache.get('c')).toBe(3);
    });

    test('delete removes entry', () => {
        const cache = new LruCache();
        cache.set('a', 1);
        expect(cache.delete('a')).toBe(true);
        expect(cache.get('a')).toBeUndefined();
        expect(cache.delete('b')).toBe(false);
    });

    test('clear empties the cache', () => {
        const cache = new LruCache();
        cache.set('a', 1);
        cache.set('b', 2);
        cache.clear();
        expect(cache.size).toBe(0);
    });

    test('size reflects non-expired entries', () => {
        const cache = new LruCache({ ttlMs: 60_000 });
        cache.set('a', 1);
        cache.set('b', 2);
        expect(cache.size).toBe(2);
    });

    test('destroy stops cleanup and clears', () => {
        const cache = new LruCache();
        cache.set('a', 1);
        cache.destroy();
        expect(cache.size).toBe(0);
    });

    afterAll(() => {
        LruCache.resetAll();
    });
});
