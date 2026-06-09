'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
exports.createRateLimiter = createRateLimiter;
const DEFAULT_MAX_PER_WINDOW = 500;
const DEFAULT_WINDOW_MS = 60_000; // 1 minute
const DEFAULT_MAX_ENTRIES = 10_000;
function createRateLimiter(opts) {
    const maxPerWindow = (opts && opts.maxPerWindow) || DEFAULT_MAX_PER_WINDOW;
    const windowMs = (opts && opts.windowMs) || DEFAULT_WINDOW_MS;
    const maxEntries = (opts && opts.maxEntries) || DEFAULT_MAX_ENTRIES;
    const entries = new Map(); // ip -> { count, windowStart }
    function check(ip) {
        const now = Date.now();
        let entry = entries.get(ip);
        if (!entry || now - entry.windowStart >= windowMs) {
            // New window -- evict LRU if at capacity and this is a new IP
            if (!entry && entries.size >= maxEntries) {
                const oldest = entries.keys().next().value;
                if (oldest !== undefined)
                    entries.delete(oldest);
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
    function status() {
        return { tracked: entries.size, maxEntries, maxPerWindow, windowMs };
    }
    return { check, status };
}
