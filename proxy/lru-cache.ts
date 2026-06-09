'use strict';

// TTL cache with lazy cleanup and LRU eviction.
// Designed for in-memory caches that need automatic expiration without
// a dedicated cleanup timer per cache instance.

interface LruCacheOptions {
    maxEntries?: number;
    ttlMs?: number;
}

// Shared cleanup scheduler -- runs one interval for all cache instances.
const allCaches = new Set<LruCache<unknown>>();
let cleanupTimer: ReturnType<typeof setInterval> | null = null;
const CLEANUP_MS = 300_000; // 5 minutes

function ensureCleanupTimer(): void {
    if (cleanupTimer) return;
    cleanupTimer = setInterval(() => {
        const now = Date.now();
        for (const cache of allCaches) {
            cache._sweep(now);
        }
    }, CLEANUP_MS);
    cleanupTimer.unref(); // Don't keep the process alive
}

export class LruCache<T> {
    private _maxEntries: number;
    private _ttlMs: number;
    private _map: Map<string, { value: T; at: number }>;
    private _lastSweep: number;

    constructor(opts?: LruCacheOptions) {
        this._maxEntries = (opts && opts.maxEntries) || 10000;
        this._ttlMs = (opts && opts.ttlMs) || 1800_000; // 30 min default
        this._map = new Map();
        this._lastSweep = Date.now();

        allCaches.add(this);
        ensureCleanupTimer();
    }

    // Store a value with the current timestamp.
    set(key: string, value: T): void {
        // Evict LRU if at capacity (first entry = oldest)
        if (this._map.size >= this._maxEntries) {
            const oldest = this._map.keys().next().value;
            if (oldest !== undefined) this._map.delete(oldest);
        }

        // Delete-then-set to move key to the end (most-recently-used)
        this._map.delete(key);
        this._map.set(key, { value, at: Date.now() });

        // Lazy sweep on write
        this._sweep(Date.now());
    }

    // Retrieve a value. Returns undefined if missing or expired.
    get(key: string): T | undefined {
        const entry = this._map.get(key);
        if (!entry) return undefined;

        // Check expiry
        if (Date.now() - entry.at > this._ttlMs) {
            this._map.delete(key);
            return undefined;
        }

        // Move to end (LRU promotion)
        this._map.delete(key);
        this._map.set(key, entry);
        return entry.value;
    }

    delete(key: string): boolean {
        return this._map.delete(key);
    }

    clear(): void {
        this._map.clear();
    }

    get size(): number {
        this._sweep(Date.now(), true);
        return this._map.size;
    }

    // Remove all expired entries. Called automatically on get/set and by
    // the shared cleanup timer. Safe to call externally.
    _sweep(now: number, force = false): void {
        // Only sweep every 60 seconds at most, unless forced
        if (!force && now - this._lastSweep < 60_000) return;
        this._lastSweep = now;

        const expiry = now - this._ttlMs;
        // Iterate in insertion order -- oldest first
        for (const [key, entry] of this._map) {
            if (entry.at < expiry) {
                this._map.delete(key);
            } else {
                // Since Map iteration is insertion-ordered and we re-insert
                // on get (moving entries to the end), once we hit a non-expired
                // entry we can stop -- all remaining entries are newer.
                break;
            }
        }
    }

    // Stop the cache and remove from shared cleanup.
    destroy(): void {
        allCaches.delete(this);
        if (allCaches.size === 0 && cleanupTimer) {
            clearInterval(cleanupTimer);
            cleanupTimer = null;
        }
        this._map.clear();
    }
}

