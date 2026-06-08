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

beforeEach(() => {
  _resetBudgetState();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepclaude-test-'));
  tmpFile = path.join(tmpDir, 'spend.json');
  setSpendFilePath(tmpFile);
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (_) { /* cleanup temp dir */ }
});

describe('checkBudget', () => {
  test('returns null when no caps are set', () => {
    expect(checkBudget()).toBeNull();
  });

  test('returns null when session cap not exceeded', () => {
    setSessionCap(5.00);
    // sessionTotal is 0, cap is 5.00
    expect(checkBudget()).toBeNull();
  });

  test('returns reason string when session cap exactly hit', () => {
    setSessionCap(0.50);
    _setSessionTotal(0.50);
    expect(checkBudget()).not.toBeNull();
  });

  test('returns reason string when session cap exceeded', () => {
    setSessionCap(0.50);
    _setSessionTotal(1.00);
    expect(checkBudget()).not.toBeNull();
  });

  test('daily budget from env var is applied correctly', () => {
    const today = new Date().toISOString().slice(0, 10);
    setDailyBudget(5.00);
    // Write spend.json with daily spend of 3.00 (under budget)
    fs.writeFileSync(tmpFile, JSON.stringify({ daily: { [today]: 3.00 } }));
    expect(checkBudget()).toBeNull();

    // Reset cache to force re-read for the exceeded case
    _resetBudgetState();
    setDailyBudget(5.00);
    setSpendFilePath(tmpFile);
    // Write spend.json with daily spend of 6.00 (over budget)
    fs.writeFileSync(tmpFile, JSON.stringify({ daily: { [today]: 6.00 } }));
    expect(checkBudget()).not.toBeNull();
  });

  test('returns null when daily budget not exceeded', () => {
    const today = new Date().toISOString().slice(0, 10);
    setDailyBudget(5.00);
    fs.writeFileSync(tmpFile, JSON.stringify({ daily: { [today]: 3.00 } }));
    expect(checkBudget()).toBeNull();
  });

  test('returns reason string when daily budget exceeded', () => {
    const today = new Date().toISOString().slice(0, 10);
    setDailyBudget(5.00);
    fs.writeFileSync(tmpFile, JSON.stringify({ daily: { [today]: 5.50 } }));
    expect(checkBudget()).not.toBeNull();
  });

  test('both caps set, session cap hit first', () => {
    const today = new Date().toISOString().slice(0, 10);
    setSessionCap(0.50);
    setDailyBudget(5.00);
    _setSessionTotal(0.75);
    // Daily spend is under daily cap but session cap is exceeded
    fs.writeFileSync(tmpFile, JSON.stringify({ daily: { [today]: 1.00 } }));
    const reason = checkBudget();
    expect(reason).not.toBeNull();
    expect(reason).toContain('Session cap');
    expect(reason).toContain('$0.50');
  });

  test('setSessionCap(0) disables cap', () => {
    setSessionCap(5.00);
    _setSessionTotal(10.00);
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
    const today = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(tmpFile, JSON.stringify({ daily: { [today]: 4.20 } }));
    expect(getDailySpend()).toBe(4.20);
  });
});

describe('budget messages', () => {
  test('budget check string includes dollar amounts', () => {
    // Session cap message includes amounts
    setSessionCap(0.50);
    _setSessionTotal(0.75);
    const sessionReason = checkBudget();
    expect(sessionReason).toContain('$0.50');
    expect(sessionReason).toContain('$0.75');

    // Daily budget message includes amounts
    _resetBudgetState();
    setSpendFilePath(tmpFile);
    const today = new Date().toISOString().slice(0, 10);
    setDailyBudget(1.00);
    fs.writeFileSync(tmpFile, JSON.stringify({ daily: { [today]: 1.50 } }));
    const dailyReason = checkBudget();
    expect(dailyReason).toContain('$1.00');
    expect(dailyReason).toContain('$1.50');
  });
});
