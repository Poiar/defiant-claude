'use strict';

import { LruCache } from './lru-cache';
import { sessionKey } from './session-key';

const TTL_MS = 30 * 60 * 1000;
const MAX_ENTRIES = 500;
const RING_SIZE = 5;

interface Decision {
    providerKey: string;
    model: string;
    at: number;
}

interface MomentumEntry {
    decisions: Decision[];
}

interface MomentumResult {
    preferredProvider: string;
    confidence: number;
}

const cache = new LruCache<MomentumEntry>({ ttlMs: TTL_MS, maxEntries: MAX_ENTRIES });

export { sessionKey } from './session-key';

export function record(sk: string | null, providerKey: string, model: string): void {
    if (!sk) return;
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

export function getMomentum(sk: string | null): MomentumResult | null {
    if (!sk) return null;
    const entry = cache.get(sk);
    if (!entry || entry.decisions.length === 0) return null;

    const counts: Record<string, number> = {};
    for (const d of entry.decisions) {
        counts[d.providerKey] = (counts[d.providerKey] || 0) + 1;
    }

    let preferredProvider: string | null = null;
    let maxCount = 0;
    for (const [provider, count] of Object.entries(counts)) {
        if (count > maxCount) {
            maxCount = count;
            preferredProvider = provider;
        }
    }

    // Normalize as a ratio (0.0 -- 1.0) so the threshold isn't tied to RING_SIZE.
    return { preferredProvider: preferredProvider || '', confidence: maxCount / RING_SIZE };
}

