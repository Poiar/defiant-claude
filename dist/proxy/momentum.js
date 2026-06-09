'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
exports.sessionKey = void 0;
exports.record = record;
exports.getMomentum = getMomentum;
const lru_cache_1 = require("./lru-cache");
const TTL_MS = 30 * 60 * 1000;
const MAX_ENTRIES = 500;
const RING_SIZE = 5;
const cache = new lru_cache_1.LruCache({ ttlMs: TTL_MS, maxEntries: MAX_ENTRIES });
var session_key_1 = require("./session-key");
Object.defineProperty(exports, "sessionKey", { enumerable: true, get: function () { return session_key_1.sessionKey; } });
function record(sk, providerKey, model) {
    if (!sk)
        return;
    let entry = cache.get(sk);
    if (!entry) {
        entry = { decisions: [] };
    }
    entry.decisions.push({ providerKey, model, at: Date.now() });
    if (entry.decisions.length > RING_SIZE) {
        entry.decisions = entry.decisions.slice(-RING_SIZE);
    }
    cache.set(sk, entry);
}
function getMomentum(sk) {
    if (!sk)
        return null;
    const entry = cache.get(sk);
    if (!entry || entry.decisions.length === 0)
        return null;
    const counts = {};
    for (const d of entry.decisions) {
        counts[d.providerKey] = (counts[d.providerKey] || 0) + 1;
    }
    let preferredProvider = null;
    let maxCount = 0;
    for (const [provider, count] of Object.entries(counts)) {
        if (count > maxCount) {
            maxCount = count;
            preferredProvider = provider;
        }
    }
    return { preferredProvider: preferredProvider || '', confidence: maxCount };
}
