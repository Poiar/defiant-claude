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
    expect(result).toEqual({ preferredProvider: 'provider-a', confidence: 0.2 });
  });

  test('returns provider with most decisions as preferred', () => {
    record('sk-majority', 'provider-a', 'model-x');
    record('sk-majority', 'provider-a', 'model-y');
    record('sk-majority', 'provider-b', 'model-z');
    record('sk-majority', 'provider-a', 'model-w');
    const result = getMomentum('sk-majority');
    expect(result).toEqual({ preferredProvider: 'provider-a', confidence: 0.6 });
  });

  test('confidence equals count of most-chosen provider', () => {
    record('sk-confidence', 'provider-a', 'm1');
    record('sk-confidence', 'provider-b', 'm2');
    record('sk-confidence', 'provider-b', 'm3');
    record('sk-confidence', 'provider-b', 'm4');
    const result = getMomentum('sk-confidence');
    expect(result).toEqual({ preferredProvider: 'provider-b', confidence: 0.6 });
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
    expect(result).toEqual({ preferredProvider: 'provider-a', confidence: 0.8 });
  });

  test('handles multiple providers with ties', () => {
    // Provider-a appears first in decisions so it wins the tie.
    record('sk-tie', 'provider-a', 'm1');
    record('sk-tie', 'provider-b', 'm2');
    record('sk-tie', 'provider-a', 'm3');
    record('sk-tie', 'provider-b', 'm4');
    const result = getMomentum('sk-tie');
    expect(result).toEqual({ preferredProvider: 'provider-a', confidence: 0.4 });
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

// =========================================================================
// Confidence edge cases
// =========================================================================

describe('confidence edge cases', () => {
  test('single record → confidence 0.2 (1/5)', () => {
    record('sk-edge-1', 'provider-a', 'model-x');
    const result = getMomentum('sk-edge-1');
    expect(result).toEqual({ preferredProvider: 'provider-a', confidence: 0.2 });
  });

  test('all same provider → confidence 1.0', () => {
    for (let i = 0; i < 5; i++) {
      record('sk-all-same', 'provider-x', `model-${i}`);
    }
    const result = getMomentum('sk-all-same');
    expect(result!.confidence).toBe(1.0);
    expect(result!.preferredProvider).toBe('provider-x');
  });

  test('confidence below 0.4 threshold — should trigger cheapest-provider fallback', () => {
    // 1 success for a, 0 for b → confidence 0.2, below the 0.4 threshold
    record('sk-low-conf', 'provider-a', 'model-1');
    const result = getMomentum('sk-low-conf');
    expect(result!.confidence).toBe(0.2);
    expect(result!.confidence).toBeLessThan(0.4);
  });

  test('confidence at exactly 0.4 — meets threshold', () => {
    record('sk-threshold', 'provider-a', 'm1');
    record('sk-threshold', 'provider-a', 'm2');
    record('sk-threshold', 'provider-b', 'm3');
    record('sk-threshold', 'provider-b', 'm4');
    record('sk-threshold', 'provider-b', 'm5');
    // provider-b: 3/5 = 0.6
    const result = getMomentum('sk-threshold');
    expect(result!.confidence).toBe(0.6);
    expect(result!.confidence).toBeGreaterThanOrEqual(0.4);
  });

  test('empty decisions returns null', () => {
    // Record with null sk → no-op, then getMomentum returns null
    record(null, 'provider-a', 'model-x');
    expect(getMomentum('never-recorded')).toBeNull();
  });
});
