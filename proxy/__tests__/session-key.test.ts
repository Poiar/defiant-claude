'use strict';

import { sessionKey } from '../session-key';

// ---------------------------------------------------------------------------
// Within a single process (single import), STARTUP_SALT is constant, so
// sessionKey is deterministic for identical inputs.
// ---------------------------------------------------------------------------

// --- Helpers ---

function makeMessages(firstUserContent: unknown, system?: unknown): Record<string, unknown> {
  const body: Record<string, unknown> = { messages: [{ role: 'user', content: firstUserContent }] };
  if (system !== undefined) body.system = system;
  return body;
}

// ---------------------------------------------------------------------------
// Null / undefined / missing input
// ---------------------------------------------------------------------------

describe('sessionKey', () => {
  describe('null / undefined / missing input', () => {
    test('returns null for null input', () => {
      expect(sessionKey(null)).toBeNull();
    });

    test('returns null for undefined input', () => {
      expect(sessionKey(undefined)).toBeNull();
    });

    test('returns null for empty object (no messages key)', () => {
      expect(sessionKey({})).toBeNull();
    });

    test('returns null when messages array is empty', () => {
      expect(sessionKey({ messages: [] })).toBeNull();
    });

    test('returns null when no message has role user', () => {
      const body = {
        messages: [
          { role: 'assistant', content: 'hello' },
          { role: 'tool', content: 'result' },
        ],
      };
      expect(sessionKey(body)).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Content extraction — string messages
  // -----------------------------------------------------------------------

  describe('content extraction — string messages', () => {
    test('returns a 32-character hex string for a valid request', () => {
      const key = sessionKey(makeMessages('hello world'));
      expect(key).toMatch(/^[0-9a-f]{32}$/);
    });

    test('finds user message by role even when not first', () => {
      const body = {
        messages: [
          { role: 'assistant', content: 'I am the assistant' },
          { role: 'user', content: 'actual user message' },
        ],
      };
      const key = sessionKey(body);
      expect(key).toMatch(/^[0-9a-f]{32}$/);
    });

    test('finds the first user message when multiple exist', () => {
      const body = {
        messages: [
          { role: 'user', content: 'first user message' },
          { role: 'user', content: 'second user message' },
        ],
      };
      const key = sessionKey(body);
      expect(key).toMatch(/^[0-9a-f]{32}$/);
    });
  });

  // -----------------------------------------------------------------------
  // Content extraction — content array (multimodal / thinking blocks)
  // -----------------------------------------------------------------------

  describe('content extraction — content arrays', () => {
    test('extracts and joins text blocks from content array', () => {
      const body = {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Hello ' },
              { type: 'text', text: 'world!' },
            ],
          },
        ],
      };
      const key = sessionKey(body);
      expect(key).toMatch(/^[0-9a-f]{32}$/);
      // Same compound string should produce the same key
      const expected = sessionKey({ messages: [{ role: 'user', content: 'Hello world!' }] });
      expect(key).toBe(expected);
    });

    test('handles blocks missing the text field gracefully', () => {
      const body = {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Hello ' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
              { type: 'text', text: 'world!' },
            ],
          },
        ],
      };
      const key = sessionKey(body);
      expect(key).toMatch(/^[0-9a-f]{32}$/);
    });

    test('handles empty content array', () => {
      const body = {
        messages: [
          {
            role: 'user',
            content: [],
          },
        ],
      };
      const key = sessionKey(body);
      expect(key).toMatch(/^[0-9a-f]{32}$/);
    });

    test('handles content array where all blocks lack text', () => {
      const body = {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { data: 'abc' } },
              { type: 'image', source: { data: 'def' } },
            ],
          },
        ],
      };
      const key = sessionKey(body);
      expect(key).toMatch(/^[0-9a-f]{32}$/);
    });

    test('handles boolean content (non-string, non-array)', () => {
      // TypeScript would normally prevent this, but the guard handles it
      const body = {
        messages: [{ role: 'user', content: true }],
      };
      const key = sessionKey(body);
      expect(key).toMatch(/^[0-9a-f]{32}$/);
    });

    test('handles numeric content (non-string, non-array)', () => {
      const body = {
        messages: [{ role: 'user', content: 42 }],
      };
      const key = sessionKey(body);
      expect(key).toMatch(/^[0-9a-f]{32}$/);
    });
  });

  // -----------------------------------------------------------------------
  // System hint extraction
  // -----------------------------------------------------------------------

  describe('system hint extraction', () => {
    test('string system prompt is included in hash (produces different key vs no system)', () => {
      const withSystem = sessionKey(makeMessages('hello', 'You are a helpful assistant.'));
      const withoutSystem = sessionKey(makeMessages('hello'));
      expect(withSystem).not.toBe(withoutSystem);
      expect(withSystem).toMatch(/^[0-9a-f]{32}$/);
    });

    test('array system prompt concatenates text blocks', () => {
      const body = makeMessages('hello', [
        { type: 'text', text: 'You are a ' },
        { type: 'text', text: 'helpful assistant.' },
      ]);
      const key = sessionKey(body);
      expect(key).toMatch(/^[0-9a-f]{32}$/);

      // Should match a single string with the concatenated result
      const equivalent = sessionKey(makeMessages('hello', 'You are a helpful assistant.'));
      expect(key).toBe(equivalent);
    });

    test('system prompt longer than 500 chars is truncated', () => {
      const longSystem = 'A'.repeat(1000);
      const shortSystem = 'A'.repeat(500);
      const keyLong = sessionKey(makeMessages('hello', longSystem));
      const keyShort = sessionKey(makeMessages('hello', shortSystem));
      expect(keyLong).toBe(keyShort);
    });

    test('no system prompt produces empty system hint', () => {
      const key = sessionKey(makeMessages('hello'));
      expect(key).toMatch(/^[0-9a-f]{32}$/);
    });

    test('system array with mixed blocks (some without text) is handled gracefully', () => {
      const body = makeMessages('hello', [
        { type: 'text', text: 'System prompt ' },
        { type: 'citation', source: { title: 'doc' } },
        { type: 'text', text: 'continued.' },
      ]);
      const key = sessionKey(body);
      expect(key).toMatch(/^[0-9a-f]{32}$/);

      const equivalent = sessionKey(makeMessages('hello', 'System prompt continued.'));
      expect(key).toBe(equivalent);
    });

    test('system hint with only non-text blocks produces empty hint', () => {
      const body = makeMessages('hello', [
        { type: 'citation', source: { title: 'doc1' } },
        { type: 'citation', source: { title: 'doc2' } },
      ]);
      const key = sessionKey(body);
      expect(key).toMatch(/^[0-9a-f]{32}$/);

      const noSystem = sessionKey(makeMessages('hello'));
      expect(key).toBe(noSystem);
    });
  });

  // -----------------------------------------------------------------------
  // Determinism and uniqueness
  // -----------------------------------------------------------------------

  describe('determinism and uniqueness', () => {
    test('same inputs produce same key within the same process', () => {
      const body = makeMessages('the same message', 'same system');
      const a = sessionKey(body);
      const b = sessionKey(body);
      expect(a).toBe(b);
    });

    test('different first user message content produces different key', () => {
      const keyA = sessionKey(makeMessages('message A'));
      const keyB = sessionKey(makeMessages('message B'));
      expect(keyA).not.toBe(keyB);
    });

    test('different system prompt produces different key', () => {
      const keyA = sessionKey(makeMessages('hello', 'system A'));
      const keyB = sessionKey(makeMessages('hello', 'system B'));
      expect(keyA).not.toBe(keyB);
    });

    test('same content and system regardless of message ordering (find() based)', () => {
      const body1 = {
        messages: [
          { role: 'assistant', content: 'assistant msg' },
          { role: 'user', content: 'user message' },
        ],
        system: 'a system',
      };
      const body2 = {
        messages: [
          { role: 'tool', content: 'tool result' },
          { role: 'assistant', content: 'assistant msg' },
          { role: 'user', content: 'user message' },
        ],
        system: 'a system',
      };
      expect(sessionKey(body1)).toBe(sessionKey(body2));
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  describe('edge cases', () => {
    test('very long user message content (100KB+) still produces a 32-char key', () => {
      const longContent = 'x'.repeat(100_000);
      const key = sessionKey(makeMessages(longContent));
      expect(key).toMatch(/^[0-9a-f]{32}$/);
    });

    test('unicode and emoji in user message are handled', () => {
      const key = sessionKey(makeMessages('Hello, 世界! é ♥ \u{1F600} \u{1F44D} é ∂'));
      expect(key).toMatch(/^[0-9a-f]{32}$/);
    });

    test('special characters in content are handled', () => {
      const special = '\x00\x01\x02\x1F\x7F\x80\xFF\n\r\t\\\'"`@#$%^&*()_+-=[]{}|;:,.<>?/~';
      const key = sessionKey(makeMessages(special));
      expect(key).toMatch(/^[0-9a-f]{32}$/);
    });

    test('whitespace-only content produces a valid key', () => {
      const key = sessionKey(makeMessages('   \n\t  '));
      expect(key).toMatch(/^[0-9a-f]{32}$/);
    });

    test('empty string content produces a valid key', () => {
      const key = sessionKey(makeMessages(''));
      expect(key).toMatch(/^[0-9a-f]{32}$/);
    });

    test('content with null byte separator does not collide with empty content', () => {
      // The internal separator is \x00 between salt, content, systemHint.
      // Two different pieces of content that could produce the same
      // concatenation should not collide because the null byte delimits.
      const keyA = sessionKey(makeMessages('ab', 'c'));
      const keyB = sessionKey(makeMessages('a', 'bc'));
      expect(keyA).not.toBe(keyB);
    });

    test('very long system prompt (100KB+) is truncated to 500 chars', () => {
      const longSystem = 'Y'.repeat(100_000);
      const truncated = 'Y'.repeat(500);
      const keyLong = sessionKey(makeMessages('hello', longSystem));
      const keyTrunc = sessionKey(makeMessages('hello', truncated));
      expect(keyLong).toBe(keyTrunc);
    });

    test('content array with null/undefined text values', () => {
      const body = {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: null },
              { type: 'text', text: undefined },
              { type: 'text', text: 'actual' },
            ],
          },
        ],
      };
      const key = sessionKey(body);
      expect(key).toMatch(/^[0-9a-f]{32}$/);

      // null and undefined map to empty strings, so result is '' + '' + 'actual' = 'actual'
      const expected = sessionKey({ messages: [{ role: 'user', content: 'actual' }] });
      expect(key).toBe(expected);
    });

    test('messages with additional unknown fields are ignored', () => {
      const body = {
        messages: [{ role: 'user', content: 'hello', extraField: 'ignored' }],
        extraTopLevel: 'also-ignored',
      };
      const key = sessionKey(body);
      expect(key).toMatch(/^[0-9a-f]{32}$/);

      const normal = sessionKey({ messages: [{ role: 'user', content: 'hello' }] });
      expect(key).toBe(normal);
    });

    test('index signature Record<string, unknown> values work with varied types', () => {
      const body: Record<string, unknown> = {
        messages: [{ role: 'user', content: 'hello' }],
        system: 12345, // numeric system — not string or array
      };
      const key = sessionKey(body);
      expect(key).toMatch(/^[0-9a-f]{32}$/);

      // Numeric system falls through to empty string
      const noSystem = sessionKey({ messages: [{ role: 'user', content: 'hello' }] });
      expect(key).toBe(noSystem);
    });
  });
});
