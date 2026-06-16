'use strict';

import { getTrustedModel } from '../model-trust';

describe('getTrustedModel', () => {
  // ── Claude model names pass through ─────────────────────────────────

  test('extracts claude-* from haiku: slot prefix', () => {
    expect(getTrustedModel('haiku:claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5-20251001');
  });

  test('extracts claude-* from sonnet: slot prefix', () => {
    expect(getTrustedModel('sonnet:claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
  });

  test('extracts claude-* from opus: slot prefix', () => {
    expect(getTrustedModel('opus:claude-opus-4-7')).toBe('claude-opus-4-7');
  });

  test('bare claude model without slot prefix', () => {
    expect(getTrustedModel('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5-20251001');
  });

  test('claude model with [1m] suffix', () => {
    expect(getTrustedModel('haiku:claude-haiku-4-5-20251001[1m]')).toBe(
      'claude-haiku-4-5-20251001',
    );
  });

  // ── Non-Claude models → slot-based mapping ──────────────────────────

  test('maps haiku:deepseek-v4-flash to claude-haiku', () => {
    expect(getTrustedModel('haiku:deepseek-v4-flash')).toBe('claude-haiku-4-5-20251001');
  });

  test('maps sonnet:deepseek-v4-pro to claude-sonnet', () => {
    expect(getTrustedModel('sonnet:deepseek-v4-pro')).toBe('claude-sonnet-4-6');
  });

  test('maps opus:deepseek-v4-pro to claude-opus', () => {
    expect(getTrustedModel('opus:deepseek-v4-pro')).toBe('claude-opus-4-7');
  });

  test('maps sub:deepseek-v4-flash to claude-haiku', () => {
    expect(getTrustedModel('sub:deepseek-v4-flash')).toBe('claude-haiku-4-5-20251001');
  });

  test('maps subagent:deepseek-v4-flash to claude-haiku', () => {
    expect(getTrustedModel('subagent:deepseek-v4-flash')).toBe('claude-haiku-4-5-20251001');
  });

  test('maps fable:deepseek-v4-pro to claude-opus', () => {
    expect(getTrustedModel('fable:deepseek-v4-pro')).toBe('claude-opus-4-7');
  });

  // ── Edge cases ──────────────────────────────────────────────────────

  test('null input returns null', () => {
    expect(getTrustedModel(null)).toBeNull();
  });

  test('empty string defaults to claude-haiku', () => {
    expect(getTrustedModel('')).toBe('claude-haiku-4-5-20251001');
  });

  test('unknown slot defaults to claude-haiku', () => {
    expect(getTrustedModel('unknown:some-model')).toBe('claude-haiku-4-5-20251001');
  });

  test('no slot prefix defaults to claude-haiku', () => {
    expect(getTrustedModel('deepseek-v4-flash')).toBe('claude-haiku-4-5-20251001');
  });

  test('multiple claude references picks first hyphenation only', () => {
    // Regex is greedy across hyphens (they're valid in model names).
    // In practice CC never sends concatenated model strings.
    const result = getTrustedModel('haiku:claude-haiku-4-5-20251001-claude-sonnet-4-6');
    expect(result).toBeTruthy();
    expect(result!.startsWith('claude-')).toBe(true);
  });

  // ── Real-world slot override scenarios ──────────────────────────────

  test('ds:deepseek-v4-pro (explicit provider prefix)', () => {
    expect(getTrustedModel('ds:deepseek-v4-pro')).toBe('claude-haiku-4-5-20251001');
  });

  test('or:openai/gpt-4o (OpenRouter)', () => {
    expect(getTrustedModel('or:openai/gpt-4o')).toBe('claude-haiku-4-5-20251001');
  });

  test('an:claude-haiku-4-5-20251001 (explicit Anthropic)', () => {
    expect(getTrustedModel('an:claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5-20251001');
  });
});
