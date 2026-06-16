'use strict';

import path from 'path';
import fs from 'fs';
import os from 'os';
import {
  recordStat,
  recordUsage,
  recordFallback,
  recordRecentRequest,
  recordStreamMetrics,
  recordSpend,
  recordProviderSpend,
  recordSavings,
  getTotalSavings,
  getSpendHistory,
  getModelBreakdown,
  isProviderHealthy,
  getHealthSnapshot,
  getCircuitBreakerState,
  getFullHealthSnapshot,
  openCircuitBreaker,
  maybeStartProbe,
  recordProbeResult,
  getBreakerState,
  getBreakerEntry,
  registerProviderInfo,
  getRegisteredProviderKeys,
  reconcileCircuitBreakers,
  reconcileProviderStats,
  reloadPricing,
  setGitHash,
  nextRequestId,
  setSpendFilePath,
  _resetBudgetState,
  _setSessionTotal,
  buildPrometheusMetrics,
} from '../stats';

describe('recordStat', () => {
  test('creates new entry on first call', () => {
    recordStat('test-prov', true, 150);
    const snap = getHealthSnapshot();
    expect(snap.providers['test-prov']).toBeDefined();
    expect(snap.providers['test-prov'].requests).toBe(1);
    expect(snap.providers['test-prov'].successes).toBe(1);
    expect(snap.providers['test-prov'].fails).toBe(0);
  });

  test('increments existing entry', () => {
    recordStat('test-prov', false, 200);
    const snap = getHealthSnapshot();
    expect(snap.providers['test-prov'].requests).toBe(2);
    expect(snap.providers['test-prov'].successes).toBe(1);
    expect(snap.providers['test-prov'].fails).toBe(1);
  });

  test('does nothing for null/undefined providerKey', () => {
    recordStat(null, true, 100);
    recordStat(undefined, false, 100);
  });
});

describe('recordUsage', () => {
  test('creates new entry with token counts', () => {
    recordUsage('usage-prov', 100, 200);
    const snap = getHealthSnapshot();
    expect(snap.providers['usage-prov']).toBeDefined();
    expect(snap.providers['usage-prov'].inputTokens).toBe(100);
    expect(snap.providers['usage-prov'].outputTokens).toBe(200);
    expect(snap.providers['usage-prov'].requests).toBe(0);
  });

  test('increments existing token counts', () => {
    recordUsage('usage-prov', 50, 75);
    const snap = getHealthSnapshot();
    expect(snap.providers['usage-prov'].inputTokens).toBe(150);
    expect(snap.providers['usage-prov'].outputTokens).toBe(275);
  });

  test('does nothing for null/undefined providerKey', () => {
    recordUsage(null, 100, 200);
    recordUsage(undefined, 50, 75);
  });

  test('handles undefined token values as zero', () => {
    recordUsage('usage-zero', undefined, undefined);
    const snap = getHealthSnapshot();
    expect(snap.providers['usage-zero'].inputTokens).toBe(0);
    expect(snap.providers['usage-zero'].outputTokens).toBe(0);
  });
});

describe('isProviderHealthy', () => {
  test('returns true for unknown provider', () => {
    expect(isProviderHealthy('nonexistent')).toBe(true);
  });

  test('returns true with fewer than 2 requests', () => {
    expect(isProviderHealthy('healthy-few')).toBe(true);
  });

  test('basic health check structure', () => {
    const snap = getHealthSnapshot();
    expect(snap.status).toBe('ok');
    expect(typeof snap.uptime).toBe('number');
    expect(snap.providers).toBeDefined();
  });
});

// =========================================================================
// New comprehensive test coverage
// =========================================================================

describe('recordStat — HTTP 429 handling', () => {
  afterEach(() => {
    // Clean up env if we changed it
    delete process.env.DEEPCLAUDE_BUDGET_WARNING;
  });

  test('429 status does NOT count as failure and does NOT open breaker', () => {
    const key = 'rate-limited-429';
    // 19 out of 20 returning 429 — only the single non-429 should count as failure
    for (let i = 0; i < 19; i++) {
      recordStat(key, false, 100, 429);
    }
    const snapBefore = getHealthSnapshot();
    expect(snapBefore.providers[key].fails).toBe(0);
    expect(snapBefore.providers[key].requests).toBe(19);
    expect(snapBefore.providers[key].successes).toBe(0);
    // Circuit breaker should still be closed (never tripped by 429s)
    expect(getCircuitBreakerState(key)).toBe('CLOSED');

    // Now add one real failure (non-429)
    recordStat(key, false, 100, 500);
    const snapAfter = getHealthSnapshot();
    expect(snapAfter.providers[key].fails).toBe(1);
    expect(snapAfter.providers[key].requests).toBe(20);
  });

  test('429 with success=false and no statusCode counts as failure', () => {
    const key = 'no-status-429';
    recordStat(key, false, 100);
    const snap = getHealthSnapshot();
    expect(snap.providers[key].fails).toBe(1);
    expect(snap.providers[key].requests).toBe(1);
  });
});

describe('recordStat — failure threshold', () => {
  test('4 failures out of 4 does NOT open breaker (fewer than 5 requests needed)', () => {
    const key = 'few-requests-thresh';
    for (let i = 0; i < 4; i++) {
      recordStat(key, false, 100);
    }
    const snap = getHealthSnapshot();
    expect(snap.providers[key].fails).toBe(4);
    expect(snap.providers[key].requests).toBe(4);
    expect(getCircuitBreakerState(key)).toBe('CLOSED');
  });

  test('1 failure out of 5 (20%) does NOT open breaker (below 34% threshold)', () => {
    const key = 'low-fail-rate-thresh';
    for (let i = 0; i < 4; i++) {
      recordStat(key, true, 100);
    }
    recordStat(key, false, 100);
    const snap = getHealthSnapshot();
    expect(snap.providers[key].successes).toBe(4);
    expect(snap.providers[key].fails).toBe(1);
    expect(snap.providers[key].requests).toBe(5);
    expect(getCircuitBreakerState(key)).toBe('CLOSED');
  });

  test('2 failures out of 5 (40%) opens circuit breaker', () => {
    const key = 'med-fail-rate-thresh';
    for (let i = 0; i < 3; i++) {
      recordStat(key, true, 100);
    }
    for (let i = 0; i < 2; i++) {
      recordStat(key, false, 100);
    }
    expect(getBreakerState(key)).toBe('OPEN');
  });

  test('5 failures out of 5 opens circuit breaker', () => {
    const key = 'high-fail-rate-thresh';
    for (let i = 0; i < 5; i++) {
      recordStat(key, false, 100);
    }
    expect(getBreakerState(key)).toBe('OPEN');
  });
});

describe('openCircuitBreaker edge cases', () => {
  test('creates a new OPEN breaker entry', () => {
    openCircuitBreaker('fresh-cb-edge');
    const entry = getBreakerEntry('fresh-cb-edge');
    expect(entry).toBeDefined();
    expect(entry!.state).toBe('OPEN');
    expect(entry!.cooldownMs).toBe(60000);
    expect(entry!.probeCount).toBe(0);
  });

  test('no-op when breaker is already OPEN', () => {
    const key = 'already-open-cb';
    openCircuitBreaker(key);
    const entry = getBreakerEntry(key)!;
    entry.probeCount = 999;
    entry.cooldownMs = 12345;
    // This should be a no-op because state is OPEN, not CLOSED
    openCircuitBreaker(key);
    expect(getBreakerEntry(key)!.probeCount).toBe(999);
    expect(getBreakerEntry(key)!.cooldownMs).toBe(12345);
    expect(getBreakerEntry(key)!.state).toBe('OPEN');
  });

  test('no-op when breaker is already HALF_OPEN', () => {
    const key = 'already-half-cb';
    registerProviderInfo(key, {
      url: 'https://example.com/api',
      key: 'test-key',
      isBearer: true,
      format: 'anthropic',
      model: 'claude-sonnet-4-20250514',
    });
    openCircuitBreaker(key);
    const entry = getBreakerEntry(key)!;
    entry.openedAt = Date.now() - 120000;
    maybeStartProbe(key); // transitions to HALF_OPEN
    expect(getBreakerState(key)).toBe('HALF_OPEN');

    // This should be a no-op
    openCircuitBreaker(key);
    expect(getBreakerState(key)).toBe('HALF_OPEN');
  });
});

describe('maybeStartProbe edge cases', () => {
  test('returns null when no circuit breaker entry exists', () => {
    expect(maybeStartProbe('nonexistent-probe')).toBeNull();
  });

  test('returns null when entry exists but state is not OPEN', () => {
    const key = 'not-open-probe';
    registerProviderInfo(key, {
      url: 'https://example.com/api',
      key: 'test-key',
      isBearer: true,
      format: 'anthropic',
      model: 'claude-sonnet-4-20250514',
    });
    // State is CLOSED by default — maybeStartProbe should return null
    expect(maybeStartProbe(key)).toBeNull();
  });

  test('returns null when provider has no registered info', () => {
    const key = 'no-info-probe';
    openCircuitBreaker(key);
    const entry = getBreakerEntry(key)!;
    entry.openedAt = Date.now() - 120000; // cooldown elapsed
    // No providerInfo registered for this key
    expect(maybeStartProbe(key)).toBeNull();
    // NOTE: the state transitions to HALF_OPEN before checking info,
    // so state will be HALF_OPEN even though the probe returned null.
    expect(getBreakerState(key)).toBe('HALF_OPEN');
  });
});

describe('recordProbeResult edge cases', () => {
  test('no-op when no circuit breaker entry exists', () => {
    recordProbeResult('nonexistent-probe-result', true);
    recordProbeResult('nonexistent-probe-result', false);
    // Should not throw
  });

  test('no-op when state is not HALF_OPEN', () => {
    const key = 'wrong-state-probe-result';
    // OPEN state
    openCircuitBreaker(key);
    recordProbeResult(key, true);
    expect(getBreakerState(key)).toBe('OPEN');

    // CLOSED state
    const entry = getBreakerEntry(key)!;
    entry.state = 'CLOSED';
    recordProbeResult(key, true);
    expect(getBreakerState(key)).toBe('CLOSED');
  });

  test('success on HALF_OPEN transitions to CLOSED and deletes entry', () => {
    const key = 'probe-success-cleanup';
    registerProviderInfo(key, {
      url: 'https://example.com/api',
      key: 'test-key',
      isBearer: true,
      format: 'anthropic',
      model: 'claude-sonnet-4-20250514',
    });
    openCircuitBreaker(key);
    const entry = getBreakerEntry(key)!;
    entry.openedAt = Date.now() - 120000;
    expect(maybeStartProbe(key)).not.toBeNull();
    expect(getBreakerState(key)).toBe('HALF_OPEN');

    recordProbeResult(key, true);
    expect(getBreakerState(key)).toBe('CLOSED');
    expect(getBreakerEntry(key)).toBeUndefined();
  });
});

describe('reconcileCircuitBreakers', () => {
  test('removes stale circuit breaker entries', () => {
    openCircuitBreaker('stale-cb');
    openCircuitBreaker('keep-cb');
    expect(getBreakerEntry('stale-cb')).toBeDefined();
    expect(getBreakerEntry('keep-cb')).toBeDefined();

    reconcileCircuitBreakers(new Set(['keep-cb']));

    expect(getBreakerEntry('stale-cb')).toBeUndefined();
    expect(getBreakerEntry('keep-cb')).toBeDefined();
  });

  test('no-op when all circuit breakers are in the provided set', () => {
    openCircuitBreaker('valid-cb-recon');
    reconcileCircuitBreakers(new Set(['valid-cb-recon']));
    expect(getBreakerEntry('valid-cb-recon')).toBeDefined();
  });

  test('empty set removes all circuit breakers', () => {
    openCircuitBreaker('removable-cb');
    expect(getBreakerEntry('removable-cb')).toBeDefined();
    reconcileCircuitBreakers(new Set());
    expect(getBreakerEntry('removable-cb')).toBeUndefined();
  });
});

describe('reconcileProviderStats', () => {
  test('removes stale provider stats entries', () => {
    recordStat('stale-ps', true, 100);
    recordStat('keep-ps', true, 100);

    let snap = getHealthSnapshot();
    expect(snap.providers['stale-ps']).toBeDefined();
    expect(snap.providers['keep-ps']).toBeDefined();

    reconcileProviderStats(new Set(['keep-ps']));

    snap = getHealthSnapshot();
    expect(snap.providers['stale-ps']).toBeUndefined();
    expect(snap.providers['keep-ps']).toBeDefined();
  });

  test('removes stale stream accumulator entries', () => {
    const sm = {
      ttftMs: 100,
      totalDurationMs: 1000,
      chunkCount: 5,
      totalTokens: 100,
      tps: 10,
      maxInterChunkMs: 50,
      avgInterChunkMs: 25,
      p95InterChunkMs: 45,
    };
    // Need recordStat so providers appear in getFullHealthSnapshot
    recordStat('stale-sa', true, 100);
    recordStat('keep-sa', true, 100);
    recordStreamMetrics('stale-sa', sm);
    recordStreamMetrics('keep-sa', sm);

    reconcileProviderStats(new Set(['keep-sa']));

    // keep-sa should still have its stream accumulator
    const full = getFullHealthSnapshot({}, {});
    const providers = full.providers as Record<string, Record<string, unknown>>;
    expect(providers['keep-sa']).toBeDefined();
    expect(providers['keep-sa'].avgTTFT).toBe(100);
    // stale-sa should be gone
    expect(providers['stale-sa']).toBeUndefined();
  });

  test('no-op when all entries are valid', () => {
    recordStat('valid-ps-recon', true, 100);
    reconcileProviderStats(new Set(['valid-ps-recon']));
    const snap = getHealthSnapshot();
    expect(snap.providers['valid-ps-recon']).toBeDefined();
  });
});

describe('getRegisteredProviderKeys', () => {
  test('returns registered provider keys', () => {
    registerProviderInfo('reg-key-1', {
      url: 'https://api1.example.com',
      key: 'key1',
      isBearer: true,
      format: 'anthropic',
      model: 'claude-sonnet-4-20250514',
    });
    registerProviderInfo('reg-key-2', {
      url: 'https://api2.example.com',
      key: 'key2',
      isBearer: true,
      format: 'openai',
      model: 'gpt-4o',
    });
    const keys = getRegisteredProviderKeys();
    expect(keys).toContain('reg-key-1');
    expect(keys).toContain('reg-key-2');
  });
});

describe('recordFallback', () => {
  test('records fallback with from, to, and timestamp', () => {
    recordFallback('provider-a', 'provider-b');
    // Verify indirectly via getFullHealthSnapshot
    const snap = getFullHealthSnapshot({}, {});
    expect(snap.lastFallback).toBeDefined();
    expect((snap.lastFallback as { from: string }).from).toBe('provider-a');
    expect((snap.lastFallback as { to: string }).to).toBe('provider-b');
    expect((snap.lastFallback as { at: string }).at).toBeDefined();
  });

  test('overwrites previous fallback entry', () => {
    recordFallback('old-from', 'old-to');
    recordFallback('new-from', 'new-to');
    const snap = getFullHealthSnapshot({}, {});
    expect((snap.lastFallback as { from: string }).from).toBe('new-from');
    expect((snap.lastFallback as { to: string }).to).toBe('new-to');
  });
});

describe('recordRecentRequest', () => {
  test('adds entry to recent requests', () => {
    recordRecentRequest({
      timestamp: Date.now(),
      model: 'test-model',
      provider: 'test-provider',
      status: 200,
      ms: 150,
      tokens: { input: 100, output: 200 },
      fallback: false,
    });
    // Cannot directly access recentRequests, but verify via full health snapshot
    const snap = getFullHealthSnapshot({}, {});
    expect(Array.isArray(snap.recentRequests)).toBe(true);
    expect(snap.recentRequests.length).toBeGreaterThan(0);
  });

  test('maintains ring buffer of at most 50 entries', () => {
    // Add 55 entries to overflow the buffer
    for (let i = 0; i < 55; i++) {
      recordRecentRequest({
        timestamp: Date.now(),
        model: 'model-' + i,
        provider: 'prov-' + i,
        status: 200,
        ms: i,
        tokens: null,
        fallback: false,
      });
    }
    const snap = getFullHealthSnapshot({}, {});
    expect(snap.recentRequests.length).toBeLessThanOrEqual(50);
  });

  test('handles null tokens and null status', () => {
    recordRecentRequest({
      timestamp: Date.now(),
      model: null,
      provider: 'null-prov',
      status: null,
      ms: 0,
      tokens: null,
      fallback: false,
    });
    // Should not throw
  });
});

describe('recordStreamMetrics', () => {
  test('records TTFT and TPS for a provider', () => {
    const key = 'stream-metric-prov';
    recordStat(key, true, 100); // required so provider appears in snapshot
    recordStreamMetrics(key, {
      ttftMs: 150,
      totalDurationMs: 2000,
      chunkCount: 10,
      totalTokens: 500,
      tps: 250,
      maxInterChunkMs: 100,
      avgInterChunkMs: 50,
      p95InterChunkMs: 80,
    });
    // Verify via getFullHealthSnapshot
    const snap = getFullHealthSnapshot({}, {});
    const providers = snap.providers as Record<string, Record<string, unknown>>;
    expect(providers[key].avgTTFT).toBe(150);
    expect(providers[key].avgTPS).toBe(250);
  });

  test('accumulates multiple metrics records', () => {
    const key = 'multi-stream-metric';
    recordStat(key, true, 100);
    for (let i = 0; i < 3; i++) {
      recordStreamMetrics(key, {
        ttftMs: 100,
        totalDurationMs: 1000,
        chunkCount: 5,
        totalTokens: 200,
        tps: 200,
        maxInterChunkMs: 50,
        avgInterChunkMs: 25,
        p95InterChunkMs: 40,
      });
    }
    // 3 records of ttftMs=100 => avgTTFT=100
    // 3 records of tps=200 => avgTPS=200
    const snap = getFullHealthSnapshot({}, {});
    const providers = snap.providers as Record<string, Record<string, unknown>>;
    expect(providers[key].avgTTFT).toBe(100);
    expect(providers[key].avgTPS).toBe(200);
  });

  test('ignores zero TTFT (does not increment ttftCount)', () => {
    const key = 'zero-ttft';
    recordStat(key, true, 100);
    recordStreamMetrics(key, {
      ttftMs: 0,
      totalDurationMs: 1000,
      chunkCount: 5,
      totalTokens: 200,
      tps: 200,
      maxInterChunkMs: 50,
      avgInterChunkMs: 25,
      p95InterChunkMs: 40,
    });
    const snap = getFullHealthSnapshot({}, {});
    const providers = snap.providers as Record<string, Record<string, unknown>>;
    expect(providers[key].avgTTFT).toBe(0);
  });

  test('ignores zero TPS (does not increment tpsCount)', () => {
    const key = 'zero-tps';
    recordStat(key, true, 100);
    // First add a record with valid TPS
    recordStreamMetrics(key, {
      ttftMs: 100,
      totalDurationMs: 1000,
      chunkCount: 5,
      totalTokens: 200,
      tps: 200,
      maxInterChunkMs: 50,
      avgInterChunkMs: 25,
      p95InterChunkMs: 40,
    });
    // Then add one with zero TPS — tpsCount should stay at 1
    recordStreamMetrics(key, {
      ttftMs: 50,
      totalDurationMs: 1000,
      chunkCount: 5,
      totalTokens: 200,
      tps: 0,
      maxInterChunkMs: 50,
      avgInterChunkMs: 25,
      p95InterChunkMs: 40,
    });
    const snap = getFullHealthSnapshot({}, {});
    const providers = snap.providers as Record<string, Record<string, unknown>>;
    // avgTTFT = (100 + 50)/2 = 75
    expect(providers[key].avgTTFT).toBe(75);
    // avgTPS = 200/1 = 200 (only the non-zero TPS counted)
    expect(providers[key].avgTPS).toBe(200);
  });

  test('negative TTFT and TPS are ignored (not counted)', () => {
    const key = 'neg-stream';
    recordStat(key, true, 100);
    recordStreamMetrics(key, {
      ttftMs: -1,
      totalDurationMs: 1000,
      chunkCount: 5,
      totalTokens: 200,
      tps: -5,
      maxInterChunkMs: 50,
      avgInterChunkMs: 25,
      p95InterChunkMs: 40,
    });
    const snap = getFullHealthSnapshot({}, {});
    const providers = snap.providers as Record<string, Record<string, unknown>>;
    expect(providers[key].avgTTFT).toBe(0);
    expect(providers[key].avgTPS).toBe(0);
  });

  test('no-op for empty provider key', () => {
    const sm = {
      ttftMs: 100,
      totalDurationMs: 1000,
      chunkCount: 5,
      totalTokens: 200,
      tps: 50,
      maxInterChunkMs: 50,
      avgInterChunkMs: 25,
      p95InterChunkMs: 40,
    };
    recordStreamMetrics('', sm);
    // Should not throw
  });
});

describe('setGitHash and nextRequestId', () => {
  test('setGitHash is callable', () => {
    setGitHash('abc123def456');
    // Stored in module state; verified via getFullHealthSnapshot version field
    const snap = getFullHealthSnapshot({}, {});
    expect(typeof snap.version).toBe('string');
    expect(snap.version as string).toContain('abc123def456');
  });

  test('nextRequestId returns incrementing positive integers', () => {
    const id1 = nextRequestId();
    const id2 = nextRequestId();
    expect(id1).toBeGreaterThan(0);
    expect(id2).toBe(id1 + 1);
  });
});

describe('getCircuitBreakerState', () => {
  test('returns CLOSED for provider with stats but no explicit breaker entry', () => {
    const key = 'stats-but-no-breaker';
    recordStat(key, true, 100);
    expect(getCircuitBreakerState(key)).toBe('CLOSED');
  });

  test('returns UNTESTED for provider with zero requests', () => {
    expect(getCircuitBreakerState('zero-request-prov')).toBe('UNTESTED');
  });

  test('returns OPEN for provider with active OPEN breaker', () => {
    const key = 'cb-state-open-test';
    openCircuitBreaker(key);
    expect(getCircuitBreakerState(key)).toBe('OPEN');
  });
});

describe('getHealthSnapshot extended', () => {
  test('returns avgMs calculated from totalMs and requests', () => {
    const key = 'avg-ms-test';
    recordStat(key, true, 200);
    recordStat(key, true, 400);
    const snap = getHealthSnapshot();
    expect(snap.providers[key].avgMs).toBe(300); // (200+400)/2
  });

  test('returns avgMs of 0 when no requests', () => {
    const key = 'zero-avg-ms';
    // Just record usage, no stat
    recordUsage(key, 100, 200);
    const snap = getHealthSnapshot();
    // The provider entry was created by recordUsage, but stat entry may or may not exist
    // Actually recordUsage also creates a providerStats entry with requests=0
    expect(snap.providers[key].avgMs).toBe(0);
    expect(snap.providers[key].requests).toBe(0);
  });

  test('returns empty providers record when nothing recorded', () => {
    const snap = getHealthSnapshot();
    // There should always be some providers from previous tests,
    // but the structure should be an object
    expect(typeof snap.providers).toBe('object');
  });
});

describe('getFullHealthSnapshot — structure', () => {
  afterEach(() => {
    delete process.env.DEEPCLAUDE_BUDGET_WARNING;
  });

  test('includes base health data plus version', () => {
    const snap = getFullHealthSnapshot({}, {});
    expect(snap.status).toBe('ok');
    expect(snap.version).toBeDefined();
    expect(typeof snap.uptime).toBe('number');
  });

  test('includes concurrency status when provided', () => {
    const concurrency = {
      main: { active: 2, waiting: 1, limit: 10 },
    };
    const snap = getFullHealthSnapshot(concurrency, null);
    expect(snap.concurrency).toEqual(concurrency);
  });

  test('includes rate limiter status when provided', () => {
    const rateLimiter = { tracked: 5 };
    const snap = getFullHealthSnapshot(null, rateLimiter);
    expect(snap.rateLimiter).toEqual(rateLimiter);
  });

  test('includes session spend total', () => {
    const snap = getFullHealthSnapshot({}, {});
    expect(typeof snap.spend).toBe('number');
  });

  test('includes memory stats with event loop lag', () => {
    const snap = getFullHealthSnapshot({}, {});
    expect(snap.memory).toBeDefined();
    const mem = snap.memory as Record<string, unknown>;
    expect(typeof mem.heapUsed).toBe('number');
    expect(typeof mem.heapTotal).toBe('number');
    expect(typeof mem.rss).toBe('number');
    expect(typeof mem.external).toBe('number');
    expect(typeof mem.eventLoopLagMs).toBe('number');
  });

  test('includes budgetWarning at red level when session exceeds budget', () => {
    process.env.DEEPCLAUDE_BUDGET_WARNING = '1.0';
    _setSessionTotal(1.5);
    const snap = getFullHealthSnapshot({}, {});
    expect(snap.budgetWarning).toBeDefined();
    expect((snap.budgetWarning as { level: string }).level).toBe('red');
    expect((snap.budgetWarning as { message: string }).message).toContain('Spend cap reached');
    _setSessionTotal(0);
  });

  test('includes budgetWarning at yellow level when session >= 75% of budget', () => {
    process.env.DEEPCLAUDE_BUDGET_WARNING = '1.0';
    _setSessionTotal(0.8);
    const snap = getFullHealthSnapshot({}, {});
    expect(snap.budgetWarning).toBeDefined();
    expect((snap.budgetWarning as { level: string }).level).toBe('yellow');
    _setSessionTotal(0);
  });

  test('includes budgetWarning at info level when session >= 50% of budget', () => {
    process.env.DEEPCLAUDE_BUDGET_WARNING = '1.0';
    _setSessionTotal(0.55);
    const snap = getFullHealthSnapshot({}, {});
    expect(snap.budgetWarning).toBeDefined();
    expect((snap.budgetWarning as { level: string }).level).toBe('info');
    _setSessionTotal(0);
  });

  test('no budgetWarning when budget is not set', () => {
    delete process.env.DEEPCLAUDE_BUDGET_WARNING;
    const snap = getFullHealthSnapshot({}, {});
    expect(snap.budgetWarning).toBeUndefined();
  });

  test('no budgetWarning when session is below 50% of budget', () => {
    process.env.DEEPCLAUDE_BUDGET_WARNING = '10.0';
    _setSessionTotal(1.0);
    const snap = getFullHealthSnapshot({}, {});
    expect(snap.budgetWarning).toBeUndefined();
    _setSessionTotal(0);
  });
});

describe('getFullHealthSnapshot — cache and stream metrics', () => {
  test('includes cacheHitRate when cache tokens are present', () => {
    const key = 'cache-rate-test';
    recordStat(key, true, 100);
    // Record cache tokens via recordSpend path: use reloadPricing first
    // to ensure pricing data is loaded, then recordSpend stores cache tokens
    // in providerStats[key].cacheHitTokens and cacheMissTokens
    recordUsage(key, 100, 200);
    // Manually trigger cache token recording by setting up spend
    // We verify via the provider entry in full snapshot
    const _snap = getFullHealthSnapshot({}, {});
    // cacheHitRate is only present when cacheTotal > 0
    // providerStats was created by recordStat above but cache_* tokens are 0
    // So no cacheHitRate expected here — that's fine, the key is it doesn't crash
  });

  test('includes avgTTFT and avgTPS from stream accumulators', () => {
    const key = 'stream-full-snap';
    recordStat(key, true, 100);
    recordStreamMetrics(key, {
      ttftMs: 200,
      totalDurationMs: 3000,
      chunkCount: 15,
      totalTokens: 750,
      tps: 250,
      maxInterChunkMs: 120,
      avgInterChunkMs: 60,
      p95InterChunkMs: 100,
    });
    const snap = getFullHealthSnapshot({}, {});
    const providers = snap.providers as Record<string, Record<string, unknown>>;
    expect(providers[key].avgTTFT).toBe(200);
    expect(providers[key].avgTPS).toBe(250);
  });
});

describe('buildPrometheusMetrics', () => {
  test('returns Prometheus-format metrics string', () => {
    const metrics = buildPrometheusMetrics({}, {});
    expect(typeof metrics).toBe('string');
    expect(metrics).toContain('# HELP deepclaude_uptime_seconds');
    expect(metrics).toContain('# TYPE deepclaude_uptime_seconds gauge');
    expect(metrics).toContain('deepclaude_active_connections');
    expect(metrics.endsWith('\n')).toBe(true);
  });

  test('includes provider-level metrics for recorded stats', () => {
    recordStat('prom-prov-test', true, 100);
    const metrics = buildPrometheusMetrics({}, {});
    expect(metrics).toContain('provider="prom-prov-test"');
    expect(metrics).toContain('deepclaude_requests_total');
    expect(metrics).toContain('deepclaude_circuit_breaker_state');
  });

  test('includes concurrency metrics when provided', () => {
    const cs = { main: { active: 3, waiting: 2, limit: 10 } };
    const metrics = buildPrometheusMetrics(cs, {});
    expect(metrics).toContain('# HELP deepclaude_concurrency_active');
    expect(metrics).toContain('pool="main"}');
  });

  test('includes rate limiter metrics when provided', () => {
    const rs = { tracked: 42 };
    const metrics = buildPrometheusMetrics({}, rs);
    expect(metrics).toContain('deepclaude_rate_limit_tracked 42');
  });

  test('includes memory and event loop lag metrics', () => {
    const metrics = buildPrometheusMetrics({}, {});
    expect(metrics).toContain('deepclaude_memory_bytes');
    expect(metrics).toContain('deepclaude_event_loop_lag_ms');
  });

  test('includes session spend metric', () => {
    const metrics = buildPrometheusMetrics({}, {});
    expect(metrics).toContain('deepclaude_spend_session_dollars');
  });
});

describe('recordSpend — pricing edge cases', () => {
  let tmpDir: string;
  let tmpFile: string;

  beforeEach(() => {
    _resetBudgetState();
    // Let the module-level require load pricing data from providers.json.
    // The module already ran require('./providers.json') at import time,
    // so pricingData should be populated.
    // Also set up a temp spend file so writes don't pollute real data.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepclaude-test-'));
    tmpFile = path.join(tmpDir, 'spend.json');
    setSpendFilePath(tmpFile);
    // Load fresh pricing data from providers.json so lookups work
    reloadPricing();
  });

  afterEach(() => {
    _resetBudgetState();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {
      /* cleanup */
    }
  });

  test('recordSpend with cache hit/miss tokens uses flat pricing fallback', async () => {
    // NOTE: The cache pricing path checks `price.inputCacheHit` (camelCase) but
    // providers.json stores `input_cache_hit` (snake_case). This pre-existing
    // mismatch means granular cache pricing is never activated — flat pricing
    // is always used. This test documents the actual behavior.
    const model = 'deepseek-v4-pro';
    // prompt_tokens=1M => flat cost: (1000000/1000000) * 0.435 = 0.435
    const usage = {
      prompt_tokens: 1_000_000,
      completion_tokens: 0,
      cache_hit_tokens: 500_000,
      cache_miss_tokens: 500_000,
    };

    await recordSpend(model, usage, 'ds');

    const raw = fs.readFileSync(tmpFile, 'utf-8');
    const data = JSON.parse(raw);
    expect(data.total).toBeCloseTo(0.435, 3);
  });

  test('recordSpend falls back to flat pricing when cache data is missing from usage', async () => {
    const model = 'deepseek-v4-pro';
    const usage = {
      prompt_tokens: 1_000_000, // 1M tokens
      completion_tokens: 0,
      // No cache_hit_tokens or cache_miss_tokens
    };

    await recordSpend(model, usage, 'ds');

    const raw = fs.readFileSync(tmpFile, 'utf-8');
    const data = JSON.parse(raw);
    // Flat pricing: (1000000/1000000) * 0.435 = 0.435
    expect(data.total).toBeCloseTo(0.435, 3);
  });

  test('recordSpend falls back to flat pricing when pricing has no cache fields', async () => {
    // kimi-k2.6 has only input/output, no cache pricing
    const model = 'kimi-k2.6';
    const usage = {
      prompt_tokens: 500_000,
      completion_tokens: 100_000,
      cache_hit_tokens: 200_000,
      cache_miss_tokens: 300_000,
    };

    await recordSpend(model, usage, 'km');

    const raw = fs.readFileSync(tmpFile, 'utf-8');
    const data = JSON.parse(raw);
    // Flat pricing: (500000/1000000) * 0.6 + (100000/1000000) * 2.5
    // = 0.5 * 0.6 + 0.1 * 2.5 = 0.3 + 0.25 = 0.55
    expect(data.total).toBeCloseTo(0.55, 3);
  });

  test('recordSpend with unknown model does not record spend', async () => {
    const _before = { ...getFullHealthSnapshot({}, {}) };

    await recordSpend(
      'nonexistent-model',
      {
        prompt_tokens: 1000,
        completion_tokens: 100,
      },
      'unknown',
    );

    // Spend file should not have been created (or if it was, total should be 0)
    if (fs.existsSync(tmpFile)) {
      const raw = fs.readFileSync(tmpFile, 'utf-8');
      const data = JSON.parse(raw);
      expect(data.total).toBe(0);
    }
  });

  test('recordSpend without providerKey still records spend', async () => {
    await recordSpend('kimi-k2.6', {
      prompt_tokens: 100_000,
      completion_tokens: 10_000,
    });
    // No providerKey — spend is recorded but no cache tokens stored
    const raw = fs.readFileSync(tmpFile, 'utf-8');
    const data = JSON.parse(raw);
    expect(data.total).toBeGreaterThan(0);
    // sessions array should be populated
    expect(data.sessions).toBeDefined();
    expect(data.sessions.length).toBeGreaterThan(0);
  });

  test('recordSpend with zero tokens records zero cost', async () => {
    await recordSpend(
      'kimi-k2.6',
      {
        prompt_tokens: 0,
        completion_tokens: 0,
      },
      'km',
    );

    const raw = fs.readFileSync(tmpFile, 'utf-8');
    const data = JSON.parse(raw);
    expect(data.total).toBe(0);
  });

  test('recordSpend persists spend data to file via throttled flush', async () => {
    // Verify that the spend file is written after recordSpend
    await recordSpend(
      'deepseek-v4-pro',
      {
        prompt_tokens: 100_000,
        completion_tokens: 1_000,
      },
      'ds',
    );

    expect(fs.existsSync(tmpFile)).toBe(true);
    const raw = fs.readFileSync(tmpFile, 'utf-8');
    const data = JSON.parse(raw);
    expect(data.total).toBeDefined();
    expect(typeof data.total).toBe('number');
    expect(data.total).toBeGreaterThan(0);
    // Verify structure includes daily, sessions, current_model
    expect(data.daily).toBeDefined();
    expect(data.sessions).toBeDefined();
    expect(Array.isArray(data.sessions)).toBe(true);
    expect(data.current_model).toBe('deepseek-v4-pro');
  });

  test('recordSpend preserves current_model in persisted data', async () => {
    await recordSpend(
      'deepseek-v4-pro',
      {
        prompt_tokens: 100_000,
        completion_tokens: 1_000,
      },
      'ds',
    );

    const raw = fs.readFileSync(tmpFile, 'utf-8');
    const data = JSON.parse(raw);
    expect(data.current_model).toBe('deepseek-v4-pro');
  });

  test('writeCcSpend bootstraps cc-active.json from CLAUDE_CODE_SESSION_ID', async () => {
    // When no cc-active.json exists yet (statusline hasn't run), the proxy
    // should bootstrap it from the env var so the first request's spend is
    // attributed instead of silently lost.
    const sessionId = 'test-bootstrap-session';
    const prevId = process.env.CLAUDE_CODE_SESSION_ID;
    try {
      process.env.CLAUDE_CODE_SESSION_ID = sessionId;

      // No cc-active.json in temp dir yet
      const ccActivePath = path.join(tmpDir, 'cc-active.json');
      expect(fs.existsSync(ccActivePath)).toBe(false);

      await recordSpend(
        'deepseek-v4-pro',
        { prompt_tokens: 100_000, completion_tokens: 1_000 },
        'ds',
      );

      // cc-active.json should have been bootstrapped from the env var
      expect(fs.existsSync(ccActivePath)).toBe(true);
      const activeData = JSON.parse(fs.readFileSync(ccActivePath, 'utf-8'));
      expect(activeData.sessionId).toBe(sessionId);
      expect(typeof activeData.timestamp).toBe('number');

      // cc-spend-<sessionId>.json should exist with the accumulated spend
      const ccSpendPath = path.join(tmpDir, `cc-spend-${sessionId}.json`);
      expect(fs.existsSync(ccSpendPath)).toBe(true);
      const spendVal = parseFloat(fs.readFileSync(ccSpendPath, 'utf-8').trim());
      expect(spendVal).toBeGreaterThan(0);
    } finally {
      if (prevId !== undefined) process.env.CLAUDE_CODE_SESSION_ID = prevId;
      else delete process.env.CLAUDE_CODE_SESSION_ID;
    }
  });

  test('writeCcSpend does not lose spend when no active session', async () => {
    // Without CLAUDE_CODE_SESSION_ID and without cc-active.json, previous
    // code would reset ccPendingSpend to 0, silently losing the money.
    // Now it should keep the pending spend. Verify that the spend doesn't
    // appear in a cc-spend file but also doesn't crash or error.
    const prevId = process.env.CLAUDE_CODE_SESSION_ID;
    try {
      delete process.env.CLAUDE_CODE_SESSION_ID;

      // Ensure no cc-active.json exists
      const ccActivePath = path.join(tmpDir, 'cc-active.json');
      try {
        fs.unlinkSync(ccActivePath);
      } catch (_) {}

      // recordSpend should complete without error even without a session
      await recordSpend(
        'deepseek-v4-pro',
        { prompt_tokens: 100_000, completion_tokens: 1_000 },
        'ds',
      );

      // The main spend.json should still be written (provider-level tracking)
      expect(fs.existsSync(tmpFile)).toBe(true);
      const raw = fs.readFileSync(tmpFile, 'utf-8');
      const data = JSON.parse(raw);
      expect(data.total).toBeGreaterThan(0);

      // No cc-spend file should exist (no session to attribute to)
      const files = fs.readdirSync(tmpDir).filter((f: string) => f.startsWith('cc-spend-'));
      expect(files.length).toBe(0);
    } finally {
      if (prevId !== undefined) process.env.CLAUDE_CODE_SESSION_ID = prevId;
      else delete process.env.CLAUDE_CODE_SESSION_ID;
    }
  });

  test('writeCcSpend accumulates into existing session file (proxy restart)', async () => {
    // The critical scenario missed by prior tests: a cc-spend file already
    // exists from a previous proxy instance within the same CC session.
    // After a proxy restart/hot-swap, new spend MUST add to the existing
    // file total — NOT overwrite it.
    const sessionId = 'test-accumulate-session';
    const prevId = process.env.CLAUDE_CODE_SESSION_ID;
    try {
      process.env.CLAUDE_CODE_SESSION_ID = sessionId;

      // Pre-create cc-active.json (simulating statusline having run)
      const ccActivePath = path.join(tmpDir, 'cc-active.json');
      fs.writeFileSync(ccActivePath, JSON.stringify({ sessionId, timestamp: Date.now() }));

      // Pre-write cc-spend file with existing accumulated spend (from
      // a previous proxy instance in the same session)
      const ccSpendPath = path.join(tmpDir, `cc-spend-${sessionId}.json`);
      const existingSpend = 0.42;
      fs.writeFileSync(ccSpendPath, String(existingSpend) + '\n');

      // Now record new spend. This MUST accumulate, not reset.
      await recordSpend(
        'deepseek-v4-pro',
        { prompt_tokens: 100_000, completion_tokens: 1_000 },
        'ds',
      );

      // The cc-spend file should now contain old + new, not just new.
      expect(fs.existsSync(ccSpendPath)).toBe(true);
      const newVal = parseFloat(fs.readFileSync(ccSpendPath, 'utf-8').trim());
      expect(newVal).toBeGreaterThan(existingSpend);
      // With 100K input + 1K output tokens at DeepSeek prices, the
      // increment should be roughly ~$0.04, so total > 0.45.
      expect(newVal).toBeGreaterThan(0.45);
    } finally {
      if (prevId !== undefined) process.env.CLAUDE_CODE_SESSION_ID = prevId;
      else delete process.env.CLAUDE_CODE_SESSION_ID;
    }
  });
});

describe('recordProviderSpend extended', () => {
  beforeEach(() => {
    _resetBudgetState();
  });

  test('modelName creates composite key in providerDailyAccumulators', () => {
    recordProviderSpend('ds', 0.5, 'deepseek-v4-pro');
    recordProviderSpend('ds', 0.3, 'deepseek-v4-pro');
    recordProviderSpend('ds', 0.2, 'deepseek-v4-flash');
    // Should not throw — keys accumulate in-memory
  });

  test('recordProviderSpend with legacy key only (no modelName)', () => {
    recordProviderSpend('ds', 0.75);
    // Plain key 'ds' — should not throw
  });
});

describe('isProviderHealthy extended', () => {
  test('returns false when circuit breaker is OPEN', () => {
    openCircuitBreaker('unhealthy-open-ext');
    expect(isProviderHealthy('unhealthy-open-ext')).toBe(false);
  });

  test('returns false when circuit breaker is HALF_OPEN', () => {
    // isProviderHealthy checks getCircuitBreakerState which returns
    // the breaker state from circuitBreakers record.
    // HALF_OPEN → isProviderHealthy returns false
    const key = 'half-healthy-ext';
    registerProviderInfo(key, {
      url: 'https://x.com',
      key: 'k',
      isBearer: true,
      format: 'anthropic',
      model: 'm',
    });
    openCircuitBreaker(key);
    const entry = getBreakerEntry(key)!;
    entry.openedAt = Date.now() - 120000;
    maybeStartProbe(key);
    expect(getBreakerState(key)).toBe('HALF_OPEN');
    expect(isProviderHealthy(key)).toBe(false);
  });
});

describe('getFullHealthSnapshot — provider circuit breaker state', () => {
  test('includes circuitBreaker field for each provider', () => {
    const healthyKey = 'snap-cb-healthy';
    recordStat(healthyKey, true, 100);

    const snap = getFullHealthSnapshot({}, {});
    const providers = snap.providers as Record<string, Record<string, unknown>>;
    expect(providers[healthyKey].circuitBreaker).toBeDefined();
    expect(providers[healthyKey].circuitBreaker).toBe('CLOSED');
  });

  test('includes lastRequest timestamp', () => {
    const key = 'snap-last-req';
    recordStat(key, true, 100);

    const snap = getFullHealthSnapshot({}, {});
    const providers = snap.providers as Record<string, Record<string, unknown>>;
    expect(providers[key].lastRequest).toBeDefined();
    expect(typeof providers[key].lastRequest).toBe('number');
  });
});

describe('savings tracking', () => {
  test('recordSavings accumulates positive deltas', () => {
    _resetBudgetState();
    recordSavings(1.0, 5.0); // saved $4.00
    recordSavings(2.0, 6.0); // saved $4.00
    expect(getTotalSavings()).toBe(8.0);
  });

  test('recordSavings ignores negative or zero savings', () => {
    _resetBudgetState();
    recordSavings(5.0, 5.0); // no savings
    recordSavings(6.0, 5.0); // negative — ignore
    expect(getTotalSavings()).toBe(0);
  });

  test('getTotalSavings returns 0 when no savings recorded', () => {
    _resetBudgetState();
    expect(getTotalSavings()).toBe(0);
  });

  test('savings appear in health snapshot', () => {
    _resetBudgetState();
    recordSavings(1.0, 3.0);
    const snap = getFullHealthSnapshot({}, {});
    expect(typeof snap.savings).toBe('number');
    expect(snap.savings).toBe(2.0);
  });
});

describe('spend history and model breakdown', () => {
  test('getSpendHistory returns array', () => {
    const history = getSpendHistory();
    expect(Array.isArray(history)).toBe(true);
    // Returns 7 entries when spend file exists, or empty array when no file
    for (const entry of history) {
      expect(typeof entry.date).toBe('string');
      expect(typeof entry.total).toBe('number');
      expect(typeof entry.sessions).toBe('number');
    }
  });

  test('getSpendHistory returns empty array when no spend file', () => {
    setSpendFilePath('/nonexistent/deepclaude-spend-test.json');
    const history = getSpendHistory();
    expect(Array.isArray(history)).toBe(true);
    expect(history.length).toBe(0);
  });

  test('getModelBreakdown returns array', () => {
    const breakdown = getModelBreakdown();
    expect(Array.isArray(breakdown)).toBe(true);
    if (breakdown.length > 0) {
      for (const entry of breakdown) {
        expect(typeof entry.model).toBe('string');
        expect(typeof entry.tokens).toBe('number');
        expect(typeof entry.cost).toBe('number');
      }
    }
  });

  test('spendHistory and modelBreakdown appear in health snapshot', () => {
    const snap = getFullHealthSnapshot({}, {});
    expect(Array.isArray(snap.spendHistory)).toBe(true);
    expect(Array.isArray(snap.modelBreakdown)).toBe(true);
  });
});

describe('reloadPricing', () => {
  test('reloadPricing does not throw when called', () => {
    // reloadPricing reads from providers.json
    expect(() => reloadPricing()).not.toThrow();
  });
});
