'use strict';

import {
  PROVIDER_CONSTRAINTS,
  getConstraints,
  isAnthropicProvider,
  serializeSSEEvent,
  parseSSEEventData,
  parseSSEEventRaw,
  mapFinishReason,
  translateToolChoice,
} from '../protocol-types';
import type {
  AnthropicSSEEvent,
  AnthropicContentBlock,
  ProviderConstraints,
} from '../protocol-types';

// =========================================================================
// ProviderConstraints — all 16 providers validate
// =========================================================================

describe('ProviderConstraints', () => {
  const providers = Object.entries(PROVIDER_CONSTRAINTS);

  test('all 16 providers are configured', () => {
    expect(Object.keys(PROVIDER_CONSTRAINTS).length).toBe(16);
  });

  test.each(providers)('%s has required fields', (_key, c: ProviderConstraints) => {
    expect(typeof c.key).toBe('string');
    expect(c.key.length).toBeGreaterThan(0);
    expect(['anthropic', 'openai']).toContain(c.format);
    expect(typeof c.nativeServerTools).toBe('boolean');
    expect(typeof c.nativeServerToolUse).toBe('boolean');
    expect(typeof c.requiresModelRewrite).toBe('boolean');
    expect(typeof c.forbidsToolChoiceWithThinking).toBe('boolean');
    expect(typeof c.requiresThinkingEcho).toBe('boolean');
    expect(['anthropic', 'openai', null]).toContain(c.thinkingFormat);
    expect(Array.isArray(c.stripFields)).toBe(true);
    c.stripFields.forEach((f: string) => expect(typeof f).toBe('string'));
  });

  test('an (Anthropic) has correct values', () => {
    const an = PROVIDER_CONSTRAINTS.an;
    expect(an.format).toBe('anthropic');
    expect(an.nativeServerTools).toBe(true);
    expect(an.nativeServerToolUse).toBe(true);
    expect(an.requiresModelRewrite).toBe(false);
    expect(an.forbidsToolChoiceWithThinking).toBe(false);
    expect(an.requiresThinkingEcho).toBe(false);
  });

  test('ds (DeepSeek) has correct values', () => {
    const ds = PROVIDER_CONSTRAINTS.ds;
    expect(ds.format).toBe('anthropic');
    expect(ds.nativeServerTools).toBe(false);
    expect(ds.nativeServerToolUse).toBe(false);
    expect(ds.requiresModelRewrite).toBe(true);
    expect(ds.forbidsToolChoiceWithThinking).toBe(true);
    expect(ds.requiresThinkingEcho).toBe(true);
    expect(ds.thinkingFormat).toBe('anthropic');
  });

  test('or (OpenRouter) has correct values', () => {
    const or = PROVIDER_CONSTRAINTS.or;
    expect(or.format).toBe('openai');
    expect(or.nativeServerTools).toBe(false);
    expect(or.stripFields).toContain('top_k');
    expect(or.stripFields).toContain('metadata');
  });

  test('all non-Anthropic providers have nativeServerTools: false', () => {
    for (const [key, c] of providers) {
      if (key !== 'an') {
        expect(c.nativeServerTools).toBe(false);
      }
    }
  });

  test('all non-Anthropic providers require model rewrite', () => {
    for (const [key, c] of providers) {
      if (key !== 'an') {
        expect(c.requiresModelRewrite).toBe(true);
      }
    }
  });

  test('all OpenAI-format providers strip Anthropic fields', () => {
    for (const [, c] of providers) {
      if (c.format === 'openai') {
        expect(c.stripFields).toContain('top_k');
        expect(c.stripFields).toContain('metadata');
      }
    }
  });
});

// =========================================================================
// getConstraints — resolution and defaults
// =========================================================================

describe('getConstraints', () => {
  test('resolves known provider', () => {
    const ds = getConstraints('ds');
    expect(ds.key).toBe('ds');
    expect(ds.forbidsToolChoiceWithThinking).toBe(true);
  });

  test('resolves Anthropic provider', () => {
    const an = getConstraints('an');
    expect(an.nativeServerTools).toBe(true);
  });

  test('returns conservative defaults for unknown provider', () => {
    const unknown = getConstraints('some-new-provider');
    expect(unknown.format).toBe('openai');
    expect(unknown.nativeServerTools).toBe(false);
    expect(unknown.nativeServerToolUse).toBe(false);
    expect(unknown.requiresModelRewrite).toBe(true);
    expect(unknown.forbidsToolChoiceWithThinking).toBe(false);
    expect(unknown.requiresThinkingEcho).toBe(false);
    expect(unknown.thinkingFormat).toBeNull();
    expect(unknown.stripFields).toContain('top_k');
    expect(unknown.stripFields).toContain('metadata');
  });
});

// =========================================================================
// isAnthropicProvider
// =========================================================================

describe('isAnthropicProvider', () => {
  test('returns true for Anthropic constraints', () => {
    expect(isAnthropicProvider(PROVIDER_CONSTRAINTS.an)).toBe(true);
  });

  test('returns false for non-Anthropic providers', () => {
    expect(isAnthropicProvider(PROVIDER_CONSTRAINTS.ds)).toBe(false);
    expect(isAnthropicProvider(PROVIDER_CONSTRAINTS.or)).toBe(false);
    expect(isAnthropicProvider(PROVIDER_CONSTRAINTS.oc)).toBe(false);
  });
});

// =========================================================================
// SSE event round-trip — serialize then parse every event type
// =========================================================================

describe('SSE event round-trip', () => {
  test('message_start', () => {
    const event: AnthropicSSEEvent = {
      type: 'message_start',
      message: {
        id: 'msg_123',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-sonnet-4-6',
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    };
    const wire = serializeSSEEvent(event);
    expect(wire).toContain('event: message_start');
    const parsed = parseSSEEvent('message_start', wire);
    expect(parsed).toEqual(event);
  });

  test('content_block_start (text)', () => {
    const block: AnthropicContentBlock = { type: 'text', text: 'Hello' };
    const event: AnthropicSSEEvent = {
      type: 'content_block_start',
      index: 0,
      content_block: block,
    };
    const wire = serializeSSEEvent(event);
    const parsed = parseSSEEvent('content_block_start', wire);
    expect(parsed).toEqual(event);
  });

  test('content_block_start (thinking)', () => {
    const block: AnthropicContentBlock = {
      type: 'thinking',
      thinking: 'Let me think...',
      signature: 'sig123',
    };
    const event: AnthropicSSEEvent = {
      type: 'content_block_start',
      index: 0,
      content_block: block,
    };
    const wire = serializeSSEEvent(event);
    const parsed = parseSSEEvent('content_block_start', wire);
    expect(parsed).toEqual(event);
  });

  test('content_block_start (tool_use)', () => {
    const block: AnthropicContentBlock = {
      type: 'tool_use',
      id: 'toolu_1',
      name: 'web_search',
      input: { query: 'test' },
    };
    const event: AnthropicSSEEvent = {
      type: 'content_block_start',
      index: 1,
      content_block: block,
    };
    const wire = serializeSSEEvent(event);
    const parsed = parseSSEEvent('content_block_start', wire);
    expect(parsed).toEqual(event);
  });

  test('content_block_start (tool_result)', () => {
    const block: AnthropicContentBlock = {
      type: 'tool_result',
      tool_use_id: 'toolu_1',
      content: 'result text',
    };
    const event: AnthropicSSEEvent = {
      type: 'content_block_start',
      index: 2,
      content_block: block,
    };
    const wire = serializeSSEEvent(event);
    const parsed = parseSSEEvent('content_block_start', wire);
    expect(parsed).toEqual(event);
  });

  test('content_block_delta (text_delta)', () => {
    const event: AnthropicSSEEvent = {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'world' },
    };
    const wire = serializeSSEEvent(event);
    const parsed = parseSSEEvent('content_block_delta', wire);
    expect(parsed).toEqual(event);
  });

  test('content_block_delta (thinking_delta)', () => {
    const event: AnthropicSSEEvent = {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'Hmm...' },
    };
    const wire = serializeSSEEvent(event);
    const parsed = parseSSEEvent('content_block_delta', wire);
    expect(parsed).toEqual(event);
  });

  test('content_block_delta (signature_delta)', () => {
    const event: AnthropicSSEEvent = {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'signature_delta', signature: 'abc' },
    };
    const wire = serializeSSEEvent(event);
    const parsed = parseSSEEvent('content_block_delta', wire);
    expect(parsed).toEqual(event);
  });

  test('content_block_delta (input_json_delta)', () => {
    const event: AnthropicSSEEvent = {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '{"query":' },
    };
    const wire = serializeSSEEvent(event);
    const parsed = parseSSEEvent('content_block_delta', wire);
    expect(parsed).toEqual(event);
  });

  test('content_block_stop', () => {
    const event: AnthropicSSEEvent = {
      type: 'content_block_stop',
      index: 0,
    };
    const wire = serializeSSEEvent(event);
    const parsed = parseSSEEvent('content_block_stop', wire);
    expect(parsed).toEqual(event);
  });

  test('message_delta with usage', () => {
    const event: AnthropicSSEEvent = {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: {
        output_tokens: 42,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 500,
        server_tool_use: {
          web_search_requests: 2,
          web_fetch_requests: 1,
        },
      },
    };
    const wire = serializeSSEEvent(event);
    const parsed = parseSSEEvent('message_delta', wire) as any;
    expect(parsed).toBeDefined();
    expect(parsed!.type).toBe('message_delta');
    if (parsed!.type === 'message_delta') {
      expect(parsed.usage.output_tokens).toBe(42);
      expect(parsed.usage.server_tool_use?.web_search_requests).toBe(2);
    }
  });

  test('message_stop', () => {
    const event: AnthropicSSEEvent = { type: 'message_stop' };
    const wire = serializeSSEEvent(event);
    const parsed = parseSSEEvent('message_stop', wire);
    expect(parsed).toEqual(event);
  });

  test('error', () => {
    const event: AnthropicSSEEvent = {
      type: 'error',
      error: { type: 'api_error', message: 'Something went wrong' },
    };
    const wire = serializeSSEEvent(event);
    const parsed = parseSSEEvent('error', wire);
    expect(parsed).toEqual(event);
  });

  test('ping', () => {
    const event: AnthropicSSEEvent = { type: 'ping' };
    const wire = serializeSSEEvent(event);
    const parsed = parseSSEEvent('ping', wire);
    expect(parsed).toEqual(event);
  });

  // Edge case: multiple content blocks in sequence
  test('tool_use with empty input', () => {
    const block: AnthropicContentBlock = {
      type: 'tool_use',
      id: 'toolu_empty',
      name: 'read_file',
      input: {},
    };
    const event: AnthropicSSEEvent = {
      type: 'content_block_start',
      index: 0,
      content_block: block,
    };
    const wire = serializeSSEEvent(event);
    const parsed = parseSSEEvent('content_block_start', wire);
    expect(parsed).toEqual(event);
  });
});

// =========================================================================
// parseSSEEventRaw — extracts event type and data from raw SSE
// =========================================================================

describe('parseSSEEventRaw', () => {
  test('extracts event type and data', () => {
    const raw = 'event: message_start\ndata: {"type":"message_start","message":{"id":"x"}}';
    const result = parseSSEEventRaw(raw);
    expect(result).toBeDefined();
    expect(result!.eventType).toBe('message_start');
    expect(result!.dataStr).toContain('"type":"message_start"');
  });

  test('handles multiline event', () => {
    const raw = 'event: content_block_start\ndata: {"type":"content_block_start"}\n\n';
    const result = parseSSEEventRaw(raw);
    expect(result).toBeDefined();
    expect(result!.eventType).toBe('content_block_start');
  });

  test('returns null for missing event line', () => {
    const result = parseSSEEventRaw('data: {"foo":"bar"}');
    expect(result).toBeNull();
  });

  test('returns null for missing data line', () => {
    const result = parseSSEEventRaw('event: message_start');
    expect(result).toBeNull();
  });

  test('returns null for empty string', () => {
    const result = parseSSEEventRaw('');
    expect(result).toBeNull();
  });
});

// =========================================================================
// parseSSEEventData — malformed input handling
// =========================================================================

describe('parseSSEEventData edge cases', () => {
  test('returns null for unrecognized event type', () => {
    const result = parseSSEEventData('unknown_event', '{}');
    expect(result).toBeNull();
  });

  test('returns null for malformed JSON', () => {
    const result = parseSSEEventData('message_start', 'not-json');
    expect(result).toBeNull();
  });

  test('handles content_block_start with missing index', () => {
    const result = parseSSEEventData('content_block_start', '{}');
    expect(result).toBeDefined();
    if (result && result.type === 'content_block_start') {
      expect(result.index).toBe(0); // defaults to 0
    }
  });
});

// =========================================================================
// mapFinishReason — all mappings
// =========================================================================

describe('mapFinishReason', () => {
  test("'stop' → 'end_turn'", () => expect(mapFinishReason('stop')).toBe('end_turn'));
  test("'tool_calls' → 'tool_use'", () => expect(mapFinishReason('tool_calls')).toBe('tool_use'));
  test("'length' → 'max_tokens'", () => expect(mapFinishReason('length')).toBe('max_tokens'));
  test("'content_filter' → 'content_filter'", () =>
    expect(mapFinishReason('content_filter')).toBe('content_filter'));
  test('null → end_turn', () => expect(mapFinishReason(null)).toBe('end_turn'));
  test('undefined → end_turn', () => expect(mapFinishReason(undefined)).toBe('end_turn'));
  test('unknown → end_turn', () => expect(mapFinishReason('some_strange_reason')).toBe('end_turn'));
  test('empty string → end_turn', () => expect(mapFinishReason('')).toBe('end_turn'));
});

// =========================================================================
// translateToolChoice — all forms
// =========================================================================

describe('translateToolChoice', () => {
  test("'auto' → 'auto'", () => expect(translateToolChoice('auto')).toBe('auto'));
  test("'any' → 'required'", () => expect(translateToolChoice('any')).toBe('required'));
  test("'none' → 'none'", () => expect(translateToolChoice('none')).toBe('none'));

  test("{ type: 'auto' } → 'auto'", () => {
    expect(translateToolChoice({ type: 'auto' })).toBe('auto');
  });

  test("{ type: 'any' } → 'required'", () => {
    expect(translateToolChoice({ type: 'any' })).toBe('required');
  });

  test("{ type: 'none' } → 'none'", () => {
    expect(translateToolChoice({ type: 'none' })).toBe('none');
  });

  test("{ type: 'tool', name: 'get_weather' } → function form", () => {
    const result = translateToolChoice({ type: 'tool', name: 'get_weather' });
    expect(result).toEqual({ type: 'function', function: { name: 'get_weather' } });
  });

  test("{ type: 'tool', name: undefined } → defaults to 'auto'", () => {
    // {type:'tool'} without name falls through to default
    expect(translateToolChoice({ type: 'tool' })).toBe('auto');
  });

  test("unrecognized string → 'auto'", () => {
    expect(translateToolChoice('something_else')).toBe('auto');
  });

  test("{ type: 'unknown' } → 'auto'", () => {
    expect(translateToolChoice({ type: 'unknown' })).toBe('auto');
  });
});

// =========================================================================
// SSE_EVENT_TYPES — const array correctness
// =========================================================================

import { SSE_EVENT_TYPES } from '../protocol-types';

describe('SSE_EVENT_TYPES', () => {
  test('contains all 8 event types', () => {
    expect(SSE_EVENT_TYPES.length).toBe(8);
    expect(SSE_EVENT_TYPES).toContain('message_start');
    expect(SSE_EVENT_TYPES).toContain('content_block_start');
    expect(SSE_EVENT_TYPES).toContain('content_block_delta');
    expect(SSE_EVENT_TYPES).toContain('content_block_stop');
    expect(SSE_EVENT_TYPES).toContain('message_delta');
    expect(SSE_EVENT_TYPES).toContain('message_stop');
    expect(SSE_EVENT_TYPES).toContain('error');
    expect(SSE_EVENT_TYPES).toContain('ping');
  });
});

// =========================================================================
// Helper — parse SSE wire format back to event
// =========================================================================

function parseSSEEvent(expectedType: string, wire: string): AnthropicSSEEvent | null {
  const lines = wire.split('\n');
  let dataStr = '';
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      dataStr = line.slice(6);
      break;
    }
  }
  return parseSSEEventData(expectedType, dataStr);
}
