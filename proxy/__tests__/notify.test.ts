'use strict';

// Mock child_process.exec to avoid real OS notifications during tests
const mockExec = jest.fn();
jest.mock('child_process', () => ({
  exec: (...args: unknown[]) => {
    mockExec(...args);
  },
}));

import { sendNotification, checkBudgetNotifications, _resetFiredThresholds } from '../notify';

describe('notify', () => {
  beforeEach(() => {
    mockExec.mockClear();
    _resetFiredThresholds();
    delete process.env.DEFIANT_BUDGET_WARNING;
  });

  describe('sendNotification', () => {
    test('calls exec with notify-send on linux', () => {
      const orig = process.platform;
      Object.defineProperty(process, 'platform', { value: 'linux' });
      sendNotification('Test Title', 'Test Message');
      expect(mockExec).toHaveBeenCalledTimes(1);
      expect(mockExec.mock.calls[0][0]).toContain('notify-send');
      Object.defineProperty(process, 'platform', { value: orig });
    });

    test('calls exec with osascript on darwin', () => {
      const orig = process.platform;
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      sendNotification('Test Title', 'Test Message');
      expect(mockExec).toHaveBeenCalledTimes(1);
      expect(mockExec.mock.calls[0][0]).toContain('osascript');
      Object.defineProperty(process, 'platform', { value: orig });
    });

    test('calls exec with powershell on win32', () => {
      const orig = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32' });
      sendNotification('Test Title', 'Test Message');
      expect(mockExec).toHaveBeenCalledTimes(1);
      expect(mockExec.mock.calls[0][0]).toContain('powershell');
      Object.defineProperty(process, 'platform', { value: orig });
    });

    test('escapes double quotes in title and message', () => {
      const orig = process.platform;
      Object.defineProperty(process, 'platform', { value: 'linux' });
      sendNotification('Title "test"', 'Message "test"');
      const cmd = mockExec.mock.calls[0][0] as string;
      expect(cmd).toContain('\\"test\\"');
      Object.defineProperty(process, 'platform', { value: orig });
    });

    test('does nothing on unknown platform', () => {
      const orig = process.platform;
      Object.defineProperty(process, 'platform', { value: 'freebsd' });
      sendNotification('Test', 'Test');
      expect(mockExec).not.toHaveBeenCalled();
      Object.defineProperty(process, 'platform', { value: orig });
    });

    test('sends notification synchronously without errors', () => {
      const orig = process.platform;
      Object.defineProperty(process, 'platform', { value: 'linux' });
      // Should never throw for any valid input
      expect(() => sendNotification('', '')).not.toThrow();
      expect(() => sendNotification('T', 'M')).not.toThrow();
      Object.defineProperty(process, 'platform', { value: orig });
    });
  });

  describe('checkBudgetNotifications', () => {
    test('returns false when DEFIANT_BUDGET_WARNING is not set', () => {
      expect(checkBudgetNotifications(5, 10, 'test budget')).toBe(false);
    });

    test('returns false when budget cap is <= 0', () => {
      process.env.DEFIANT_BUDGET_WARNING = '50,75,100';
      expect(checkBudgetNotifications(5, 0, 'test budget')).toBe(false);
    });

    test('returns false when warn env has invalid values only', () => {
      process.env.DEFIANT_BUDGET_WARNING = 'abc,xyz';
      expect(checkBudgetNotifications(5, 10, 'test budget')).toBe(false);
    });

    test('fires notification at 50% threshold', () => {
      process.env.DEFIANT_BUDGET_WARNING = '50,75,100';
      checkBudgetNotifications(5.5, 10, 'daily budget');
      expect(mockExec).toHaveBeenCalledTimes(1);
      const cmd = mockExec.mock.calls[0][0] as string;
      expect(cmd).toContain('50%');
    });

    test('fires multiple notifications at different thresholds', () => {
      process.env.DEFIANT_BUDGET_WARNING = '50,75,100';
      checkBudgetNotifications(5, 10, 'daily budget'); // 50%
      mockExec.mockClear();
      checkBudgetNotifications(8, 10, 'daily budget'); // 80% → crosses 75%
      expect(mockExec).toHaveBeenCalledTimes(1);
      const cmd = mockExec.mock.calls[0][0] as string;
      expect(cmd).toContain('75%');
    });

    test('does not fire duplicate notifications for same threshold', () => {
      process.env.DEFIANT_BUDGET_WARNING = '50,75,100';
      checkBudgetNotifications(6, 10, 'daily budget'); // 60% → crosses 50%
      expect(mockExec).toHaveBeenCalledTimes(1);
      mockExec.mockClear();
      checkBudgetNotifications(7, 10, 'daily budget'); // 70% → still only 50% passed
      expect(mockExec).not.toHaveBeenCalled();
    });

    test('fires at 100% with exhausted message', () => {
      process.env.DEFIANT_BUDGET_WARNING = '100';
      checkBudgetNotifications(10, 10, 'daily budget');
      const cmd = mockExec.mock.calls[0][0] as string;
      expect(cmd).toContain('exhausted');
    });

    test('handles invalid threshold values gracefully', () => {
      process.env.DEFIANT_BUDGET_WARNING = '50,abc,100';
      expect(checkBudgetNotifications(8, 10, 'daily budget')).toBe(true);
      expect(mockExec).toHaveBeenCalledTimes(1); // fired at 50, skipped invalid
    });

    test('handles edge case: exactly at threshold boundary', () => {
      process.env.DEFIANT_BUDGET_WARNING = '50';
      expect(checkBudgetNotifications(5.0, 10, 'test')).toBe(true);
    });

    test('handles edge case: just below threshold', () => {
      process.env.DEFIANT_BUDGET_WARNING = '50';
      expect(checkBudgetNotifications(4.99, 10, 'test')).toBe(false);
    });
  });
});
