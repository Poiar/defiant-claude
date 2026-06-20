'use strict';

import path from 'path';
import fs from 'fs';
import os from 'os';
import {
  checkBudget,
  setSessionCap,
  setDailyBudget,
  getDailySpend,
  setSpendFilePath,
  _resetBudgetState,
  _setSessionTotal,
} from '../stats';

let tmpDir: string;
let tmpFile: string;

/** Format a Date as ISO YYYY-MM-DD from local time (matches stats.ts dateISO). */
function dateISO(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

beforeEach(() => {
  _resetBudgetState();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'defiant-test-'));
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

describe('checkBudget', () => {
  test('returns null when no caps are set', () => {
    expect(checkBudget()).toBeNull();
  });

  test('returns null when session cap not exceeded', () => {
    setSessionCap(5.0);
    // sessionTotal is 0, cap is 5.00
    expect(checkBudget()).toBeNull();
  });

  test('returns reason string when session cap exactly hit', () => {
    setSessionCap(0.5);
    _setSessionTotal(0.5);
    expect(checkBudget()).not.toBeNull();
  });

  test('returns reason string when session cap exceeded', () => {
    setSessionCap(0.5);
    _setSessionTotal(1.0);
    expect(checkBudget()).not.toBeNull();
  });

  test('daily budget from env var is applied correctly', () => {
    const today = dateISO(new Date());
    setDailyBudget(5.0);
    // Write spend.json with daily spend of 3.00 (under budget)
    fs.writeFileSync(tmpFile, JSON.stringify({ daily: { [today]: 3.0 } }));
    expect(checkBudget()).toBeNull();

    // Reset cache to force re-read for the exceeded case
    _resetBudgetState();
    setDailyBudget(5.0);
    setSpendFilePath(tmpFile);
    // Write spend.json with daily spend of 6.00 (over budget)
    fs.writeFileSync(tmpFile, JSON.stringify({ daily: { [today]: 6.0 } }));
    expect(checkBudget()).not.toBeNull();
  });

  test('returns null when daily budget not exceeded', () => {
    const today = dateISO(new Date());
    setDailyBudget(5.0);
    fs.writeFileSync(tmpFile, JSON.stringify({ daily: { [today]: 3.0 } }));
    expect(checkBudget()).toBeNull();
  });

  test('returns reason string when daily budget exceeded', () => {
    const today = dateISO(new Date());
    setDailyBudget(5.0);
    fs.writeFileSync(tmpFile, JSON.stringify({ daily: { [today]: 5.5 } }));
    expect(checkBudget()).not.toBeNull();
  });

  test('both caps set, session cap hit first', () => {
    const today = dateISO(new Date());
    setSessionCap(0.5);
    setDailyBudget(5.0);
    _setSessionTotal(0.75);
    // Daily spend is under daily cap but session cap is exceeded
    fs.writeFileSync(tmpFile, JSON.stringify({ daily: { [today]: 1.0 } }));
    const reason = checkBudget();
    expect(reason).not.toBeNull();
    expect(reason).toContain('Session cap');
    expect(reason).toContain('$0.50');
  });

  test('setSessionCap(0) disables cap', () => {
    setSessionCap(5.0);
    _setSessionTotal(10.0);
    expect(checkBudget()).not.toBeNull();
    setSessionCap(0);
    expect(checkBudget()).toBeNull();
  });
});

describe('getDailySpend', () => {
  test('returns 0 when no spend file exists', () => {
    expect(getDailySpend()).toBe(0);
  });

  test('returns correct amount for today', () => {
    const today = dateISO(new Date());
    fs.writeFileSync(tmpFile, JSON.stringify({ daily: { [today]: 4.2 } }));
    expect(getDailySpend()).toBe(4.2);
  });
});

describe('budget messages', () => {
  test('budget check string includes dollar amounts', () => {
    // Session cap message includes amounts
    setSessionCap(0.5);
    _setSessionTotal(0.75);
    const sessionReason = checkBudget();
    expect(sessionReason).toContain('$0.50');
    expect(sessionReason).toContain('$0.75');

    // Daily budget message includes amounts
    _resetBudgetState();
    setSpendFilePath(tmpFile);
    const today = dateISO(new Date());
    setDailyBudget(1.0);
    fs.writeFileSync(tmpFile, JSON.stringify({ daily: { [today]: 1.5 } }));
    const dailyReason = checkBudget();
    expect(dailyReason).toContain('$1.00');
    expect(dailyReason).toContain('$1.50');
  });
});
