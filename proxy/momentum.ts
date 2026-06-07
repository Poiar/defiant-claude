'use strict';

import crypto from 'node:crypto';
import { LruCache } from './lru-cache';

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

const cache = new LruCache({ ttlMs: TTL_MS, maxEntries: MAX_ENTRIES });

export function sessionKey(reqBody: Record<string, unknown> | null | undefined): string | null {
    if (!reqBody || !reqBody.messages) return null;
    const messages = reqBody.messages as Array<Record<string, unknown>>;
    const firstUserMsg = messages.find(m => m.role === 'user');
    if (!firstUserMsg) return null;
    const content = typeof firstUserMsg.content === 'string'
        ? firstUserMsg.content
        : Array.isArray(firstUserMsg.content)
            ? (firstUserMsg.content as Array<Record<string, unknown>>).map(b => String(b.text || '')).join('')
            : '';
    const systemHint = reqBody.system
        ? (typeof reqBody.system === 'string'
            ? reqBody.system
            : Array.isArray(reqBody.system)
                ? (reqBody.system as Array<Record<string, unknown>>).map(b => String(b.text || '')).join('')
                : ''
          ).slice(0, 100)
        : '';
    return crypto.createHash('sha256').update(content + '|' + systemHint).digest('hex').slice(0, 32);
}

export function record(sk: string | null, providerKey: string, model: string): void {
    if (!sk) return;
    let entry = cache.get(sk) as MomentumEntry | undefined;
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
    const entry = cache.get(sk) as MomentumEntry | undefined;
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

    return { preferredProvider: preferredProvider || '', confidence: maxCount };
}

export function shouldStick(sk: string | null, candidateProvider: string): boolean {
    if (!sk) return false;
    const entry = cache.get(sk) as MomentumEntry | undefined;
    if (!entry || entry.decisions.length < 3) return false;

    const lastDecisions = entry.decisions.slice(-3);
    const firstProvider = lastDecisions[0].providerKey;
    if (firstProvider === candidateProvider) return false;

    for (const d of lastDecisions) {
        if (d.providerKey !== firstProvider) return false;
    }

    return true;
}

