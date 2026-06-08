'use strict';

import fs from 'fs';
import path from 'path';
import os from 'os';

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
const providerStats: Record<string, ProviderStat> = {};
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
// Build health endpoint response with concurrency, rate limiter, version, process memory,
// circuit breaker state, spend totals, and recent requests.
export function getFullHealthSnapshot(concurrencyStatus: unknown, rateLimiterStatus: unknown): Record<string, unknown> {
    const base: Record<string, unknown> = getHealthSnapshot();
    base.version = packageVersion;
    if (concurrencyStatus) {
        base.concurrency = concurrencyStatus;
    }
    if (rateLimiterStatus) {
        base.rateLimiter = rateLimiterStatus;
    }
    // Add circuit breaker state per provider
    const providers = base.providers as Record<string, Record<string, unknown>>;
    if (providers) {
        for (const k of Object.keys(providers)) {
            providers[k].circuitBreaker = getCircuitBreakerState(k);
            providers[k].lastRequest = providerStats[k] ? providerStats[k].lastRequest : undefined;
        }
    }
    // Spend and recent requests
    base.spend = parseFloat(sessionTotal.toFixed(4));
    base.recentRequests = recentRequests.slice().reverse();
    try {
        const mem = process.memoryUsage();
        base.memory = {
            heapUsed: Math.round((mem.heapUsed / 1024 / 1024) * 100) / 100,
            heapTotal: Math.round((mem.heapTotal / 1024 / 1024) * 100) / 100,
            rss: Math.round((mem.rss / 1024 / 1024) * 100) / 100,
            external: Math.round((mem.external / 1024 / 1024) * 100) / 100,
        };
    } catch (_) {
        // Non-fatal -- memory stats should never crash a health check.
    }
    return base;
}
// Check whether a provider is healthy.
// Requires at least 5 requests before judging. A provider is unhealthy
// if more than a third of its requests have failed.
export function isProviderHealthy(providerKey: string): boolean {
    const s = providerStats[providerKey];
    if (!s || s.requests < 5) return true;
    return (s.fails / s.requests) < 0.34;
};

// Derive circuit breaker state from recorded stats.
export function getCircuitBreakerState(providerKey: string): string {
    const s = providerStats[providerKey];
    if (!s || s.requests < 5) return 'CLOSED';
    return (s.fails / s.requests) >= 0.34 ? 'OPEN' : 'CLOSED';
}

// --- Recent request ring buffer ---

interface RecentRequestEntry {
    timestamp: number;
    model: string | null;
    provider: string;
    status: number | null;
    ms: number;
    tokens: { input: number; output: number } | null;
    fallback: boolean;
}

const MAX_RECENT_REQUESTS = 50;
const recentRequests: RecentRequestEntry[] = [];

// Append a request entry. Never throws.
export function recordRecentRequest(entry: RecentRequestEntry): void {
    try {
        recentRequests.push(entry);
        if (recentRequests.length > MAX_RECENT_REQUESTS) {
            recentRequests.shift();
        }
    } catch (_) {
        // Non-fatal -- recording should never crash the request.
    }
}

// --- Spend tracking ---

const spendFile = path.join(os.homedir(), '.deepclaude', 'spend.json');
let lastSpendWrite = 0;
const SPEND_WRITE_THROTTLE_MS = 1000;

let runningTotal = 0;
let sessionTotal = 0;
const sessionStarted = new Date().toISOString();

let pricingData: Record<string, { input: number; output: number }> = {};
try { pricingData = require('./providers.json').pricing || {}; } catch (_) { /* continue without pricing */ }

function lookupPrice(modelName: string): { input: number; output: number } | null {
  if (pricingData[modelName]) return pricingData[modelName];
  const stripped = modelName.replace(/^[a-z][a-z0-9_-]*:/, '');
  if (stripped !== modelName && pricingData[stripped]) return pricingData[stripped];
  return null;
}

export async function recordSpend(modelName: string, usage: { prompt_tokens: number; completion_tokens: number }): Promise<void> {
  const price = lookupPrice(modelName);
  if (!price) return;

  const cost = (usage.prompt_tokens / 1_000_000) * price.input + (usage.completion_tokens / 1_000_000) * price.output;
  runningTotal += cost;
  sessionTotal += cost;

  const now = Date.now();
  if (now - lastSpendWrite < SPEND_WRITE_THROTTLE_MS) return;
  lastSpendWrite = now;

  try {
    const spendDir = path.dirname(spendFile);
    if (!fs.existsSync(spendDir)) {
      fs.mkdirSync(spendDir, { recursive: true });
    }
    const data = {
      total: parseFloat(runningTotal.toFixed(4)),
      sessions: [{ started: sessionStarted, total: parseFloat(sessionTotal.toFixed(4)) }],
      current_model: modelName,
    };
    fs.writeFileSync(spendFile, JSON.stringify(data) + '\n');
  } catch (_) { /* non-fatal */ }
}
