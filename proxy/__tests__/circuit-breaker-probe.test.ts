'use strict';

import {
    openCircuitBreaker,
    maybeStartProbe,
    recordProbeResult,
    getBreakerState,
    getBreakerEntry,
    isProviderHealthy,
    getCircuitBreakerState,
    registerProviderInfo,
    getProviderInfo,
    recordStat,
} from '../stats';

const PROBE_URL = 'https://api.test.com/v1/messages';
const PROBE_KEY = 'test-key';

function reg(key: string): void {
    registerProviderInfo(key, {
        url: PROBE_URL,
        key: PROBE_KEY,
        isBearer: true,
        format: 'anthropic',
        model: 'claude-sonnet-4-20250514',
    });
}

describe('circuit breaker state machine', () => {
    test('new provider starts CLOSED', () => {
        expect(getBreakerState('new-prov')).toBe('CLOSED');
        expect(getBreakerEntry('new-prov')).toBeUndefined();
    });

    test('after enough failures transitions to OPEN', () => {
        const key = 'open-transition';
        for (let i = 0; i < 5; i++) {
            recordStat(key, false, 100);
        }
        expect(getBreakerState(key)).toBe('OPEN');
        const entry = getBreakerEntry(key);
        expect(entry).toBeDefined();
        expect(entry!.state).toBe('OPEN');
        expect(entry!.cooldownMs).toBe(60000);
        expect(entry!.probeCount).toBe(0);
    });

    test('OPEN transitions to HALF_OPEN after cooldown elapses', () => {
        const key = 'half-open-transition';
        reg(key);
        for (let i = 0; i < 5; i++) {
            recordStat(key, false, 100);
        }
        const entry = getBreakerEntry(key)!;
        entry.openedAt = Date.now() - 120000;

        const probeTarget = maybeStartProbe(key);
        expect(probeTarget).not.toBeNull();
        expect(probeTarget!.url).toBeDefined();
        expect(getBreakerState(key)).toBe('HALF_OPEN');
    });

    test('successful probe transitions HALF_OPEN to CLOSED', () => {
        const key = 'probe-success';
        reg(key);
        for (let i = 0; i < 5; i++) {
            recordStat(key, false, 100);
        }
        const entry = getBreakerEntry(key)!;
        entry.openedAt = Date.now() - 120000;
        maybeStartProbe(key);
        expect(getBreakerState(key)).toBe('HALF_OPEN');

        recordProbeResult(key, true);
        expect(getBreakerState(key)).toBe('CLOSED');
        expect(getBreakerEntry(key)).toBeUndefined();
    });

    test('failed probe transitions HALF_OPEN to OPEN with doubled cooldown', () => {
        const key = 'probe-fail';
        reg(key);
        for (let i = 0; i < 5; i++) {
            recordStat(key, false, 100);
        }
        const entry = getBreakerEntry(key)!;
        entry.openedAt = Date.now() - 120000;
        maybeStartProbe(key);
        expect(getBreakerState(key)).toBe('HALF_OPEN');

        recordProbeResult(key, false);
        expect(getBreakerState(key)).toBe('OPEN');
        expect(entry.cooldownMs).toBe(120000);
        expect(entry.consecutiveProbeFailures).toBe(1);

        // Cooldown has not elapsed yet -- probe should not start
        expect(maybeStartProbe(key)).toBeNull();

        // Advance openedAt past the new cooldown (120s)
        entry.openedAt = Date.now() - 240000;
        const secondProbe = maybeStartProbe(key);
        expect(secondProbe).not.toBeNull();
        expect(getBreakerState(key)).toBe('HALF_OPEN');
    });

    test('cooldown doubles up to max (300s)', () => {
        const key = 'cooldown-max';
        reg(key);
        for (let i = 0; i < 5; i++) {
            recordStat(key, false, 100);
        }
        const entry = getBreakerEntry(key)!;
        expect(entry.cooldownMs).toBe(60000);

        // First failure: 60s -> 120s
        entry.openedAt = Date.now() - 120000;
        maybeStartProbe(key);
        recordProbeResult(key, false);
        expect(entry.cooldownMs).toBe(120000);

        // Second failure: 120s -> 240s
        entry.openedAt = Date.now() - 240000;
        maybeStartProbe(key);
        recordProbeResult(key, false);
        expect(entry.cooldownMs).toBe(240000);

        // Third failure: 240s -> 300s (capped)
        entry.openedAt = Date.now() - 360000;
        maybeStartProbe(key);
        recordProbeResult(key, false);
        expect(entry.cooldownMs).toBe(300000);

        // Fourth failure: stays at 300s
        entry.openedAt = Date.now() - 360000;
        maybeStartProbe(key);
        recordProbeResult(key, false);
        expect(entry.cooldownMs).toBe(300000);
    });

    test('after MAX_PROBES failures, allows another probe round after long cooldown', () => {
        const key = 'max-probes-cooldown';
        reg(key);
        for (let i = 0; i < 5; i++) {
            recordStat(key, false, 100);
        }
        const entry = getBreakerEntry(key)!;

        for (let attempt = 0; attempt < 5; attempt++) {
            entry.openedAt = Date.now() - 600000;
            const probeTarget = maybeStartProbe(key);
            expect(probeTarget).not.toBeNull();
            recordProbeResult(key, false);
        }

        // After 5 failed probes, the 6th is blocked if cooldown hasn't elapsed
        entry.openedAt = Date.now() - 60000; // only 1 min past (less than 5 min cooldown)
        expect(maybeStartProbe(key)).toBeNull();
        expect(getBreakerState(key)).toBe('OPEN');

        // After 5+ min cooldown, another probe round is allowed
        entry.openedAt = Date.now() - 360000; // 6 min past (> 5 min cooldown)
        const probeTarget = maybeStartProbe(key);
        expect(probeTarget).not.toBeNull();
        expect(getBreakerState(key)).toBe('HALF_OPEN');
    });

    test('isProviderHealthy returns true for CLOSED', () => {
        expect(isProviderHealthy('healthy-closed')).toBe(true);
    });

    test('isProviderHealthy returns false for OPEN', () => {
        openCircuitBreaker('unhealthy-open');
        expect(isProviderHealthy('unhealthy-open')).toBe(false);
    });

    test('isProviderHealthy returns true for HALF_OPEN', () => {
        const key = 'half-healthy';
        reg(key);
        openCircuitBreaker(key);
        const entry = getBreakerEntry(key)!;
        entry.openedAt = Date.now() - 120000;
        maybeStartProbe(key);
        expect(getBreakerState(key)).toBe('HALF_OPEN');
        expect(isProviderHealthy(key)).toBe(true);
    });

    test('CLOSED provider never starts a probe', () => {
        expect(maybeStartProbe('never-opened')).toBeNull();
    });

    test('registering and retrieving provider info works', () => {
        const key = 'test-info';
        registerProviderInfo(key, {
            url: 'https://api.test.com',
            key: 'test-key',
            isBearer: true,
            format: 'anthropic',
            model: 'claude-sonnet-4-20250514',
        });
        const info = getProviderInfo(key);
        expect(info).toBeDefined();
        expect(info!.url).toBe('https://api.test.com');
        expect(info!.key).toBe('test-key');
        expect(info!.isBearer).toBe(true);
        expect(info!.format).toBe('anthropic');
        expect(info!.model).toBe('claude-sonnet-4-20250514');
    });

    test('cooldown does not elapse early', () => {
        const key = 'early-cooldown';
        reg(key);
        for (let i = 0; i < 5; i++) {
            recordStat(key, false, 100);
        }
        // Breaker just opened, cooldown has not elapsed
        expect(maybeStartProbe(key)).toBeNull();
        expect(getBreakerState(key)).toBe('OPEN');

        // Advance openedAt by only 30s (less than 60s cooldown)
        const entry = getBreakerEntry(key)!;
        entry.openedAt = Date.now() - 30000;
        expect(maybeStartProbe(key)).toBeNull();
        expect(getBreakerState(key)).toBe('OPEN');
    });
});

describe('getCircuitBreakerState backward compatibility', () => {
    test('returns UNTESTED for unknown provider', () => {
        expect(getCircuitBreakerState('unknown')).toBe('UNTESTED');
    });

    test('returns OPEN for provider with active breaker', () => {
        openCircuitBreaker('cb-state-open');
        expect(getCircuitBreakerState('cb-state-open')).toBe('OPEN');
    });

    test('returns HALF_OPEN for provider in probe state', () => {
        const key = 'cb-state-half';
        reg(key);
        openCircuitBreaker(key);
        const entry = getBreakerEntry(key)!;
        entry.openedAt = Date.now() - 120000;
        maybeStartProbe(key);
        expect(getCircuitBreakerState(key)).toBe('HALF_OPEN');
    });
});
