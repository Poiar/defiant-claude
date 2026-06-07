'use strict';

import { recordStat, recordUsage, isProviderHealthy, getHealthSnapshot } from '../stats';

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
