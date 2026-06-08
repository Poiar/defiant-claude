'use strict';

import fs from 'fs';
import path from 'path';
import os from 'os';

// Provider stats tracking with non-fatal recording.
// Every stat write is wrapped so a recording failure never crashes a request.

// Circuit breaker state machine with auto-probe support.
// When a provider's failure rate exceeds the threshold, the breaker opens.
// After a cooldown, the breaker transitions to HALF_OPEN and sends a probe
// request. If the probe succeeds, the breaker closes; if it fails, the
// cooldown doubles and the cycle repeats up to MAX_PROBES attempts.

const DEFAULT_COOLDOWN_MS = 60_000;
const MAX_COOLDOWN_MS = 300_000;
const MAX_PROBES = 5;

type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

interface CircuitBreakerEntry {
    state: BreakerState;
    openedAt: number;
    cooldownMs: number;
    probeCount: number;
    consecutiveProbeFailures: number;
}

interface ProviderInfo {
    url: string;
    key: string | null | undefined;
    isBearer: boolean;
    format: string;
    model: string;
}

const circuitBreakers: Record<string, CircuitBreakerEntry> = {};
const providersInfo: Record<string, ProviderInfo> = {};

export function openCircuitBreaker(providerKey: string): void {
    const existing = circuitBreakers[providerKey];
    if (existing && existing.state !== 'CLOSED') return;
    circuitBreakers[providerKey] = {
        state: 'OPEN',
        openedAt: Date.now(),
        cooldownMs: DEFAULT_COOLDOWN_MS,
        probeCount: 0,
        consecutiveProbeFailures: 0,
    };
}

export function maybeStartProbe(providerKey: string): { url: string; key: string | null | undefined; isBearer: boolean; format: string; model: string } | null {
    const entry = circuitBreakers[providerKey];
    if (!entry || entry.state !== 'OPEN') return null;
    if (entry.probeCount >= MAX_PROBES) return null;
    if (Date.now() - entry.openedAt < entry.cooldownMs) return null;
    entry.state = 'HALF_OPEN';
    entry.probeCount++;
    const info = providersInfo[providerKey];
    if (!info) return null;
    return { url: info.url, key: info.key, isBearer: info.isBearer, format: info.format, model: info.model };
}

export function recordProbeResult(providerKey: string, success: boolean): void {
    const entry = circuitBreakers[providerKey];
    if (!entry || entry.state !== 'HALF_OPEN') return;
    if (success) {
        entry.state = 'CLOSED';
        entry.cooldownMs = DEFAULT_COOLDOWN_MS;
        entry.probeCount = 0;
        entry.consecutiveProbeFailures = 0;
        entry.openedAt = 0;
        delete circuitBreakers[providerKey];
    } else {
        entry.state = 'OPEN';
        entry.openedAt = Date.now();
        entry.cooldownMs = Math.min(entry.cooldownMs * 2, MAX_COOLDOWN_MS);
        entry.consecutiveProbeFailures++;
    }
}

export function getBreakerState(providerKey: string): BreakerState {
    const entry = circuitBreakers[providerKey];
    if (entry) return entry.state;
    return 'CLOSED';
}

export function getBreakerEntry(providerKey: string): CircuitBreakerEntry | undefined {
    return circuitBreakers[providerKey];
}

export function registerProviderInfo(providerKey: string, info: ProviderInfo): void {
    providersInfo[providerKey] = info;
}

export function getProviderInfo(providerKey: string): ProviderInfo | undefined {
    return providersInfo[providerKey];
}

export function getRegisteredProviderKeys(): string[] {
    return Object.keys(providersInfo);
}

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
let packageVersion: string = '1.0.0';
try { packageVersion = require('../package.json').version; } catch (_) { /* use fallback version */ }

// Git hash is set once at startup by start-proxy.ts. Default to 'unknown' when unavailable.
let gitHash: string = 'unknown';
export function setGitHash(hash: string): void { gitHash = hash; }

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
        if (!success && s.requests >= 5 && (s.fails / s.requests) >= 0.34) {
            openCircuitBreaker(providerKey);
        }
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
    base.version = packageVersion + ' (' + gitHash + ')';
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
// if more than a third of its requests have failed or the circuit breaker
// is OPEN. HALF_OPEN is treated as healthy (probe traffic is the test).
export function isProviderHealthy(providerKey: string): boolean {
    const entry = circuitBreakers[providerKey];
    if (entry) {
        if (entry.state === 'OPEN') return false;
        if (entry.state === 'HALF_OPEN') return true;
    }
    const s = providerStats[providerKey];
    if (!s || s.requests < 5) return true;
    return (s.fails / s.requests) < 0.34;
};

// Derive circuit breaker state from recorded stats or active breaker entry.
// Returns CLOSED, OPEN, or HALF_OPEN.
export function getCircuitBreakerState(providerKey: string): string {
    const entry = circuitBreakers[providerKey];
    if (entry) return entry.state;
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

let spendFile = path.join(os.homedir(), '.deepclaude', 'spend.json');
let lastSpendWrite = 0;
const SPEND_WRITE_THROTTLE_MS = 1000;

let runningTotal = 0;
let sessionTotal = 0;
let dailyAccumulator = 0;
let sessionCap = 0;
let sessionDailyBudget = 0;
let lastDailyRead = 0;
let cachedDailySpend = 0;
const BUDGET_CHECK_THROTTLE_MS = 1000;
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
  dailyAccumulator += cost;

  const now = Date.now();
  if (now - lastSpendWrite < SPEND_WRITE_THROTTLE_MS) return;
  lastSpendWrite = now;

  try {
    const spendDir = path.dirname(spendFile);
    if (!fs.existsSync(spendDir)) {
      fs.mkdirSync(spendDir, { recursive: true });
    }
    const existing: Record<string, unknown> = {};
    if (fs.existsSync(spendFile)) {
      try {
        const raw = fs.readFileSync(spendFile, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed.total !== undefined) existing.total = parsed.total;
        if (parsed.sessions) existing.sessions = parsed.sessions;
        if (parsed.current_model) existing.current_model = parsed.current_model;
        if (parsed.daily) existing.daily = parsed.daily;
      } catch (_) { /* ignore corrupt file */ }
    }
    const today = new Date().toISOString().slice(0, 10);
    const daily: Record<string, number> = (existing.daily as Record<string, number>) || {};
    daily[today] = (daily[today] || 0) + dailyAccumulator;
    dailyAccumulator = 0;
    const data = {
      total: parseFloat(runningTotal.toFixed(4)),
      daily,
      sessions: [{ started: sessionStarted, total: parseFloat(sessionTotal.toFixed(4)) }],
      current_model: modelName,
    };
    fs.writeFileSync(spendFile, JSON.stringify(data) + '\n');
  } catch (_) { /* non-fatal */ }
}

// --- Spend budget caps ---

export function setSessionCap(dollars: number): void {
  sessionCap = dollars;
}

export function setDailyBudget(dollars: number): void {
  sessionDailyBudget = dollars;
}

export function getDailySpend(): number {
  const now = Date.now();
  if (now - lastDailyRead < BUDGET_CHECK_THROTTLE_MS) {
    return cachedDailySpend;
  }
  lastDailyRead = now;
  try {
    if (!fs.existsSync(spendFile)) {
      cachedDailySpend = 0;
      return 0;
    }
    const raw = fs.readFileSync(spendFile, 'utf-8');
    const data = JSON.parse(raw);
    const today = new Date().toISOString().slice(0, 10);
    const daily = data.daily as Record<string, number> | undefined;
    cachedDailySpend = (daily?.[today] ?? 0) + dailyAccumulator;
    return cachedDailySpend;
  } catch (_) {
    cachedDailySpend = 0;
    return 0;
  }
}

export function checkBudget(): string | null {
  if (sessionCap > 0 && sessionTotal >= sessionCap) {
    return 'Session cap of $' + sessionCap.toFixed(2) + ' exceeded ($' + sessionTotal.toFixed(2) + ' spent this session)';
  }
  if (sessionDailyBudget > 0) {
    const dailySpend = getDailySpend();
    if (dailySpend >= sessionDailyBudget) {
      return 'Daily budget of $' + sessionDailyBudget.toFixed(2) + ' exceeded ($' + dailySpend.toFixed(2) + ' spent today)';
    }
  }
  return null;
}

// Testing support
export function setSpendFilePath(p: string): void {
  spendFile = p;
}

export function _resetBudgetState(): void {
  sessionCap = 0;
  sessionDailyBudget = 0;
  sessionTotal = 0;
  runningTotal = 0;
  dailyAccumulator = 0;
  lastDailyRead = 0;
  cachedDailySpend = 0;
}

export function _setSessionTotal(val: number): void {
  sessionTotal = val;
}
