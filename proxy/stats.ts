'use strict';

import fs from 'fs';
import path from 'path';
import os from 'os';
import type { StreamMetrics } from './stream-metrics';

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
// Helper: returns true when the failure rate exceeds the circuit-breaker
// threshold (>= 34 %) and there have been enough requests to judge.
function isFailureRateAboveThreshold(fails: number, requests: number): boolean {
    return requests >= 5 && (fails / requests) >= 0.34;
}

// Core stat recording -- increments counters and records timing.
// Never throws.
export function recordStat(providerKey: string | null | undefined, success: boolean, ms: number, statusCode?: number): void {
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
        // Exclude HTTP 429 (rate limited) from circuit breaker failure counting.
        // 429 means the provider is healthy but throttling us — opening the breaker
        // would block all requests and make the rate problem worse.
        if (!success && statusCode !== 429 && isFailureRateAboveThreshold(s.fails, s.requests)) {
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
    // Add circuit breaker state, streaming metrics, and spend data per provider
    const providers = base.providers as Record<string, Record<string, unknown>>;
    if (providers) {
        // Load spend data once for this snapshot
        let spendByProvider: Record<string, { todayAmount: number; dailyHistory: Record<string, number> }> | null = null;
        try {
            if (fs.existsSync(spendFile)) {
                const raw = fs.readFileSync(spendFile, 'utf-8');
                const data = JSON.parse(raw);
                const rawDaily = data.daily as Record<string, unknown> || {};
                const today = new Date().toISOString().slice(0, 10);
                spendByProvider = {};
                for (const [date, value] of Object.entries(rawDaily)) {
                    if (typeof value === 'object' && value !== null) {
                        const byProvider = (value as { byProvider?: Record<string, number> }).byProvider;
                        if (byProvider) {
                            for (const [pk, amt] of Object.entries(byProvider)) {
                                if (!spendByProvider[pk]) spendByProvider[pk] = { todayAmount: 0, dailyHistory: {} };
                                if (date === today) spendByProvider[pk].todayAmount += amt;
                                spendByProvider[pk].dailyHistory[date] = (spendByProvider[pk].dailyHistory[date] || 0) + amt;
                            }
                        }
                    }
                }
            }
        } catch (_) { /* non-fatal -- spend data omitted from snapshot */ }

        for (const k of Object.keys(providers)) {
            providers[k].circuitBreaker = getCircuitBreakerState(k);
            providers[k].lastRequest = providerStats[k] ? providerStats[k].lastRequest : undefined;
            const acc = streamAccumulators[k];
            if (acc) {
                providers[k].avgTTFT = acc.ttftCount > 0 ? Math.round(acc.totalTTFT / acc.ttftCount) : 0;
                providers[k].avgTPS = acc.tpsCount > 0 ? Math.round((acc.totalTPS / acc.tpsCount) * 100) / 100 : 0;
            } else {
                providers[k].avgTTFT = 0;
                providers[k].avgTPS = 0;
            }

            // Per-provider daily spend (persisted + pending in-memory)
            const persistedAmount = spendByProvider?.[k]?.todayAmount || 0;
            const pendingAmount = providerDailyAccumulators[k] || 0;
            const totalProviderSpend = parseFloat((persistedAmount + pendingAmount).toFixed(4));
            if (totalProviderSpend > 0) {
                providers[k].dailySpend = { amount: totalProviderSpend, currency: 'USD' };
            }

            // Monthly budget (from providers.json or DEFAULT_LIMITS)
            const budget = getMonthlyBudget(k);
            if (budget !== null) {
                providers[k].monthlyBudget = budget;
            }

            // Average daily spend over last 7 days for days-remaining estimate
            if (spendByProvider?.[k]) {
                let sum = 0;
                let count = 0;
                const today = new Date();
                for (let i = 0; i < 7; i++) {
                    const d = new Date(today);
                    d.setDate(d.getDate() - i);
                    const ds = d.toISOString().slice(0, 10);
                    const amt = spendByProvider[k].dailyHistory[ds] || 0;
                    if (amt > 0) { sum += amt; count++; }
                }
                if (count > 0) {
                    providers[k].avgDailySpend7d = parseFloat((sum / count).toFixed(4));
                }
            }
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
    if (!s) return true;
    return !isFailureRateAboveThreshold(s.fails, s.requests);
};

// Derive circuit breaker state from recorded stats or active breaker entry.
// Returns CLOSED, OPEN, or HALF_OPEN.
export function getCircuitBreakerState(providerKey: string): string {
    const entry = circuitBreakers[providerKey];
    if (entry) return entry.state;
    const s = providerStats[providerKey];
    if (!s) return 'CLOSED';
    return isFailureRateAboveThreshold(s.fails, s.requests) ? 'OPEN' : 'CLOSED';
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

// --- Streaming metric accumulators (per-provider) ---

interface StreamMetricAccumulator {
    totalTTFT: number;
    ttftCount: number;
    totalTPS: number;
    tpsCount: number;
}
const streamAccumulators: Record<string, StreamMetricAccumulator> = {};

// Record streaming performance metrics for a provider.  Never throws.
export function recordStreamMetrics(providerKey: string, metrics: StreamMetrics): void {
    if (!providerKey) return;
    try {
        if (!streamAccumulators[providerKey]) {
            streamAccumulators[providerKey] = { totalTTFT: 0, ttftCount: 0, totalTPS: 0, tpsCount: 0 };
        }
        const acc = streamAccumulators[providerKey];
        if (metrics.ttftMs > 0) {
            acc.totalTTFT += metrics.ttftMs;
            acc.ttftCount++;
        }
        if (metrics.tps > 0) {
            acc.totalTPS += metrics.tps;
            acc.tpsCount++;
        }
    } catch (_) {
        // Non-fatal -- recording should never crash the request.
    }
}

// --- Spend tracking ---

let spendFile = path.join(os.homedir(), '.deepclaude', 'spend.json');
let lastSpendWrite = 0;
let spendWriteLock = false;
const SPEND_WRITE_THROTTLE_MS = 1000;

let runningTotal = 0;
let sessionTotal = 0;
let dailyAccumulator = 0;
const providerDailyAccumulators: Record<string, number> = {};
let sessionCap = 0;
let sessionDailyBudget = 0;
let lastDailyRead = 0;
let cachedDailySpend = 0;
const BUDGET_CHECK_THROTTLE_MS = 1000;
const sessionStarted = new Date().toISOString();

let pricingData: Record<string, { input: number; output: number }> = {};
try { pricingData = require('./providers.json').pricing || {}; } catch (_) { /* continue without pricing */ }

// Monthly budget defaults for free-tier providers (used when providers.json has no monthlyBudget)
const DEFAULT_LIMITS: Record<string, number> = {
  or: 1.00,
  gr: 5.00,
  oc: 0.50,
  km: 1.00,
  mm: 1.00,
  um: 1.00,
  mt: 1.00,
  mx: 1.00,
  za: 1.00,
  bp: 1.00,
  sf: 1.00,
  nv: 1.00,
};

let providerMonthlyBudgets: Record<string, number> = {};
try {
  const providersData = require('./providers.json').providers || {};
  for (const [key, def] of Object.entries(providersData)) {
    const pDef = def as { monthlyBudget?: number };
    if (pDef.monthlyBudget !== undefined) {
      providerMonthlyBudgets[key] = pDef.monthlyBudget;
    }
  }
} catch (_) { /* continue without provider budgets */ }

function lookupPrice(modelName: string): { input: number; output: number } | null {
  if (pricingData[modelName]) return pricingData[modelName];
  const stripped = modelName.replace(/^[a-z][a-z0-9_-]*:/, '');
  if (stripped !== modelName && pricingData[stripped]) return pricingData[stripped];
  return null;
}

// Record per-provider spend in the in-memory accumulator.
// Never throws.
export function recordProviderSpend(providerKey: string, amount: number): void {
  if (!providerKey || amount <= 0) return;
  try {
    providerDailyAccumulators[providerKey] = (providerDailyAccumulators[providerKey] || 0) + amount;
  } catch (_) { /* non-fatal */ }
}

export async function recordSpend(modelName: string, usage: { prompt_tokens: number; completion_tokens: number }, providerKey?: string): Promise<void> {
  const price = lookupPrice(modelName);
  if (!price) return;

  const cost = (usage.prompt_tokens / 1_000_000) * price.input + (usage.completion_tokens / 1_000_000) * price.output;
  runningTotal += cost;
  sessionTotal += cost;
  dailyAccumulator += cost;
  if (providerKey) {
    recordProviderSpend(providerKey, cost);
  }

  const now = Date.now();
  if (now - lastSpendWrite < SPEND_WRITE_THROTTLE_MS) return;
  if (spendWriteLock) return;
  spendWriteLock = true;
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

    // Normalize daily entries (handle legacy number format and new object format)
    const rawDaily = (existing.daily as Record<string, unknown>) || {};
    const daily: Record<string, { total: number; byProvider: Record<string, number> }> = {};
    for (const [date, value] of Object.entries(rawDaily)) {
      if (typeof value === 'number') {
        daily[date] = { total: value, byProvider: {} };
      } else if (typeof value === 'object' && value !== null) {
        const entry = value as { total?: number; byProvider?: Record<string, number> };
        daily[date] = { total: entry.total ?? 0, byProvider: { ...(entry.byProvider || {}) } };
      }
    }

    // Update today's entry with accumulated totals
    const todayEntry = daily[today] || { total: 0, byProvider: {} };
    todayEntry.total = parseFloat((todayEntry.total + dailyAccumulator).toFixed(4));

    // Flush per-provider accumulators into today's byProvider breakdown
    for (const [pk, amount] of Object.entries(providerDailyAccumulators)) {
      if (amount > 0) {
        todayEntry.byProvider[pk] = parseFloat(((todayEntry.byProvider[pk] || 0) + amount).toFixed(4));
      }
    }
    daily[today] = todayEntry;

    const data = {
      total: parseFloat(runningTotal.toFixed(4)),
      daily,
      sessions: [{ started: sessionStarted, total: parseFloat(sessionTotal.toFixed(4)) }],
      current_model: modelName,
    };
    fs.writeFileSync(spendFile, JSON.stringify(data) + '\n');

    // Only clear accumulators AFTER a successful write to prevent data loss
    dailyAccumulator = 0;
    for (const pk of Object.keys(providerDailyAccumulators)) {
      delete providerDailyAccumulators[pk];
    }
  } catch (_) { /* non-fatal */ } finally {
    spendWriteLock = false;
  }
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
    const daily = data.daily as Record<string, unknown> | undefined;
    // Handle both legacy number format and new { total, byProvider } format
    let dailyTotal = 0;
    if (daily?.[today] !== undefined) {
      const entry = daily[today];
      if (typeof entry === 'number') {
        dailyTotal = entry;
      } else if (typeof entry === 'object' && entry !== null) {
        dailyTotal = (entry as { total?: number }).total ?? 0;
      }
    }
    cachedDailySpend = dailyTotal + dailyAccumulator;
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

// Get the monthly budget for a provider.
// Returns null for paid providers with no configured limit.
export function getMonthlyBudget(providerKey: string): number | null {
  if (providerMonthlyBudgets[providerKey] !== undefined) return providerMonthlyBudgets[providerKey];
  if (DEFAULT_LIMITS[providerKey] !== undefined) return DEFAULT_LIMITS[providerKey];
  return null;
}

export function _resetBudgetState(): void {
  sessionCap = 0;
  sessionDailyBudget = 0;
  sessionTotal = 0;
  runningTotal = 0;
  dailyAccumulator = 0;
  lastDailyRead = 0;
  cachedDailySpend = 0;
  for (const k of Object.keys(providerDailyAccumulators)) {
    delete providerDailyAccumulators[k];
  }
}

export function _setSessionTotal(val: number): void {
  sessionTotal = val;
}
