'use strict';

import {
  bodyHash,
  shouldUseCanary,
  shouldRollback,
  recordCanaryResult,
  getOrCreateEntry,
  resetState,
  type CanaryConfig,
  type CanaryState,
} from '../canary';

function defaultConfig(overrides?: Partial<CanaryConfig>): CanaryConfig {
  return {
    enabled: true,
    targetProvider: 'oc',
    targetModel: 'big-pickle',
    warmupPercent: 10,
    promoteAfter: 5,
    promoteAfterActive: 10,
    rollbackErrorRate: 0.2,
    ...overrides,
  };
}

function coldState(): CanaryState {
  return {
    phase: 'COLD',
    consecutiveSuccesses: 0,
    recentRequests: 0,
    recentErrors: 0,
    lastUpdated: Date.now(),
  };
}

function warmingState(): CanaryState {
  return {
    phase: 'WARMING',
    consecutiveSuccesses: 0,
    recentRequests: 0,
    recentErrors: 0,
    lastUpdated: Date.now(),
  };
}

function activeState(): CanaryState {
  return {
    phase: 'ACTIVE',
    consecutiveSuccesses: 0,
    recentRequests: 0,
    recentErrors: 0,
    lastUpdated: Date.now(),
  };
}

describe('bodyHash', () => {
  test('returns consistent hash for same body and slot', () => {
    const h1 = bodyHash('{"model":"sonnet:ds:deepseek-v4-pro","messages":[]}', 'sonnet');
    const h2 = bodyHash('{"model":"sonnet:ds:deepseek-v4-pro","messages":[]}', 'sonnet');
    expect(h1).toBe(h2);
  });

  test('returns different hash for different bodies', () => {
    const h1 = bodyHash('body-a', 'sonnet');
    const h2 = bodyHash('body-b', 'sonnet');
    expect(h1).not.toBe(h2);
  });

  test('returns different hash for different slots', () => {
    const h1 = bodyHash('{"model":"sonnet:ds:deepseek-v4-pro"}', 'sonnet');
    const h2 = bodyHash('{"model":"sonnet:ds:deepseek-v4-pro"}', 'opus');
    expect(h1).not.toBe(h2);
  });

  test('hash covers full range', () => {
    const hashes = new Set<number>();
    for (let i = 0; i < 100; i++) {
      hashes.add(bodyHash('payload-' + i, 'sonnet'));
    }
    // High likelihood of getting many distinct hashes with 100 different inputs
    expect(hashes.size).toBeGreaterThan(90);
  });
});

describe('shouldUseCanary', () => {
  test('COLD phase: never routes to canary regardless of hash', () => {
    const config = defaultConfig();
    const state = coldState();

    for (let hash = 0; hash < 1000; hash++) {
      expect(shouldUseCanary(hash, state, config)).toBe(false);
    }
  });

  test('ACTIVE phase: always routes to canary', () => {
    const config = defaultConfig();
    const state = activeState();

    for (let hash = 0; hash < 1000; hash++) {
      expect(shouldUseCanary(hash, state, config)).toBe(true);
    }
  });

  test('WARMING phase: approximately warmupPercent of requests route to canary', () => {
    const config = defaultConfig({ warmupPercent: 10 });
    const state = warmingState();

    let canaryCount = 0;
    const total = 10000;
    for (let hash = 0; hash < total; hash++) {
      if (shouldUseCanary(hash, state, config)) canaryCount++;
    }

    // Should be close to 10%, within 2% tolerance
    const pct = canaryCount / total;
    expect(pct).toBeGreaterThan(0.08);
    expect(pct).toBeLessThan(0.12);
  });

  test('WARMING phase with 50% warmup: approximately half of requests', () => {
    const config = defaultConfig({ warmupPercent: 50 });
    const state = warmingState();

    let canaryCount = 0;
    const total = 10000;
    for (let hash = 0; hash < total; hash++) {
      if (shouldUseCanary(hash, state, config)) canaryCount++;
    }

    const pct = canaryCount / total;
    expect(pct).toBeGreaterThan(0.48);
    expect(pct).toBeLessThan(0.52);
  });

  test('disabled config never routes to canary', () => {
    const config = defaultConfig({ enabled: false });
    const state = activeState();

    expect(shouldUseCanary(0, state, config)).toBe(false);
    expect(shouldUseCanary(50, state, config)).toBe(false);
    expect(shouldUseCanary(99, state, config)).toBe(false);
  });
});

describe('shouldRollback', () => {
  test('returns false in COLD phase regardless of error rate', () => {
    const config = defaultConfig();
    const state: CanaryState = { ...coldState(), recentRequests: 10, recentErrors: 10 };
    expect(shouldRollback(state, config)).toBe(false);
  });

  test('returns false in ACTIVE phase regardless of error rate', () => {
    const config = defaultConfig();
    const state: CanaryState = { ...activeState(), recentRequests: 10, recentErrors: 10 };
    expect(shouldRollback(state, config)).toBe(false);
  });

  test('returns false in WARMING when recentRequests < 5', () => {
    const config = defaultConfig();
    const state: CanaryState = { ...warmingState(), recentRequests: 4, recentErrors: 4 };
    expect(shouldRollback(state, config)).toBe(false);
  });

  test('returns false in WARMING when error rate below threshold', () => {
    const config = defaultConfig({ rollbackErrorRate: 0.2 });
    const state: CanaryState = { ...warmingState(), recentRequests: 10, recentErrors: 1 };
    expect(shouldRollback(state, config)).toBe(false);
  });

  test('returns true in WARMING when error rate exceeds threshold', () => {
    const config = defaultConfig({ rollbackErrorRate: 0.2 });
    const state: CanaryState = { ...warmingState(), recentRequests: 10, recentErrors: 3 };
    expect(shouldRollback(state, config)).toBe(true);
  });

  test('respects custom rollback threshold', () => {
    const config = defaultConfig({ rollbackErrorRate: 0.5 });
    const state: CanaryState = { ...warmingState(), recentRequests: 10, recentErrors: 4 };
    // 4/10 = 0.4 < 0.5, should not rollback
    expect(shouldRollback(state, config)).toBe(false);

    // 6/10 = 0.6 > 0.5, should rollback
    const state2: CanaryState = { ...warmingState(), recentRequests: 10, recentErrors: 6 };
    expect(shouldRollback(state2, config)).toBe(true);
  });
});

describe('recordCanaryResult', () => {
  beforeEach(() => {
    resetState();
  });

  test('COLD -> WARMING: promotes after N consecutive successes', () => {
    const config = defaultConfig({ promoteAfter: 3 });
    const state = coldState();

    recordCanaryResult(true, state, config);
    expect(state.phase).toBe('COLD');
    expect(state.consecutiveSuccesses).toBe(1);

    recordCanaryResult(true, state, config);
    expect(state.phase).toBe('COLD');

    recordCanaryResult(true, state, config);
    expect(state.phase).toBe('WARMING');
    expect(state.consecutiveSuccesses).toBe(3);
    expect(state.recentRequests).toBe(0); // reset on promotion
    expect(state.recentErrors).toBe(0);   // reset on promotion
  });

  test('WARMING -> ACTIVE: promotes after promoteAfterActive consecutive successes', () => {
    const config = defaultConfig({ promoteAfter: 0, promoteAfterActive: 3 });
    const state = warmingState();
    state.consecutiveSuccesses = 0;

    recordCanaryResult(true, state, config);
    expect(state.phase).toBe('WARMING');

    recordCanaryResult(true, state, config);
    expect(state.phase).toBe('WARMING');

    recordCanaryResult(true, state, config);
    expect(state.phase).toBe('ACTIVE');
    expect(state.consecutiveSuccesses).toBe(3);
  });

  test('WARMING -> COLD: rollback on error spike', () => {
    const config = defaultConfig({ promoteAfter: 0, rollbackErrorRate: 0.2 });
    const state = warmingState();

    // 5 successes to build enough request count for rollback check
    for (let i = 0; i < 5; i++) {
      recordCanaryResult(true, state, config);
    }
    expect(state.phase).toBe('WARMING');
    expect(state.recentErrors).toBe(0);
    expect(state.recentRequests).toBe(5);

    // 2 failures: 2/7 = 28.5% > 20% -> rollback
    recordCanaryResult(false, state, config);
    expect(state.phase).toBe('WARMING'); // 1/6 = 16.7% < 20%, no rollback yet
    recordCanaryResult(false, state, config);
    // 2/7 = 28.6% > 20%, should rollback
    expect(state.phase).toBe('COLD');
    expect(state.consecutiveSuccesses).toBe(0);
    expect(state.recentRequests).toBe(0);
    expect(state.recentErrors).toBe(0);
  });

  test('ACTIVE phase is terminal: no further transitions', () => {
    const config = defaultConfig();
    const state = activeState();

    // Even with failures, ACTIVE should stay ACTIVE
    for (let i = 0; i < 20; i++) {
      recordCanaryResult(false, state, config);
    }
    expect(state.phase).toBe('ACTIVE');
  });

  test('failure resets consecutive successes counter', () => {
    const config = defaultConfig({ promoteAfter: 5 });
    const state = coldState();

    recordCanaryResult(true, state, config);
    recordCanaryResult(true, state, config);
    recordCanaryResult(true, state, config);
    expect(state.consecutiveSuccesses).toBe(3);

    recordCanaryResult(false, state, config);
    expect(state.consecutiveSuccesses).toBe(0);
  });

  test('records lastUpdated timestamp', () => {
    const config = defaultConfig();
    const state = coldState();
    const before = state.lastUpdated;

    recordCanaryResult(true, state, config);
    expect(state.lastUpdated).toBeGreaterThanOrEqual(before);
  });
});

describe('getOrCreateEntry', () => {
  beforeEach(() => {
    resetState();
  });

  test('creates new entry for unknown slot', () => {
    const config = defaultConfig();
    const entry = getOrCreateEntry('sonnet', config);

    expect(entry.config).toBe(config);
    expect(entry.state.phase).toBe('COLD');
    expect(entry.state.consecutiveSuccesses).toBe(0);
    expect(entry.state.recentRequests).toBe(0);
    expect(entry.state.recentErrors).toBe(0);
  });

  test('returns same entry for known slot', () => {
    const config = defaultConfig();
    const entry1 = getOrCreateEntry('sonnet', config);
    const entry2 = getOrCreateEntry('sonnet', config);

    expect(entry1).toBe(entry2);
  });

  test('creates separate entries for different slots', () => {
    const config = defaultConfig();
    const sonnetEntry = getOrCreateEntry('sonnet', config);
    const opusEntry = getOrCreateEntry('opus', config);

    expect(sonnetEntry).not.toBe(opusEntry);
  });
});

describe('resetState', () => {
  test('clears all entries', () => {
    const config = defaultConfig();
    getOrCreateEntry('sonnet', config);
    getOrCreateEntry('opus', config);

    resetState();

    const sonnetEntry = getOrCreateEntry('sonnet', config);
    expect(sonnetEntry.state.phase).toBe('COLD');
  });
});

describe('deterministic routing consistency', () => {
  test('same request body always maps to same provider decision', () => {
    const config = defaultConfig({ warmupPercent: 10 });
    const state = warmingState();
    const body = '{"model":"sonnet:ds:deepseek-v4-pro","messages":[{"role":"user","content":"hello"}]}';
    const slot = 'sonnet';

    const hash = bodyHash(body, slot);
    const decision = shouldUseCanary(hash, state, config);

    // Same hash 100 times
    for (let i = 0; i < 100; i++) {
      const h = bodyHash(body, slot);
      expect(h).toBe(hash);
      expect(shouldUseCanary(h, state, config)).toBe(decision);
    }
  });

  test('without canary config: normal routing unaffected', () => {
    // Simulate scenario where there's no canary config
    // The shouldUseCanary function should never be called
    // This test verifies the state machine defaults are safe
    const config = defaultConfig({ enabled: false });
    const state = coldState();

    expect(shouldUseCanary(0, state, config)).toBe(false);
    expect(shouldUseCanary(50, state, config)).toBe(false);
    expect(shouldUseCanary(99, state, config)).toBe(false);
  });
});
