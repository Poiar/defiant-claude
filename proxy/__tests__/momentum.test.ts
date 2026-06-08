'use strict';

import { record, getMomentum } from '../momentum';

describe('record + getMomentum', () => {
    test('returns null for unknown session key', () => {
        expect(getMomentum('nonexistent-key')).toBeNull();
    });

    test('returns null for null/undefined session key', () => {
        expect(getMomentum(null)).toBeNull();
        expect(getMomentum(undefined as unknown as string)).toBeNull();
    });

    test('returns preferred provider after single record', () => {
        record('sk-single', 'provider-a', 'model-x');
        const result = getMomentum('sk-single');
        expect(result).toEqual({ preferredProvider: 'provider-a', confidence: 1 });
    });

    test('returns provider with most decisions as preferred', () => {
        record('sk-majority', 'provider-a', 'model-x');
        record('sk-majority', 'provider-a', 'model-y');
        record('sk-majority', 'provider-b', 'model-z');
        record('sk-majority', 'provider-a', 'model-w');
        const result = getMomentum('sk-majority');
        expect(result).toEqual({ preferredProvider: 'provider-a', confidence: 3 });
    });

    test('confidence equals count of most-chosen provider', () => {
        record('sk-confidence', 'provider-a', 'm1');
        record('sk-confidence', 'provider-b', 'm2');
        record('sk-confidence', 'provider-b', 'm3');
        record('sk-confidence', 'provider-b', 'm4');
        const result = getMomentum('sk-confidence');
        expect(result).toEqual({ preferredProvider: 'provider-b', confidence: 3 });
    });

    test('ring buffer: only keeps last 5 decisions', () => {
        // Record 6 decisions — only the last 5 survive the ring buffer.
        // First decision (provider-a m1) is dropped.
        record('sk-ring', 'provider-a', 'm1');
        record('sk-ring', 'provider-a', 'm2');
        record('sk-ring', 'provider-a', 'm3');
        record('sk-ring', 'provider-a', 'm4');
        record('sk-ring', 'provider-a', 'm5');
        record('sk-ring', 'provider-b', 'm6');
        // Ring now holds: a(m2), a(m3), a(m4), a(m5), b(m6)
        const result = getMomentum('sk-ring');
        expect(result).toEqual({ preferredProvider: 'provider-a', confidence: 4 });
    });

    test('handles multiple providers with ties', () => {
        // Provider-a appears first in decisions so it wins the tie.
        record('sk-tie', 'provider-a', 'm1');
        record('sk-tie', 'provider-b', 'm2');
        record('sk-tie', 'provider-a', 'm3');
        record('sk-tie', 'provider-b', 'm4');
        const result = getMomentum('sk-tie');
        expect(result).toEqual({ preferredProvider: 'provider-a', confidence: 2 });
    });

    test('record does nothing for null/undefined sk', () => {
        record(null, 'provider-a', 'model-x');
        record(undefined as unknown as string, 'provider-a', 'model-x');
        // No crash expected; getMomentum for those keys returns null.
        expect(getMomentum(null)).toBeNull();
        expect(getMomentum(undefined as unknown as string)).toBeNull();
    });
});

describe('sessionKey', () => {
    test('re-exported from momentum', () => {
        const { sessionKey } = require('../momentum');
        expect(typeof sessionKey).toBe('function');
    });
});
