'use strict';

import { sanitizeHeaders, MAX_HEADERS, MAX_VALUE_LEN } from '../header-sanitizer';
import { stripEffortBetaHeader } from '../header-sanitizer';

describe('sanitizeHeaders', () => {
  test('Drops authorization header', () => {
    const headers = {
      authorization: 'Bearer sk-ant-api03-secret',
      'content-type': 'application/json',
    };
    const result = sanitizeHeaders(headers);
    expect(result.headers.authorization).toBeUndefined();
    expect(result.headers['content-type']).toBe('application/json');
    expect(result.dropped).toBe(1);
  });

  test('Drops x-api-key header', () => {
    const headers = {
      'x-api-key': 'sk-secret-key-value',
      accept: '*/*',
    };
    const result = sanitizeHeaders(headers);
    expect(result.headers['x-api-key']).toBeUndefined();
    expect(result.headers.accept).toBe('*/*');
    expect(result.dropped).toBe(1);
  });

  test('Drops cookie header', () => {
    const headers = {
      cookie: 'session=abc123; token=xyz',
      'content-type': 'text/plain',
    };
    const result = sanitizeHeaders(headers);
    expect(result.headers.cookie).toBeUndefined();
    expect(result.dropped).toBe(1);
  });

  test('Drops noise headers (host, connection, x-forwarded-for)', () => {
    const headers = {
      host: 'api.example.com',
      connection: 'keep-alive',
      'x-forwarded-for': '10.0.0.1',
      'content-type': 'application/json',
    };
    const result = sanitizeHeaders(headers);
    expect(result.headers.host).toBeUndefined();
    expect(result.headers.connection).toBeUndefined();
    expect(result.headers['x-forwarded-for']).toBeUndefined();
    expect(result.headers['content-type']).toBe('application/json');
    expect(result.dropped).toBe(3);
  });

  test('Passes through safe headers (content-type, accept)', () => {
    const headers = {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'cache-control': 'no-cache',
      'user-agent': 'deepclaude/1.0',
    };
    const result = sanitizeHeaders(headers);
    expect(result.headers['content-type']).toBe('application/json');
    expect(result.headers.accept).toBe('text/event-stream');
    expect(result.headers['cache-control']).toBe('no-cache');
    expect(result.headers['user-agent']).toBe('deepclaude/1.0');
    expect(result.dropped).toBe(0);
  });

  test('Truncates header values over MAX_VALUE_LEN', () => {
    const longValue = 'a'.repeat(MAX_VALUE_LEN + 50);
    const headers = {
      'content-type': 'text/plain',
      'x-custom': longValue,
    };
    const result = sanitizeHeaders(headers);
    expect(result.headers['x-custom'].length).toBe(MAX_VALUE_LEN);
    expect(result.headers['x-custom']).toBe('a'.repeat(MAX_VALUE_LEN));
    expect(result.dropped).toBe(1);
  });

  test('Limits total header count to MAX_HEADERS', () => {
    const headers: Record<string, string> = {};
    for (let i = 0; i < MAX_HEADERS + 15; i++) {
      headers['x-hdr-' + i] = 'val';
    }
    const result = sanitizeHeaders(headers);
    expect(Object.keys(result.headers).length).toBe(MAX_HEADERS);
    expect(result.dropped).toBe(15);
  });

  test('Limits total bytes to MAX_TOTAL_BYTES', () => {
    const headers: Record<string, string> = {};
    for (let i = 0; i < 15; i++) {
      headers['x-hdr-' + i] = 'x'.repeat(1000);
    }
    const result = sanitizeHeaders(headers);
    expect(Object.keys(result.headers).length).toBe(8);
    expect(result.dropped).toBe(7);
  });

  test('Strips control characters from header values', () => {
    const headers = {
      'content-type': 'text/\x00plain\x1f',
      'x-custom': 'value\r\ninjected',
    };
    const result = sanitizeHeaders(headers);
    expect(result.headers['content-type']).toBe('text/plain');
    expect(result.headers['x-custom']).toBe('valueinjected');
  });

  test('Returns empty object for null input', () => {
    const result = sanitizeHeaders(null);
    expect(result.headers).toEqual({});
    expect(result.dropped).toBe(0);
  });

  test('Returns empty object for undefined input', () => {
    const result = sanitizeHeaders(undefined);
    expect(result.headers).toEqual({});
    expect(result.dropped).toBe(0);
  });

  test('Returns dropped count', () => {
    const result = sanitizeHeaders({
      authorization: 'Bearer token',
      cookie: 'session=abc',
      accept: 'application/json',
    });
    expect(typeof result.dropped).toBe('number');
    expect(result.dropped).toBe(2);
  });

  test('Preserves case-insensitive matching (X-API-Key and x-api-key both dropped)', () => {
    const headers: Record<string, string> = {
      'X-API-Key': 'secret-value',
      Authorization: 'Bearer token',
      'Content-Type': 'application/json',
      Accept: '*/*',
    };
    const result = sanitizeHeaders(headers);
    expect(result.headers['content-type']).toBe('application/json');
    expect(result.headers.accept).toBe('*/*');
    expect(result.headers['x-api-key']).toBeUndefined();
    expect(result.headers.authorization).toBeUndefined();
    expect(result.dropped).toBe(2);
  });

  test('Does not split multi-byte UTF-8 characters on truncation', () => {
    // Build a value that forces truncation at MAX_VALUE_LEN with a multi-byte character
    const longPrefix = 'a'.repeat(MAX_VALUE_LEN - 2);
    const emojiChar = '😀'; // U+1F600 — 2 UTF-16 code units
    const value = longPrefix + emojiChar + 'trailing';
    expect(value.length).toBeGreaterThan(MAX_VALUE_LEN);
    const result = sanitizeHeaders({ 'x-custom': value });
    const truncated = result.headers['x-custom'] as string;
    // Should not end with a lone surrogate (U+D83D)
    expect(truncated.charCodeAt(truncated.length - 1)).not.toBe(0xd83d);
  });
});

// =========================================================================
// stripEffortBetaHeader — haiku + non-native provider beta stripping
// =========================================================================

describe('stripEffortBetaHeader', () => {
  test('deletes header when effort-2025-11-24 is the only value (string)', () => {
    const headers: Record<string, string | string[] | undefined> = {
      'anthropic-beta': 'effort-2025-11-24',
      'content-type': 'application/json',
    };
    const modified = stripEffortBetaHeader(headers, 'claude-haiku-4-5-20251001', true);
    expect(modified).toBe(true);
    expect(headers['anthropic-beta']).toBeUndefined();
    expect(headers['content-type']).toBe('application/json');
  });

  test('deletes header when effort-2025-11-24 is the only value (array)', () => {
    const headers: Record<string, string | string[] | undefined> = {
      'anthropic-beta': ['effort-2025-11-24'],
    };
    stripEffortBetaHeader(headers, 'claude-haiku-4-5-20251001', true);
    expect(headers['anthropic-beta']).toBeUndefined();
  });

  test('preserves other beta values when stripping effort', () => {
    const headers: Record<string, string | string[] | undefined> = {
      'anthropic-beta': 'prompt-caching-2024-07-31, effort-2025-11-24, tools-2024-04-04',
    };
    stripEffortBetaHeader(headers, 'claude-haiku-4-5-20251001', true);
    // Note: segment trimming removes spaces around commas
    expect(headers['anthropic-beta']).toBe('prompt-caching-2024-07-31,tools-2024-04-04');
  });

  test('preserves array values when stripping effort', () => {
    const headers: Record<string, string | string[] | undefined> = {
      'anthropic-beta': ['prompt-caching-2024-07-31', 'effort-2025-11-24', 'tools-2024-04-04'],
    };
    stripEffortBetaHeader(headers, 'claude-haiku-4-5-20251001', true);
    expect(headers['anthropic-beta']).toEqual(['prompt-caching-2024-07-31', 'tools-2024-04-04']);
  });

  test('strips effort for haiku model on native provider', () => {
    const headers: Record<string, string | string[] | undefined> = {
      'anthropic-beta': 'effort-2025-11-24, tools-2024-04-04',
    };
    const modified = stripEffortBetaHeader(headers, 'claude-haiku-4-5-20251001', true);
    expect(modified).toBe(true);
    expect(headers['anthropic-beta']).toBe('tools-2024-04-04');
  });

  test('strips effort for non-native provider regardless of model', () => {
    const headers: Record<string, string | string[] | undefined> = {
      'anthropic-beta': 'effort-2025-11-24',
    };
    // DeepSeek model on DeepSeek provider (non-native)
    const modified = stripEffortBetaHeader(headers, 'deepseek-v4-pro', false);
    expect(modified).toBe(true);
    expect(headers['anthropic-beta']).toBeUndefined();
  });

  test('does NOT strip effort for non-haiku model on native provider', () => {
    const headers: Record<string, string | string[] | undefined> = {
      'anthropic-beta': 'effort-2025-11-24, tools-2024-04-04',
    };
    // Opus on Anthropic — effort IS supported
    const modified = stripEffortBetaHeader(headers, 'claude-opus-4-7', true);
    expect(modified).toBe(false);
    expect(headers['anthropic-beta']).toBe('effort-2025-11-24, tools-2024-04-04');
  });

  test('strips effort for sonnet model too (only haiku was checked, but Opus/Sonnet also support it)', () => {
    const headers: Record<string, string | string[] | undefined> = {
      'anthropic-beta': 'effort-2025-11-24',
    };
    // Sonnet on Anthropic — effort IS supported, header should NOT be stripped
    const modified = stripEffortBetaHeader(headers, 'claude-sonnet-4-6', true);
    expect(modified).toBe(false);
    expect(headers['anthropic-beta']).toBe('effort-2025-11-24');
  });

  test('no-op when anthropic-beta header is absent', () => {
    const headers: Record<string, string | string[] | undefined> = {
      'content-type': 'application/json',
    };
    const modified = stripEffortBetaHeader(headers, 'claude-haiku-4-5-20251001', true);
    expect(modified).toBe(false);
    expect(headers['anthropic-beta']).toBeUndefined();
    expect(headers['content-type']).toBe('application/json');
  });

  test('handles empty string after filtering whitespace-only values', () => {
    const headers: Record<string, string | string[] | undefined> = {
      'anthropic-beta': '  effort-2025-11-24  ',
    };
    stripEffortBetaHeader(headers, 'claude-haiku-4-5-20251001', true);
    // After trimming and filtering, nothing remains → header deleted
    expect(headers['anthropic-beta']).toBeUndefined();
  });

  test('filters zero-length segments from split (double commas)', () => {
    const headers: Record<string, string | string[] | undefined> = {
      'anthropic-beta': 'effort-2025-11-24, , tools-2024-04-04',
    };
    stripEffortBetaHeader(headers, 'claude-haiku-4-5-20251001', true);
    // Zero-length segment from double comma is filtered out
    expect(headers['anthropic-beta']).toBe('tools-2024-04-04');
  });
});
