'use strict';

// Per-IP fixed-window rate limiter with LRU eviction.
// Tracks request counts per IP within a configurable time window. Entries
// auto-expire when the window rolls over. LRU eviction protects against
// memory exhaustion from a large number of distinct IPs.

interface RateLimiterOptions {
    maxPerWindow?: number;
    windowMs?: number;
    maxEntries?: number;
}

interface RateLimitResult {
    allowed: boolean;
    retryAfter?: number;
}

interface RateLimiterStatus {
    tracked: number;
    maxEntries: number;
    maxPerWindow: number;
    windowMs: number;
}

interface RateLimiterEntry {
    count: number;
    windowStart: number;
}

interface RateLimiter {
    check: (ip: string) => RateLimitResult;
    status: () => RateLimiterStatus;
}

const DEFAULT_MAX_PER_WINDOW = 500;
const DEFAULT_WINDOW_MS = 60_000; // 1 minute
const DEFAULT_MAX_ENTRIES = 10_000;

export function createRateLimiter(opts?: RateLimiterOptions): RateLimiter {
    const maxPerWindow = (opts && opts.maxPerWindow) || DEFAULT_MAX_PER_WINDOW;
    const windowMs = (opts && opts.windowMs) || DEFAULT_WINDOW_MS;
    const maxEntries = (opts && opts.maxEntries) || DEFAULT_MAX_ENTRIES;

    const entries = new Map<string, RateLimiterEntry>(); // ip -> { count, windowStart }

    function check(ip: string): RateLimitResult {
        const now = Date.now();
        let entry = entries.get(ip);

        if (!entry || now - entry.windowStart >= windowMs) {
            // New window -- evict LRU if at capacity and this is a new IP
            if (!entry && entries.size >= maxEntries) {
                const oldest = entries.keys().next().value;
                if (oldest !== undefined) entries.delete(oldest);
            }
            entries.set(ip, { count: 1, windowStart: now });
            return { allowed: true };
        }

        entry.count++;
        if (entry.count > maxPerWindow) {
            const retryAfter = Math.ceil((entry.windowStart + windowMs - now) / 1000);
            return { allowed: false, retryAfter };
        }

        return { allowed: true };
    }

    function status(): RateLimiterStatus {
        return { tracked: entries.size, maxEntries, maxPerWindow, windowMs };
    }

    return { check, status };
}

