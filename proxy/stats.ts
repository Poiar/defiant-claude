'use strict';

import fs from 'fs';
import path from 'path';
import os from 'os';
import type { StreamMetrics } from './stream-metrics';
import { createLogger } from './log';

const log = createLogger('stats');

/** Format a Date as ISO YYYY-MM-DD using local time fields. */
function dateISO(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Today's date in ISO format from local time. Used as the daily spend key everywhere. */
function todayISO(): string {
  return dateISO(new Date());
}

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

export function maybeStartProbe(providerKey: string): {
  url: string;
  key: string | null | undefined;
  isBearer: boolean;
  format: string;
  model: string;
} | null {
  const entry = circuitBreakers[providerKey];
  if (!entry || entry.state !== 'OPEN') return null;
  if (entry.probeCount >= MAX_PROBES) {
    // After exhausting probes, use a long cooldown (5 min) and allow another round.
    if (Date.now() - entry.openedAt < 300_000) return null;
    entry.probeCount = 0;
    entry.cooldownMs = DEFAULT_COOLDOWN_MS;
  }
  if (Date.now() - entry.openedAt < entry.cooldownMs) return null;
  entry.state = 'HALF_OPEN';
  entry.probeCount++;
  const info = providersInfo[providerKey];
  if (!info) return null;
  return {
    url: info.url,
    key: info.key,
    isBearer: info.isBearer,
    format: info.format,
    model: info.model,
  };
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

// Remove circuit breaker state for providers that no longer exist.
// Called after a routes/config reload to prevent stale breaker state
// from affecting newly loaded providers.
export function reconcileCircuitBreakers(providerKeys: Set<string>): void {
  for (const key of Object.keys(circuitBreakers)) {
    if (!providerKeys.has(key)) {
      delete circuitBreakers[key];
    }
  }
}

// Remove provider stats entries for providers that no longer exist.
// Called after a routes/config reload to keep providerStats in sync.
export function reconcileProviderStats(providerKeys: Set<string>): void {
  for (const key of Object.keys(providerStats)) {
    if (!providerKeys.has(key)) {
      delete providerStats[key];
    }
  }
  for (const key of Object.keys(streamAccumulators)) {
    if (!providerKeys.has(key)) {
      delete streamAccumulators[key];
    }
  }
}

// Reload pricing data from providers.json (e.g., after a hot-reload updates
// the file).  Clears the require cache so the new data is picked up.
export function reloadPricing(): void {
  try {
    const filePath = require.resolve('./providers.json');
    delete require.cache[filePath];
    const data = require('./providers.json');
    pricingData = data.pricing || {};
    // Also refresh monthly budgets from the reloaded providers.json
    providerMonthlyBudgets = {};
    const providersData = data.providers || {};
    for (const [key, def] of Object.entries(providersData)) {
      const pDef = def as { monthlyBudget?: number };
      if (pDef.monthlyBudget !== undefined) {
        providerMonthlyBudgets[key] = pDef.monthlyBudget;
      }
    }
  } catch (_) {
    // continue without pricing
  }
}

interface ProviderStat {
  requests: number;
  successes: number;
  fails: number;
  totalMs: number;
  lastRequest?: number;
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
}
const providerStats: Record<string, ProviderStat> = {};
export const startTime: number = Date.now();

// --- Event loop lag monitoring ---
// Use a 1-second interval to measure how long the event loop is stalled.
const LAG_CHECK_MS = 1000;
let lagScheduledAt = Date.now();
let maxEventLoopLag = 0;
setInterval(() => {
  const now = Date.now();
  const lag = Math.max(0, now - lagScheduledAt - LAG_CHECK_MS);
  if (lag > maxEventLoopLag) maxEventLoopLag = lag;
  lagScheduledAt = now;
}, LAG_CHECK_MS);
// Reset max lag every minute so the health endpoint always reports
// the worst lag observed in the last rolling minute.
setInterval(() => {
  maxEventLoopLag = 0;
}, 60_000);

// Read version from package.json at the project root, fallback to hardcoded value.
let packageVersion: string = '1.0.0';
try {
  packageVersion = require('../package.json').version;
} catch (_) {
  /* use fallback version */
}

// Git hash is set once at startup by start-proxy.ts. Default to 'unknown' when unavailable.
let gitHash: string = 'unknown';
export function setGitHash(hash: string): void {
  gitHash = hash;
}

let requestIdCounter: number = 0;
export function nextRequestId(): number {
  return ++requestIdCounter;
}
// Helper: returns true when the failure rate exceeds the circuit-breaker
// threshold (>= 34 %) and there have been enough requests to judge.
function isFailureRateAboveThreshold(fails: number, requests: number): boolean {
  return requests >= 5 && fails / requests >= 0.34;
}

// Core stat recording -- increments counters and records timing.
// Never throws.
export function recordStat(
  providerKey: string | null | undefined,
  success: boolean,
  ms: number,
  statusCode?: number,
): void {
  if (!providerKey) return;
  try {
    if (!providerStats[providerKey]) {
      providerStats[providerKey] = {
        requests: 0,
        successes: 0,
        fails: 0,
        totalMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheHitTokens: 0,
        cacheMissTokens: 0,
      };
    }
    const s = providerStats[providerKey];
    s.requests++;
    s.totalMs += ms;
    s.lastRequest = Date.now();
    if (success) s.successes++;
    else if (statusCode !== 429) s.fails++;
    // Do NOT count HTTP 429 (rate limited) as a failure. Rate limiting means the
    // provider is healthy and responsive — just throttling us. Counting 429s as
    // failures inflates the failure rate and causes false circuit breaker opens:
    // 19 of 20 requests returning 429 would show 95% failure rate when the real
    // non-429 failure rate is only 5%. Opening the breaker then blocks ALL requests
    // to a healthy provider, making the rate problem worse by routing to fallbacks.
    if (!success && statusCode !== 429 && isFailureRateAboveThreshold(s.fails, s.requests)) {
      openCircuitBreaker(providerKey);
    }
  } catch (_) {
    // Non-fatal -- recording should never crash the request.
  }
}
// Record token usage for a provider -- increments cumulative token counts.
// Never throws.
export function recordUsage(
  providerKey: string | null | undefined,
  inputTokens: number,
  outputTokens: number,
): void {
  if (!providerKey) return;
  try {
    if (!providerStats[providerKey]) {
      providerStats[providerKey] = {
        requests: 0,
        successes: 0,
        fails: 0,
        totalMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheHitTokens: 0,
        cacheMissTokens: 0,
      };
    }
    const s = providerStats[providerKey];
    s.inputTokens += inputTokens || 0;
    s.outputTokens += outputTokens || 0;
  } catch (_) {
    // Non-fatal -- recording should never crash the request.
  }
}
// Build health endpoint response -- normalized per-provider stats.
export function getHealthSnapshot(): {
  status: string;
  uptime: number;
  providers: Record<string, unknown>;
} {
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
export function getFullHealthSnapshot(
  concurrencyStatus: unknown,
  rateLimiterStatus: unknown,
): Record<string, unknown> {
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
    let spendByProvider: Record<
      string,
      { todayAmount: number; dailyHistory: Record<string, number> }
    > | null = null;
    try {
      if (fs.existsSync(spendFile)) {
        const raw = fs.readFileSync(spendFile, 'utf-8');
        const data = JSON.parse(raw);
        const rawDaily = (data.daily as Record<string, unknown>) || {};
        const today = todayISO();
        spendByProvider = {};
        for (const [date, value] of Object.entries(rawDaily)) {
          if (typeof value === 'object' && value !== null) {
            const byProvider = (value as { byProvider?: Record<string, number> }).byProvider;
            if (byProvider) {
              for (const [pk, amt] of Object.entries(byProvider)) {
                if (!spendByProvider[pk])
                  spendByProvider[pk] = { todayAmount: 0, dailyHistory: {} };
                if (date === today) spendByProvider[pk].todayAmount += amt;
                spendByProvider[pk].dailyHistory[date] =
                  (spendByProvider[pk].dailyHistory[date] || 0) + amt;
              }
            }
          }
        }
      }
    } catch (_) {
      /* non-fatal -- spend data omitted from snapshot */
    }

    for (const k of Object.keys(providers)) {
      providers[k].circuitBreaker = getCircuitBreakerState(k);
      providers[k].lastRequest = providerStats[k] ? providerStats[k].lastRequest : undefined;
      const acc = streamAccumulators[k];
      if (acc) {
        providers[k].avgTTFT = acc.ttftCount > 0 ? Math.round(acc.totalTTFT / acc.ttftCount) : 0;
        providers[k].avgTPS =
          acc.tpsCount > 0 ? Math.round((acc.totalTPS / acc.tpsCount) * 100) / 100 : 0;
      } else {
        providers[k].avgTTFT = 0;
        providers[k].avgTPS = 0;
      }

      const hit = providerStats[k]?.cacheHitTokens || 0;
      const miss = providerStats[k]?.cacheMissTokens || 0;
      const cacheTotal = hit + miss;
      if (cacheTotal > 0) {
        providers[k].cacheHitRate = parseFloat(((hit / cacheTotal) * 100).toFixed(1));
      }

      // Per-provider daily spend (persisted + pending in-memory).
      // Accumulators may have composite keys like "ds:deepseek-v4-pro" —
      // aggregate all entries matching this provider key prefix.
      let persistedAmount = 0;
      if (spendByProvider) {
        for (const [spk, spv] of Object.entries(spendByProvider)) {
          if (spk === k || spk.startsWith(k + ':')) persistedAmount += spv.todayAmount || 0;
        }
      }
      let pendingAmount = 0;
      for (const [accKey, accAmt] of Object.entries(providerDailyAccumulators)) {
        if (accKey === k || accKey.startsWith(k + ':')) pendingAmount += accAmt;
      }
      const totalProviderSpend = parseFloat((persistedAmount + pendingAmount).toFixed(4));
      if (totalProviderSpend > 0) {
        providers[k].dailySpend = { amount: totalProviderSpend, currency: 'USD' };
      }

      // Monthly budget (from providers.json or DEFAULT_LIMITS)
      const budget = getMonthlyBudget(k);
      if (budget !== null) {
        providers[k].monthlyBudget = budget;
      }

      // Average daily spend over last 7 days for days-remaining estimate.
      // Aggregate across all per-model entries for this provider (composite keys like "ds:deepseek-v4-pro").
      if (spendByProvider) {
        let sum = 0;
        let count = 0;
        const today = new Date();
        for (const [spk, spv] of Object.entries(spendByProvider)) {
          if (spk === k || spk.startsWith(k + ':')) {
            for (let i = 0; i < 7; i++) {
              const d = new Date(today);
              d.setDate(d.getDate() - i);
              const ds = dateISO(d);
              const amt = spv.dailyHistory[ds] || 0;
              if (amt > 0) {
                sum += amt;
                count++;
              }
            }
          }
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
      eventLoopLagMs: maxEventLoopLag,
    };
  } catch (_) {
    // Non-fatal -- memory stats should never crash a health check.
  }
  base.lastFallback = lastFallback || undefined;

  // Budget warning: yellow flag when session spend passes threshold
  const budgetWarn = process.env.DEEPCLAUDE_BUDGET_WARNING;
  if (budgetWarn) {
    const limit = parseFloat(budgetWarn);
    if (!isNaN(limit) && limit > 0) {
      const pct = sessionTotal / limit;
      if (pct >= 1) {
        base.budgetWarning = {
          level: 'red',
          message: 'Spend cap reached: $' + sessionTotal.toFixed(2),
        };
      } else if (pct >= 0.75) {
        base.budgetWarning = {
          level: 'yellow',
          message: 'Budget: $' + sessionTotal.toFixed(2) + ' / $' + limit.toFixed(2),
        };
      } else if (pct >= 0.5) {
        base.budgetWarning = { level: 'info', message: 'Budget: $' + sessionTotal.toFixed(2) };
      }
    }
  }
  return base;
}

// Track the most recent fallback for health/status visibility
let lastFallback: { from: string; to: string; at: string } | null = null;
export function recordFallback(from: string, to: string): void {
  lastFallback = { from, to, at: new Date().toISOString() };
}

// Build Prometheus-format metrics. Counters and gauges for standard
// monitoring stacks (Prometheus, Grafana, Datadog OpenMetrics, etc.).
export function buildPrometheusMetrics(
  concurrencyStatus: unknown,
  rateLimiterStatus: unknown,
): string {
  const lines: string[] = [];
  const pf = 'deepclaude';
  const now = Date.now();

  // Uptime
  lines.push(`# HELP ${pf}_uptime_seconds Proxy uptime in seconds`);
  lines.push(`# TYPE ${pf}_uptime_seconds gauge`);
  lines.push(`${pf}_uptime_seconds ${((now - startTime) / 1000).toFixed(1)}`);

  // Process
  const mem = process.memoryUsage();
  lines.push(`# HELP ${pf}_memory_bytes Node.js process memory`);
  lines.push(`# TYPE ${pf}_memory_bytes gauge`);
  lines.push(`${pf}_memory_bytes{type="heapUsed"} ${mem.heapUsed}`);
  lines.push(`${pf}_memory_bytes{type="heapTotal"} ${mem.heapTotal}`);
  lines.push(`${pf}_memory_bytes{type="rss"} ${mem.rss}`);
  lines.push(`# HELP ${pf}_event_loop_lag_ms Max event loop lag in last 60s`);
  lines.push(`# TYPE ${pf}_event_loop_lag_ms gauge`);
  lines.push(`${pf}_event_loop_lag_ms ${maxEventLoopLag}`);

  // Concurrency
  if (concurrencyStatus) {
    const cs = concurrencyStatus as Record<
      string,
      { active: number; waiting: number; limit: number }
    >;
    lines.push(`# HELP ${pf}_concurrency_active Active slots per pool`);
    lines.push(`# TYPE ${pf}_concurrency_active gauge`);
    for (const [pool, s] of Object.entries(cs)) {
      lines.push(`${pf}_concurrency_active{pool="${pool}"} ${s.active}`);
    }
    lines.push(`# HELP ${pf}_concurrency_waiting Waiting slots per pool`);
    lines.push(`# TYPE ${pf}_concurrency_waiting gauge`);
    for (const [pool, s] of Object.entries(cs)) {
      lines.push(`${pf}_concurrency_waiting{pool="${pool}"} ${s.waiting}`);
    }
  }

  // Rate limiter
  if (rateLimiterStatus) {
    const rls = rateLimiterStatus as { tracked: number };
    lines.push(`# HELP ${pf}_rate_limit_tracked Tracked IPs`);
    lines.push(`# TYPE ${pf}_rate_limit_tracked gauge`);
    lines.push(`${pf}_rate_limit_tracked ${rls.tracked}`);
  }

  // Providers
  const spend = parseFloat(sessionTotal.toFixed(4));
  lines.push(`# HELP ${pf}_spend_session_dollars Session spend in USD`);
  lines.push(`# TYPE ${pf}_spend_session_dollars gauge`);
  lines.push(`${pf}_spend_session_dollars ${spend}`);

  for (const [k, v] of Object.entries(providerStats)) {
    const label = `provider="${k}"`;
    const state = getCircuitBreakerState(k);
    lines.push(`# HELP ${pf}_requests_total Request count per provider`);
    lines.push(`# TYPE ${pf}_requests_total counter`);
    lines.push(`${pf}_requests_total{${label}} ${v.requests}`);
    lines.push(`# HELP ${pf}_requests_success_total Success count per provider`);
    lines.push(`# TYPE ${pf}_requests_success_total counter`);
    lines.push(`${pf}_requests_success_total{${label}} ${v.successes}`);
    lines.push(`# HELP ${pf}_requests_fail_total Failure count per provider`);
    lines.push(`# TYPE ${pf}_requests_fail_total counter`);
    lines.push(`${pf}_requests_fail_total{${label}} ${v.fails}`);
    lines.push(`# HELP ${pf}_latency_avg_ms Average latency per provider`);
    lines.push(`# TYPE ${pf}_latency_avg_ms gauge`);
    lines.push(
      `${pf}_latency_avg_ms{${label}} ${v.requests ? Math.round(v.totalMs / v.requests) : 0}`,
    );
    lines.push(
      `# HELP ${pf}_circuit_breaker_state Circuit breaker (0=CLOSED, 1=OPEN, 2=HALF_OPEN)`,
    );
    lines.push(`# TYPE ${pf}_circuit_breaker_state gauge`);
    lines.push(
      `${pf}_circuit_breaker_state{${label}} ${state === 'OPEN' ? 1 : state === 'HALF_OPEN' ? 2 : 0}`,
    );

    const acc = streamAccumulators[k];
    if (acc) {
      lines.push(`# HELP ${pf}_ttft_avg_ms Average time to first token`);
      lines.push(`# TYPE ${pf}_ttft_avg_ms gauge`);
      lines.push(
        `${pf}_ttft_avg_ms{${label}} ${acc.ttftCount > 0 ? Math.round(acc.totalTTFT / acc.ttftCount) : 0}`,
      );
    }
  }

  // Active connections
  lines.push(`# HELP ${pf}_active_connections Current active HTTP connections`);
  lines.push(`# TYPE ${pf}_active_connections gauge`);
  lines.push(`${pf}_active_connections ${activeConnections}`);

  return lines.join('\n') + '\n';
}
// Check whether a provider is healthy.
// Requires at least 5 requests before judging. A provider is unhealthy
// if more than a third of its requests have failed or the circuit breaker
// is OPEN. HALF_OPEN is treated as healthy (probe traffic is the test).
// UNTESTED providers (no requests yet) are allowed through but are
// visually distinguishable in the health endpoint.
export function isProviderHealthy(providerKey: string): boolean {
  const state = getCircuitBreakerState(providerKey);
  if (state === 'OPEN') return false;
  // HALF_OPEN: a probe is in-flight — don't send production traffic
  // until the probe confirms the provider is actually reachable again.
  if (state === 'HALF_OPEN') return false;
  return true;
}

// Derive circuit breaker state from recorded stats or active breaker entry.
// Returns CLOSED, OPEN, HALF_OPEN, or UNTESTED.
export function getCircuitBreakerState(providerKey: string): string {
  const entry = circuitBreakers[providerKey];
  if (entry) return entry.state;
  // Only the circuit breaker state machine (opened by recordStat when the
  // failure threshold is crossed) controls OPEN/HALF_OPEN.  Providers
  // without an explicit breaker entry are CLOSED until the breaker trips.
  const s = providerStats[providerKey];
  if (!s || s.requests === 0) return 'UNTESTED';
  return 'CLOSED';
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
const spendJournalFile = spendFile + '.journal';
let lastSpendWrite = 0;
let spendWriteLock = false;
const SPEND_WRITE_THROTTLE_MS = 1000;

// --- Per-CC-session spend tracking ---
// Each CC window heartbeats its session ID to cc-active.json.
// The proxy attributes accumulated spend to the active session on every flush.
const ccActiveFile = path.join(os.homedir(), '.deepclaude', 'cc-active.json');
const ccSpendDir = path.join(os.homedir(), '.deepclaude');
let ccPendingSpend = 0;
const CC_SESSION_TTL_MS = 120_000; // 2 min — don't attribute to stale windows

function ccSpendFilePath(sessionId: string): string {
  return path.join(ccSpendDir, `cc-spend-${sessionId}.json`);
}

let runningTotal = 0;
// Load runningTotal from persisted spend file on startup
try {
  if (fs.existsSync(spendFile)) {
    const raw = fs.readFileSync(spendFile, 'utf-8');
    const parsed = JSON.parse(raw);
    if (typeof parsed.total === 'number') {
      runningTotal = parsed.total;
    }
  }
} catch (_) {
  /* continue with zero */
}

// Replay write-ahead journal to recover spend lost on crash.
// Each line is JSON: { ts, cost, providerKey, modelName }
// Replayed costs are added to runningTotal and today's daily accumulators.
try {
  if (fs.existsSync(spendJournalFile)) {
    const journalRaw = fs.readFileSync(spendJournalFile, 'utf-8');
    const lines = journalRaw.split('\n').filter(Boolean);
    const today = todayISO();
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (typeof entry.cost === 'number') {
          runningTotal += entry.cost;
          // Replay into daily accumulators so budget checks are accurate
          const entryDate = (entry.ts || '').slice(0, 10);
          if (entryDate === today) {
            dailyAccumulator += entry.cost;
            if (entry.providerKey && typeof entry.providerKey === 'string') {
              const key = entry.modelName
                ? `${entry.providerKey}:${entry.modelName}`
                : entry.providerKey;
              providerDailyAccumulators[key] = (providerDailyAccumulators[key] || 0) + entry.cost;
            }
          }
        }
      } catch (_) {
        /* skip corrupt journal line */
      }
    }
  }
} catch (_) {
  /* non-fatal */
}
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
try {
  pricingData = require('./providers.json').pricing || {};
} catch (_) {
  /* continue without pricing */
}

// Monthly budget defaults for free-tier providers (used when providers.json has no monthlyBudget)
const DEFAULT_LIMITS: Record<string, number> = {
  or: 1.0,
  gr: 5.0,
  oc: 0.5,
  km: 1.0,
  mm: 1.0,
  um: 1.0,
  mt: 1.0,
  mx: 1.0,
  za: 1.0,
  bp: 1.0,
  sf: 1.0,
  nv: 1.0,
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
} catch (_) {
  /* continue without provider budgets */
}

function lookupPrice(
  modelName: string,
): { input: number; output: number; inputCacheHit?: number; inputCacheMiss?: number } | null {
  if (pricingData[modelName])
    return pricingData[modelName] as {
      input: number;
      output: number;
      inputCacheHit?: number;
      inputCacheMiss?: number;
    };
  const stripped = modelName.replace(/^[a-z][a-z0-9_-]*:/, '');
  if (stripped !== modelName && pricingData[stripped])
    return pricingData[stripped] as {
      input: number;
      output: number;
      inputCacheHit?: number;
      inputCacheMiss?: number;
    };
  return null;
}

// Record per-provider, per-model spend in the in-memory accumulator.
// Keys are "providerKey:modelName" for granular per-model tracking.
// Never throws.
export function recordProviderSpend(providerKey: string, amount: number, modelName?: string): void {
  if (!providerKey || amount <= 0) return;
  try {
    const key = modelName ? `${providerKey}:${modelName}` : providerKey;
    providerDailyAccumulators[key] = (providerDailyAccumulators[key] || 0) + amount;
  } catch (_) {
    /* non-fatal */
  }
}

// Read the currently active CC session ID from the heartbeat file.
// Sessions are considered active for CC_SESSION_TTL_MS after their last heartbeat.
function readActiveCcSession(): string | null {
  try {
    if (fs.existsSync(ccActiveFile)) {
      const raw = fs.readFileSync(ccActiveFile, 'utf-8');
      const data = JSON.parse(raw);
      if (
        typeof data.sessionId === 'string' &&
        data.sessionId.length > 0 &&
        typeof data.timestamp === 'number' &&
        Date.now() - data.timestamp < CC_SESSION_TTL_MS
      ) {
        return data.sessionId;
      }
    }
  } catch (_) {
    /* non-fatal */
  }
  return null;
}

// Flush pending spend to the active CC session's spend file.
// One file per session: cc-spend-<sessionId>.json contains a single number.
// Called alongside the main spend.json write in the throttled flush path.
function writeCcSpend(): void {
  try {
    const activeId = readActiveCcSession();
    if (!activeId || ccPendingSpend <= 0) {
      ccPendingSpend = 0;
      return;
    }
    const amt = parseFloat(ccPendingSpend.toFixed(6));
    ccPendingSpend = 0;

    const f = ccSpendFilePath(activeId);
    let existing = 0;
    if (fs.existsSync(f)) {
      try {
        existing = parseFloat(fs.readFileSync(f, 'utf-8').trim()) || 0;
      } catch (_) {}
    }
    const total = parseFloat((existing + amt).toFixed(6));
    const tmpFile = f + '.tmp';
    fs.writeFileSync(tmpFile, String(total) + '\n');
    fs.renameSync(tmpFile, f);
  } catch (_) {
    /* non-fatal */
  }
}

export async function recordSpend(
  modelName: string,
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    cache_hit_tokens?: number;
    cache_miss_tokens?: number;
  },
  providerKey?: string,
): Promise<void> {
  const price = lookupPrice(modelName);
  if (!price) {
    log.warn(
      null,
      'recordSpend: no pricing entry for model "' + modelName + '" — spend not tracked',
    );
    return;
  }

  let cost: number;
  // Use granular cache hit/miss pricing when both the pricing entry and usage data support it
  if (
    price.inputCacheHit !== undefined &&
    price.inputCacheMiss !== undefined &&
    typeof usage.cache_hit_tokens === 'number' &&
    typeof usage.cache_miss_tokens === 'number' &&
    usage.cache_hit_tokens + usage.cache_miss_tokens > 0
  ) {
    cost =
      (usage.cache_hit_tokens / 1_000_000) * price.inputCacheHit +
      (usage.cache_miss_tokens / 1_000_000) * price.inputCacheMiss +
      (usage.completion_tokens / 1_000_000) * price.output;
  } else {
    cost =
      (usage.prompt_tokens / 1_000_000) * price.input +
      (usage.completion_tokens / 1_000_000) * price.output;
  }
  runningTotal += cost;
  sessionTotal += cost;
  dailyAccumulator += cost;
  ccPendingSpend += cost;
  if (providerKey) {
    recordProviderSpend(providerKey, cost, modelName);
    if (typeof usage.cache_hit_tokens === 'number' || typeof usage.cache_miss_tokens === 'number') {
      try {
        if (!providerStats[providerKey]) {
          providerStats[providerKey] = {
            requests: 0,
            successes: 0,
            fails: 0,
            totalMs: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheHitTokens: 0,
            cacheMissTokens: 0,
          };
        }
        providerStats[providerKey].cacheHitTokens += usage.cache_hit_tokens || 0;
        providerStats[providerKey].cacheMissTokens += usage.cache_miss_tokens || 0;
      } catch (_) {
        /* non-fatal */
      }
    }
  }

  // Write-ahead journal: persist cost immediately so crashes between
  // throttle writes don't lose spend data. Replayed on startup.
  try {
    const journalEntry =
      JSON.stringify({
        ts: new Date().toISOString(),
        cost: parseFloat(cost.toFixed(6)),
        providerKey: providerKey || null,
        modelName,
      }) + '\n';
    fs.appendFileSync(spendJournalFile, journalEntry, 'utf-8');
  } catch (_) {
    /* non-fatal — spend tracking survives via in-memory accumulators */
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
      } catch (_) {
        /* ignore corrupt file */
      }
    }
    const today = todayISO();

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

    // Migrate legacy da-DK keys (d.m.yyyy) → ISO (yyyy-mm-dd).
    // Bug: prior to 2026-06-13, journal replay used ISO keys but live
    // flushes used da-DK, so today's spend was split across two keys.
    for (const [date, entry] of Object.entries(daily)) {
      const legacy = date.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
      if (legacy) {
        const [, dd, mm, yyyy] = legacy;
        const iso = `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
        if (iso !== date && daily[iso]) {
          daily[iso].total = parseFloat((daily[iso].total + entry.total).toFixed(4));
          for (const [pk, amt] of Object.entries(entry.byProvider)) {
            daily[iso].byProvider[pk] = parseFloat(
              ((daily[iso].byProvider[pk] || 0) + amt).toFixed(4),
            );
          }
        } else if (iso !== date) {
          daily[iso] = entry;
        }
        delete daily[date];
      }
    }

    // Update today's entry with accumulated totals
    const todayEntry = daily[today] || { total: 0, byProvider: {} };
    todayEntry.total = parseFloat((todayEntry.total + dailyAccumulator).toFixed(4));

    // Flush per-provider accumulators into today's byProvider breakdown
    for (const [pk, amount] of Object.entries(providerDailyAccumulators)) {
      if (amount > 0) {
        todayEntry.byProvider[pk] = parseFloat(
          ((todayEntry.byProvider[pk] || 0) + amount).toFixed(4),
        );
      }
    }
    daily[today] = todayEntry;

    const data = {
      total: parseFloat(runningTotal.toFixed(4)),
      daily,
      sessions: [{ started: sessionStarted, total: parseFloat(sessionTotal.toFixed(4)) }],
      current_model: modelName,
    };
    const tmpFile = spendFile + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(data) + '\n');
    fs.renameSync(tmpFile, spendFile);

    // Flush per-CC-session spend alongside the main spend.json write
    writeCcSpend();

    // Only clear accumulators and truncate journal AFTER successful write
    dailyAccumulator = 0;
    for (const pk of Object.keys(providerDailyAccumulators)) {
      delete providerDailyAccumulators[pk];
    }
    try {
      fs.truncateSync(spendJournalFile, 0);
    } catch (_) {
      /* non-fatal */
    }
  } catch (_) {
    /* non-fatal */
  } finally {
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
    const today = todayISO();
    const daily = data.daily as Record<string, unknown> | undefined;
    // Handle both legacy number format and new { total, byProvider } format.
    // Also merge any legacy da-DK key (d.m.yyyy) for today — these were
    // written by older code before date keys were standardized to ISO.
    let dailyTotal = 0;
    if (daily) {
      for (const [date, entry] of Object.entries(daily)) {
        // Primary key: ISO YYYY-MM-DD (new format)
        if (date === today && entry !== undefined) {
          const v = entry as { total?: number } | number;
          dailyTotal += typeof v === 'number' ? v : (v.total ?? 0);
        }
        // Legacy key: da-DK d.m.yyyy (old format, to be migrated)
        const legacy = date.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
        if (legacy) {
          const [, dd, mm, yyyy] = legacy;
          const isoDate = `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
          if (isoDate === today && entry !== undefined) {
            const v = entry as { total?: number } | number;
            dailyTotal += typeof v === 'number' ? v : (v.total ?? 0);
          }
        }
      }
    }
    cachedDailySpend = dailyTotal + dailyAccumulator;
    return cachedDailySpend;
  } catch (_) {
    cachedDailySpend = 0;
    return 0;
  }
}

// Budget checks use a 95% threshold to leave headroom for concurrent requests
// that may have already passed the check but haven't recorded their spend yet.
const BUDGET_BUFFER_RATIO = 0.95;

export function checkBudget(): string | null {
  if (sessionCap > 0) {
    const effectiveCap = sessionCap * BUDGET_BUFFER_RATIO;
    if (sessionTotal >= effectiveCap) {
      return (
        'Session cap of $' +
        sessionCap.toFixed(2) +
        ' exceeded ($' +
        sessionTotal.toFixed(2) +
        ' spent this session)'
      );
    }
  }
  if (sessionDailyBudget > 0) {
    const dailySpend = getDailySpend();
    const effectiveDaily = sessionDailyBudget * BUDGET_BUFFER_RATIO;
    if (dailySpend >= effectiveDaily) {
      return (
        'Daily budget of $' +
        sessionDailyBudget.toFixed(2) +
        ' exceeded ($' +
        dailySpend.toFixed(2) +
        ' spent today)'
      );
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
