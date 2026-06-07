'use strict';

// Provider stats tracking with non-fatal recording.
// Every stat write is wrapped so a recording failure never crashes a request.

interface ProviderStat {
    requests: number;
    successes: number;
    fails: number;
    totalMs: number;
    lastRequest?: number;
    inputTokens: number;
    outputTokens: number;
}
export const providerStats: Record<string, ProviderStat> = {};
export const startTime: number = Date.now();

// Read version from package.json at the project root, fallback to hardcoded value.
let packageVersion: string = '3.1.3';
try { packageVersion = require('../package.json').version; } catch (_) { /* use fallback version */ }

let requestIdCounter: number = 0;
export function nextRequestId(): number {
    return ++requestIdCounter;
}
// Core stat recording -- increments counters and records timing.
// Never throws.
export function recordStat(providerKey: string | null | undefined, success: boolean, ms: number): void {
    if (!providerKey) return;
    try {
        if (!providerStats[providerKey]) {
            providerStats[providerKey] = { requests: 0, successes: 0, fails: 0, totalMs: 0, inputTokens: 0, outputTokens: 0 };
        }
        const s = providerStats[providerKey];
        s.requests++;
        s.totalMs += ms;
        s.lastRequest = Date.now();
        if (success) s.successes++; else s.fails++;
    } catch (_) {
        // Non-fatal -- recording should never crash the request.
    }
}
// Record token usage for a provider -- increments cumulative token counts.
// Never throws.
export function recordUsage(providerKey: string | null | undefined, inputTokens: number, outputTokens: number): void {
    if (!providerKey) return;
    try {
        if (!providerStats[providerKey]) {
            providerStats[providerKey] = { requests: 0, successes: 0, fails: 0, totalMs: 0, inputTokens: 0, outputTokens: 0 };
        }
        const s = providerStats[providerKey];
        s.inputTokens += inputTokens || 0;
        s.outputTokens += outputTokens || 0;
    } catch (_) {
        // Non-fatal -- recording should never crash the request.
    }
}
// Build health endpoint response -- normalized per-provider stats.
export function getHealthSnapshot(): { status: string; uptime: number; providers: Record<string, unknown> } {
    const healthStats: Record<string, unknown> = {};
    try {
        for (const [k, v] of Object.entries(providerStats)) {
            healthStats[k] = {
                requests: v.requests,
                successes: v.successes,
                fails: v.fails,
                avgMs: v.requests ? Math.round(v.totalMs / v.requests) : 0,
                inputTokens: v.inputTokens || 0,
                outputTokens: v.outputTokens || 0,
            };
        }
    } catch (_) {
        // Non-fatal -- return whatever we built so far.
    }
    return { status: 'ok', uptime: Date.now() - startTime, providers: healthStats };
}
// Build health endpoint response with concurrency, rate limiter, and version.
export function getFullHealthSnapshot(concurrencyStatus: unknown, rateLimiterStatus: unknown): Record<string, unknown> {
    const base: Record<string, unknown> = getHealthSnapshot();
    base.version = packageVersion;
    if (concurrencyStatus) {
        base.concurrency = concurrencyStatus;
    }
    if (rateLimiterStatus) {
        base.rateLimiter = rateLimiterStatus;
    }
    return base;
}
// Check whether a provider is healthy.
// Requires at least 2 requests before judging. A provider is unhealthy
// if more than a third of its requests have failed.
export function isProviderHealthy(providerKey: string): boolean {
    const s = providerStats[providerKey];
    if (!s || s.requests < 2) return true;
    return (s.fails / s.requests) < 0.34;
};
