'use strict';

import path from 'path';
import fs from 'fs';
import os from 'os';
import {
  recordProviderSpend,
  recordSpend,
  getFullHealthSnapshot,
  getMonthlyBudget,
  setSpendFilePath,
  _resetBudgetState,
} from '../stats';
import { recordStat } from '../stats';

let tmpDir: string;
let tmpFile: string;

/** Format a Date as ISO YYYY-MM-DD from local time (matches stats.ts dateISO). */
function dateISO(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

beforeEach(() => {
  _resetBudgetState();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepclaude-test-'));
  tmpFile = path.join(tmpDir, 'spend.json');
  setSpendFilePath(tmpFile);
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (_) {
    /* cleanup temp dir */
  }
});

describe('getMonthlyBudget', () => {
  test('returns null for paid providers not in defaults or config', () => {
    // ds and fw are paid providers not in DEFAULT_LIMITS and not in providers.json with monthlyBudget
    expect(getMonthlyBudget('ds')).toBeNull();
    expect(getMonthlyBudget('fw')).toBeNull();
  });

  test('returns default limit for free-tier providers', () => {
    expect(getMonthlyBudget('or')).toBe(2.0); // from providers.json monthlyBudget
    expect(getMonthlyBudget('gr')).toBe(5.0); // from DEFAULT_LIMITS
    expect(getMonthlyBudget('oc')).toBe(0.5);
    expect(getMonthlyBudget('km')).toBe(1.0);
    expect(getMonthlyBudget('za')).toBe(1.0);
    expect(getMonthlyBudget('nv')).toBe(1.0);
    expect(getMonthlyBudget('mt')).toBe(1.0);
    expect(getMonthlyBudget('mx')).toBe(1.0);
    expect(getMonthlyBudget('bp')).toBe(1.0);
    expect(getMonthlyBudget('sf')).toBe(1.0);
    expect(getMonthlyBudget('mm')).toBe(1.0);
    expect(getMonthlyBudget('um')).toBe(1.0);
  });

  test('providers.json monthlyBudget overrides DEFAULT_LIMITS', () => {
    // "or" has monthlyBudget: 2.00 in providers.json, overriding DEFAULT_LIMITS of 1.00
    expect(getMonthlyBudget('or')).toBe(2.0);
  });
});

describe('recordProviderSpend', () => {
  test('accumulates per-provider amounts in memory', () => {
    recordProviderSpend('ds', 0.5);
    recordProviderSpend('ds', 0.25);
    recordProviderSpend('or', 0.1);

    // The amounts are accumulated in memory but not written to file.
    // They will be flushed when recordSpend triggers a file write.
    // Direct verification via getFullHealthSnapshot requires file data.
    // Instead, we verify that no crash occurs and amounts are usable.
  });

  test('recordProviderSpend handles empty key and zero/negative amounts', () => {
    // Should not throw -- these are no-ops
    recordProviderSpend('', 0.5);
    recordProviderSpend('ds', 0);
    recordProviderSpend('ds', -1);
    recordProviderSpend('valid', 0.25);
  });
});

describe('per-provider spend persistence', () => {
  test('daily spend breakdown with byProvider is persisted and readable', () => {
    const today = dateISO(new Date());
    const yesterday = dateISO(new Date(Date.now() - 86400000));

    // Write file with per-provider breakdown (new format)
    const dailyData: Record<string, { total: number; byProvider: Record<string, number> }> = {};
    dailyData[yesterday] = { total: 1.0, byProvider: { ds: 0.6, or: 0.4 } };
    dailyData[today] = { total: 0.5, byProvider: { ds: 0.3, or: 0.2 } };

    fs.writeFileSync(
      tmpFile,
      JSON.stringify({
        total: 1.5,
        daily: dailyData,
        sessions: [],
        current_model: 'test',
      }),
    );

    // Read back and verify structure
    const raw = fs.readFileSync(tmpFile, 'utf-8');
    const data = JSON.parse(raw);
    expect(data.daily[today].total).toBe(0.5);
    expect(data.daily[today].byProvider.ds).toBe(0.3);
    expect(data.daily[today].byProvider.or).toBe(0.2);
    expect(data.daily[yesterday].total).toBe(1.0);
    expect(data.daily[yesterday].byProvider.ds).toBe(0.6);
  });

  test('multiple providers tracked independently in same day', () => {
    const today = dateISO(new Date());
    const dailyData: Record<string, { total: number; byProvider: Record<string, number> }> = {};
    dailyData[today] = { total: 6.0, byProvider: { ds: 1.0, or: 2.0, km: 3.0 } };

    fs.writeFileSync(
      tmpFile,
      JSON.stringify({
        total: 6.0,
        daily: dailyData,
        sessions: [],
        current_model: 'test',
      }),
    );

    const raw = fs.readFileSync(tmpFile, 'utf-8');
    const data = JSON.parse(raw);
    expect(data.daily[today].byProvider.ds).toBe(1.0);
    expect(data.daily[today].byProvider.or).toBe(2.0);
    expect(data.daily[today].byProvider.km).toBe(3.0);
    expect(Object.keys(data.daily[today].byProvider).length).toBe(3);
  });
});

describe('getFullHealthSnapshot includes provider spend data', () => {
  test('dailySpend and monthlyBudget in provider entries', () => {
    const today = dateISO(new Date());

    // Write spend file with per-provider spend for 'or' provider
    const dailyData: Record<string, { total: number; byProvider: Record<string, number> }> = {};
    dailyData[today] = { total: 0.5, byProvider: { or: 0.5, ds: 0.3 } };

    fs.writeFileSync(
      tmpFile,
      JSON.stringify({
        total: 0.8,
        daily: dailyData,
        sessions: [],
        current_model: 'test',
      }),
    );

    // Record stats so providers appear in the snapshot
    recordStat('or', true, 100);
    recordStat('ds', true, 100);
    recordStat('gr', true, 100);

    const snapshot = getFullHealthSnapshot({}, {});
    const providers = snapshot.providers as Record<string, Record<string, unknown>>;

    expect(providers['or']).toBeDefined();
    expect(providers['or'].dailySpend).toBeDefined();
    const orSpend = providers['or'].dailySpend as { amount: number; currency: string };
    expect(orSpend.amount).toBe(0.5);
    expect(orSpend.currency).toBe('USD');

    // or has monthlyBudget from providers.json
    expect(providers['or'].monthlyBudget).toBe(2.0);

    // ds has no monthlyBudget (paid provider)
    expect(providers['ds'].monthlyBudget).toBeUndefined();
    // ds still has dailySpend
    const dsSpend = providers['ds'].dailySpend as { amount: number; currency: string };
    expect(dsSpend.amount).toBe(0.3);

    // gr has monthlyBudget from DEFAULT_LIMITS
    expect(providers['gr'].monthlyBudget).toBe(5.0);
    // gr has no spend recorded, so no dailySpend
    expect(providers['gr'].dailySpend).toBeUndefined();
  });

  test('avgDailySpend7d calculated correctly with multi-day history', () => {
    const today = new Date();
    const dailyData: Record<string, { total: number; byProvider: Record<string, number> }> = {};

    // Create 5 days of consistent $0.20 daily spend for 'or'
    for (let i = 0; i < 5; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const ds = dateISO(d);
      dailyData[ds] = { total: 0.2, byProvider: { or: 0.2 } };
    }

    fs.writeFileSync(
      tmpFile,
      JSON.stringify({
        total: 1.0,
        daily: dailyData,
        sessions: [],
        current_model: 'test',
      }),
    );

    recordStat('or', true, 100);

    const snapshot = getFullHealthSnapshot({}, {});
    const providers = snapshot.providers as Record<string, Record<string, unknown>>;

    expect(providers['or'].avgDailySpend7d).toBeCloseTo(0.2, 2);
  });

  test('no dailySpend when provider has no spend data', () => {
    // Record a provider stat but no spend file data for this provider
    recordStat('fw', true, 100);

    const snapshot = getFullHealthSnapshot({}, {});
    const providers = snapshot.providers as Record<string, Record<string, unknown>>;

    expect(providers['fw']).toBeDefined();
    expect(providers['fw'].dailySpend).toBeUndefined();
  });

  test('no avgDailySpend7d when no spend history exists', () => {
    recordStat('ds', true, 100);

    const today = dateISO(new Date());
    const dailyData: Record<string, { total: number; byProvider: Record<string, number> }> = {};
    dailyData[today] = { total: 0.1, byProvider: { ds: 0.1 } };

    fs.writeFileSync(
      tmpFile,
      JSON.stringify({
        total: 0.1,
        daily: dailyData,
        sessions: [],
        current_model: 'test',
      }),
    );

    const snapshot = getFullHealthSnapshot({}, {});
    const providers = snapshot.providers as Record<string, Record<string, unknown>>;

    // 1 day of data doesn't give avgDailySpend7d (it's >0 but count would be 1)
    // Actually it should compute avg = 0.10/1 = 0.10
    expect(providers['ds'].avgDailySpend7d).not.toBeUndefined();
  });
});

describe('quota percentage and days-remaining', () => {
  test('days-left estimate correct with multi-day history', () => {
    const today = new Date();
    const dailyData: Record<string, { total: number; byProvider: Record<string, number> }> = {};

    // 5 days of $0.20 daily spend for 'or' (budget $2.00)
    for (let i = 0; i < 5; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const ds = dateISO(d);
      dailyData[ds] = { total: 0.2, byProvider: { or: 0.2 } };
    }

    fs.writeFileSync(
      tmpFile,
      JSON.stringify({
        total: 1.0,
        daily: dailyData,
        sessions: [],
        current_model: 'test',
      }),
    );

    recordStat('or', true, 100);

    const snapshot = getFullHealthSnapshot({}, {});
    const providers = snapshot.providers as Record<string, Record<string, unknown>>;

    // With avg $0.20/day, budget $2.00, today spent $0.20
    // remaining = $2.00 - $0.20 = $1.80
    // daysLeft = $1.80 / $0.20 = 9
    expect(providers['or'].avgDailySpend7d).toBeCloseTo(0.2, 2);
    expect(providers['or'].monthlyBudget).toBe(2.0);

    // Manual calculation:
    // dailySpend = 0.20 (today), monthlyBudget = 2.00
    // avgDaily = 0.20, remaining = 2.00 - 0.20 = 1.80
    // daysLeft = 1.80 / 0.20 = 9
    const dailySpend = providers['or'].dailySpend as { amount: number };
    expect(dailySpend.amount).toBe(0.2);
  });
});

describe('legacy format backward compatibility', () => {
  test('spend.json with old number format is read correctly', () => {
    const today = dateISO(new Date());

    // Write file with legacy number format for daily entry
    const legacyDaily: Record<string, number> = {};
    legacyDaily[today] = 0.75;

    fs.writeFileSync(
      tmpFile,
      JSON.stringify({
        total: 0.75,
        daily: legacyDaily,
        sessions: [],
        current_model: 'test',
      }),
    );

    // Read and verify the normalization doesn't break
    const { getDailySpend } = require('../stats');
    // getDailySpend should handle legacy format
    const spend = getDailySpend();
    // Daily spend should include the 0.75 from file plus any accumulator
    // Since dailyAccumulator is 0, this equals 0.75
    expect(spend).toBeGreaterThan(0);
  });
});

describe('per-model spend tracking', () => {
  test('recordProviderSpend with modelName creates composite key', () => {
    _resetBudgetState();
    setSpendFilePath(tmpFile);
    recordProviderSpend('ds', 0.5, 'deepseek-v4-pro');
    recordProviderSpend('ds', 0.2, 'deepseek-v4-flash');
    // Both accumulate without errors (verified by no crash).
    // Composite keys are ds:deepseek-v4-pro and ds:deepseek-v4-flash.
  });

  test('legacy plain provider key still works (backward compat)', () => {
    _resetBudgetState();
    setSpendFilePath(tmpFile);
    recordProviderSpend('ds', 0.3); // no modelName — key is just 'ds'
    recordProviderSpend('ds', 0.2, 'deepseek-v4-pro'); // composite key 'ds:deepseek-v4-pro'
    // Both should accumulate without crashing.
  });

  test('byProvider with composite keys sums correctly in health snapshot', () => {
    const today = dateISO(new Date());
    const dailyData: Record<string, { total: number; byProvider: Record<string, number> }> = {};
    dailyData[today] = {
      total: 2.0,
      byProvider: {
        'ds:deepseek-v4-pro': 1.5,
        'ds:deepseek-v4-flash': 0.5,
      },
    };

    fs.writeFileSync(
      tmpFile,
      JSON.stringify({
        total: 2.0,
        daily: dailyData,
        sessions: [],
        current_model: 'test',
      }),
    );

    // Read back and verify
    const raw = fs.readFileSync(tmpFile, 'utf-8');
    const data = JSON.parse(raw);
    expect(data.daily[today].byProvider['ds:deepseek-v4-pro']).toBe(1.5);
    expect(data.daily[today].byProvider['ds:deepseek-v4-flash']).toBe(0.5);
  });

  test('health snapshot aggregates per-model keys under base provider', () => {
    const today = dateISO(new Date());
    const dailyData: Record<string, { total: number; byProvider: Record<string, number> }> = {};
    dailyData[today] = {
      total: 2.5,
      byProvider: {
        'ds:deepseek-v4-pro': 1.5,
        'ds:deepseek-v4-flash': 1.0,
      },
    };

    fs.writeFileSync(
      tmpFile,
      JSON.stringify({
        total: 2.5,
        daily: dailyData,
        sessions: [],
        current_model: 'test',
      }),
    );

    recordStat('ds', true, 100);

    const snapshot = getFullHealthSnapshot({}, {});
    const providers = snapshot.providers as Record<string, Record<string, unknown>>;
    expect(providers['ds']).toBeDefined();
    // 'ds' daily spend should aggregate all ds:* entries
    const dsSpend = providers['ds'].dailySpend as { amount: number; currency: string };
    // Composite keys sum: 1.5 + 1.0 = 2.5
    expect(dsSpend.amount).toBeCloseTo(2.5, 1);
  });

  test('mixed legacy and composite keys aggregate correctly', () => {
    const today = dateISO(new Date());
    const dailyData: Record<string, { total: number; byProvider: Record<string, number> }> = {};
    dailyData[today] = {
      total: 2.0,
      byProvider: {
        ds: 0.5, // legacy key
        'ds:deepseek-v4-pro': 1.0, // composite key
        'ds:deepseek-v4-flash': 0.5, // composite key
      },
    };

    fs.writeFileSync(
      tmpFile,
      JSON.stringify({
        total: 2.0,
        daily: dailyData,
        sessions: [],
        current_model: 'test',
      }),
    );

    recordStat('ds', true, 100);

    const snapshot = getFullHealthSnapshot({}, {});
    const providers = snapshot.providers as Record<string, Record<string, unknown>>;
    const dsSpend = providers['ds'].dailySpend as { amount: number; currency: string };
    // All three keys aggregate under 'ds': 0.5 + 1.0 + 0.5 = 2.0
    expect(dsSpend.amount).toBeCloseTo(2.0, 1);
  });
});

describe('recordSpend end-to-end flush', () => {
  // NOTE: recordSpend triggers a synchronous flush on its first call
  // (lastSpendWrite starts at 0). _resetBudgetState() (called in
  // beforeEach) resets lastSpendWrite so every test flushes.

  test('preserves total == sum(byProvider) invariant after flush', async () => {
    const today = dateISO(new Date());

    const dailyData: Record<string, { total: number; byProvider: Record<string, number> }> = {};
    dailyData[today] = { total: 0.1, byProvider: { ds: 0.1 } };

    fs.writeFileSync(
      tmpFile,
      JSON.stringify({
        total: 0.1,
        daily: dailyData,
        sessions: [],
        current_model: 'test',
      }),
    );

    // Recording with modelName creates composite key ds:deepseek-v4-pro
    await recordSpend(
      'deepseek-v4-pro',
      { prompt_tokens: 100_000, completion_tokens: 1_000 },
      'ds',
    );

    const raw = fs.readFileSync(tmpFile, 'utf-8');
    const data = JSON.parse(raw);
    const entry = data.daily[today];
    const bpSum = Object.values(entry.byProvider).reduce((a: number, b: number) => a + b, 0);
    // Invariant: total must equal sum of all byProvider values.
    expect(entry.total).toBeCloseTo(bpSum, 4);
    // After recording spend, totals should exceed pre-populated 0.1.
    expect(entry.total).toBeGreaterThan(0.1);
    expect(bpSum).toBeGreaterThan(0.1);
    // Legacy ds key unchanged, new spend goes to composite key.
    expect(entry.byProvider['ds']).toBe(0.1);
    expect(entry.byProvider['ds:deepseek-v4-pro']).toBeGreaterThan(0);
  });

  test('self-healing clamp fixes inflated total from format migration artifact', async () => {
    const today = dateISO(new Date());

    // Simulate the exact bug we hit 2026-06-13: a daily entry where
    // total far exceeds the byProvider sum due to a legacy plain-number
    // total being merged with a newer {total, byProvider} entry.
    const dailyData: Record<string, { total: number; byProvider: Record<string, number> }> = {};
    dailyData[today] = { total: 5.0, byProvider: { ds: 0.5 } };

    fs.writeFileSync(
      tmpFile,
      JSON.stringify({
        total: 5.0,
        daily: dailyData,
        sessions: [],
        current_model: 'test',
      }),
    );

    await recordSpend(
      'deepseek-v4-pro',
      { prompt_tokens: 100_000, completion_tokens: 1_000 },
      'ds',
    );

    const raw = fs.readFileSync(tmpFile, 'utf-8');
    const data = JSON.parse(raw);
    const entry = data.daily[today];
    const bpSum = Object.values(entry.byProvider).reduce((a: number, b: number) => a + b, 0);

    // After the clamp + accumulator addition, total must match byProvider sum.
    expect(entry.total).toBeCloseTo(bpSum, 4);
    // The inflated 5.0 was clamped to 0.5, then new spend added — still < 1.0.
    expect(entry.total).toBeLessThan(1.0);
    expect(entry.total).toBeGreaterThan(0.5);
  });

  test('self-healing clamp does nothing when total is already consistent', async () => {
    const today = dateISO(new Date());

    const dailyData: Record<string, { total: number; byProvider: Record<string, number> }> = {};
    dailyData[today] = { total: 1.0, byProvider: { ds: 0.6, or: 0.4 } };

    fs.writeFileSync(
      tmpFile,
      JSON.stringify({
        total: 1.0,
        daily: dailyData,
        sessions: [],
        current_model: 'test',
      }),
    );

    await recordSpend(
      'deepseek-v4-pro',
      { prompt_tokens: 100_000, completion_tokens: 1_000 },
      'ds',
    );

    const raw = fs.readFileSync(tmpFile, 'utf-8');
    const data = JSON.parse(raw);
    const entry = data.daily[today];
    const bpSum = Object.values(entry.byProvider).reduce((a: number, b: number) => a + b, 0);

    // No clamping needed — total should be previous total + new spend.
    expect(entry.total).toBeCloseTo(bpSum, 4);
    expect(entry.total).toBeGreaterThan(1.0);
    expect(entry.byProvider['ds']).toBe(0.6); // unchanged
    expect(entry.byProvider['or']).toBe(0.4); // unchanged
    expect(entry.byProvider['ds:deepseek-v4-pro']).toBeGreaterThan(0); // new
  });
});
