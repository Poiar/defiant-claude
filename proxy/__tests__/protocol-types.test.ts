'use strict';

import {
  PROVIDER_CONSTRAINTS,
  getConstraints,
  isAnthropicProvider,
  isPassthroughProvider,
  stripProviderFields,
  stripSystemBillingHeader,
  stripCacheControl,
  stripDuplicateMessages,
  serializeSSEEvent,
  parseSSEEventData,
  parseSSEEventRaw,
  mapFinishReason,
  translateToolChoice,
  validateResponseConformance,
  validateStreamEventConformance,
} from '../protocol-types';
import type {
  AnthropicSSEEvent,
  AnthropicContentBlock,
  ProviderConstraints,
} from '../protocol-types';

// =========================================================================
// ProviderConstraints — all 20 providers validate
// =========================================================================

describe('ProviderConstraints', () => {
  const providers = Object.entries(PROVIDER_CONSTRAINTS);

  test('all 20 providers are configured', () => {
    expect(Object.keys(PROVIDER_CONSTRAINTS).length).toBe(20);
  });

  test.each(providers)('%s has required fields', (_key, c: ProviderConstraints) => {
    expect(typeof c.key).toBe('string');
    expect(c.key.length).toBeGreaterThan(0);
    expect(['anthropic', 'openai', 'gemini']).toContain(c.format);
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
    expect(ds.stripFields).toContain('metadata');
  });

  test('oc (OpenCode) has correct values', () => {
    const oc = PROVIDER_CONSTRAINTS.oc;
    expect(oc.format).toBe('anthropic');
    expect(oc.stripFields).toContain('metadata');
  });

  test('or (OpenRouter) has correct values', () => {
    const or = PROVIDER_CONSTRAINTS.or;
    expect(or.format).toBe('openai');
    expect(or.nativeServerTools).toBe(false);
    expect(or.stripFields).toContain('top_k');
    expect(or.stripFields).toContain('metadata');
  });

  test('oa (OpenAI direct) has correct values', () => {
    const oa = PROVIDER_CONSTRAINTS.oa;
    expect(oa.format).toBe('openai');
    expect(oa.nativeServerTools).toBe(false);
    expect(oa.nativeServerToolUse).toBe(false);
    expect(oa.requiresModelRewrite).toBe(true);
    expect(oa.forbidsToolChoiceWithThinking).toBe(false);
    expect(oa.requiresThinkingEcho).toBe(false);
    expect(oa.thinkingFormat).toBeNull();
    expect(oa.stripFields).toContain('top_k');
    expect(oa.stripFields).toContain('metadata');
  });

  test('xa (xAI / Grok) has correct values', () => {
    const xa = PROVIDER_CONSTRAINTS.xa;
    expect(xa.format).toBe('openai');
    expect(xa.nativeServerTools).toBe(false);
    expect(xa.nativeServerToolUse).toBe(false);
    expect(xa.requiresModelRewrite).toBe(true);
    expect(xa.forbidsToolChoiceWithThinking).toBe(false);
    expect(xa.requiresThinkingEcho).toBe(false);
    expect(xa.thinkingFormat).toBeNull();
    expect(xa.stripFields).toContain('top_k');
    expect(xa.stripFields).toContain('metadata');
  });

  test('lo (Ollama local) has correct values', () => {
    const lo = PROVIDER_CONSTRAINTS.lo;
    expect(lo.format).toBe('openai');
    expect(lo.nativeServerTools).toBe(false);
    expect(lo.nativeServerToolUse).toBe(false);
    expect(lo.requiresModelRewrite).toBe(true);
    expect(lo.forbidsToolChoiceWithThinking).toBe(false);
    expect(lo.requiresThinkingEcho).toBe(false);
    expect(lo.thinkingFormat).toBeNull();
    expect(lo.noAutoFallback).toBe(true);
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
// isPassthroughProvider
// =========================================================================

describe('isPassthroughProvider', () => {
  test('returns true only for Anthropic direct (an)', () => {
    expect(isPassthroughProvider(PROVIDER_CONSTRAINTS.an)).toBe(true);
  });

  test('returns false for DeepSeek (nativeServerTools=false)', () => {
    expect(isPassthroughProvider(PROVIDER_CONSTRAINTS.ds)).toBe(false);
  });

  test('returns false for OpenRouter', () => {
    expect(isPassthroughProvider(PROVIDER_CONSTRAINTS.or)).toBe(false);
  });

  test('returns false for Fireworks (format=anthropic but nativeServerToolUse=false)', () => {
    // Fireworks speaks Anthropic format but doesn't return server_tool_use natively —
    // the proxy must inject it. isPassthroughProvider requires BOTH nativeServerTools
    // AND nativeServerToolUse.
    expect(isPassthroughProvider(PROVIDER_CONSTRAINTS.fw)).toBe(false);
  });

  test('returns false for every provider except an', () => {
    for (const [key, c] of Object.entries(PROVIDER_CONSTRAINTS)) {
      if (key === 'an') continue;
      expect(isPassthroughProvider(c)).toBe(false);
    }
  });

  test('returns false for unknown provider keys (default constraints)', () => {
    const unknown = getConstraints('some-new-provider');
    expect(isPassthroughProvider(unknown)).toBe(false);
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

  test('message_delta with service_tier', () => {
    const event: AnthropicSSEEvent = {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: {
        output_tokens: 42,
        service_tier: 'standard',
      },
    };
    const wire = serializeSSEEvent(event);
    const parsed = parseSSEEvent('message_delta', wire) as any;
    expect(parsed).toBeDefined();
    expect(parsed!.type).toBe('message_delta');
    if (parsed!.type === 'message_delta') {
      expect(parsed.usage.service_tier).toBe('standard');
      expect(parsed.usage.output_tokens).toBe(42);
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
// New content block types (added 2026-06-16)
// =========================================================================

describe('New Anthropic content block types', () => {
  test('search_result block serializes and parses', () => {
    const block: AnthropicContentBlock = {
      type: 'search_result',
      source: 'https://example.com',
      title: 'Example Search',
      content: [{ type: 'text', text: 'Result text' }],
    };
    const event: AnthropicSSEEvent = {
      type: 'content_block_start',
      index: 3,
      content_block: block,
    };
    const wire = serializeSSEEvent(event);
    const parsed = parseSSEEvent('content_block_start', wire);
    expect(parsed).toEqual(event);
  });

  test('compaction block serializes and parses', () => {
    const block: AnthropicContentBlock = {
      type: 'compaction',
      content: 'Summary of previous conversation...',
      encrypted_content: 'opaque-blob',
    };
    const event: AnthropicSSEEvent = {
      type: 'content_block_start',
      index: 4,
      content_block: block,
    };
    const wire = serializeSSEEvent(event);
    const parsed = parseSSEEvent('content_block_start', wire);
    expect(parsed).toEqual(event);
  });

  test('fallback block serializes and parses', () => {
    const block: AnthropicContentBlock = {
      type: 'fallback',
      from: { model: 'claude-haiku-4-5-20251001' },
      to: { model: 'claude-sonnet-4-6' },
    };
    const event: AnthropicSSEEvent = {
      type: 'content_block_start',
      index: 5,
      content_block: block,
    };
    const wire = serializeSSEEvent(event);
    const parsed = parseSSEEvent('content_block_start', wire);
    expect(parsed).toEqual(event);
  });

  test('mid_conv_system block serializes and parses', () => {
    const block: AnthropicContentBlock = {
      type: 'mid_conv_system',
      content: [{ type: 'text', text: 'Updated system instructions...' }],
    };
    const event: AnthropicSSEEvent = {
      type: 'content_block_start',
      index: 6,
      content_block: block,
    };
    const wire = serializeSSEEvent(event);
    const parsed = parseSSEEvent('content_block_start', wire);
    expect(parsed).toEqual(event);
  });

  test('web_search_tool_result block serializes and parses', () => {
    const block: AnthropicContentBlock = {
      type: 'web_search_tool_result',
      tool_use_id: 'toolu_ws_001',
      content: 'Search results content',
    };
    const event: AnthropicSSEEvent = {
      type: 'content_block_start',
      index: 7,
      content_block: block,
    };
    const wire = serializeSSEEvent(event);
    const parsed = parseSSEEvent('content_block_start', wire);
    expect(parsed).toEqual(event);
  });

  test('web_fetch_tool_result block serializes and parses', () => {
    const block: AnthropicContentBlock = {
      type: 'web_fetch_tool_result',
      tool_use_id: 'toolu_wf_001',
      content: 'Fetched page content',
    };
    const event: AnthropicSSEEvent = {
      type: 'content_block_start',
      index: 8,
      content_block: block,
    };
    const wire = serializeSSEEvent(event);
    const parsed = parseSSEEvent('content_block_start', wire);
    expect(parsed).toEqual(event);
  });

  test('text block with citations', () => {
    const block: AnthropicContentBlock = {
      type: 'text',
      text: 'The sky is blue.',
      citations: [
        {
          type: 'char_location',
          cited_text: 'sky is blue',
          document_index: 0,
          document_title: 'Weather Report',
          start_char_index: 4,
          end_char_index: 15,
        },
      ],
    };
    const event: AnthropicSSEEvent = {
      type: 'content_block_start',
      index: 9,
      content_block: block,
    };
    const wire = serializeSSEEvent(event);
    const parsed = parseSSEEvent('content_block_start', wire);
    expect(parsed).toEqual(event);
  });

  test('tool_use block with caller field', () => {
    const block: AnthropicContentBlock = {
      type: 'tool_use',
      id: 'toolu_caller_001',
      name: 'read',
      input: { file_path: '/test.txt' },
      caller: { type: 'direct' },
    };
    const event: AnthropicSSEEvent = {
      type: 'content_block_start',
      index: 10,
      content_block: block,
    };
    const wire = serializeSSEEvent(event);
    const parsed = parseSSEEvent('content_block_start', wire);
    expect(parsed).toEqual(event);
  });

  test('document block with context field', () => {
    const block: AnthropicContentBlock = {
      type: 'document',
      source: { type: 'text', media_type: 'text/plain', data: 'doc content' },
      title: 'notes.txt',
      context: 'User notes from meeting',
    };
    const event: AnthropicSSEEvent = {
      type: 'content_block_start',
      index: 11,
      content_block: block,
    };
    const wire = serializeSSEEvent(event);
    const parsed = parseSSEEvent('content_block_start', wire);
    expect(parsed).toEqual(event);
  });
});

// =========================================================================
// New delta types (added 2026-06-16)
// =========================================================================

describe('New Anthropic delta types', () => {
  test('thinking_delta with estimated_tokens', () => {
    const event: AnthropicSSEEvent = {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'Let me analyze...', estimated_tokens: 142 },
    };
    const wire = serializeSSEEvent(event);
    const parsed = parseSSEEvent('content_block_delta', wire);
    expect(parsed).toEqual(event);
  });

  test('thinking_delta without estimated_tokens (backward compat)', () => {
    // Existing code that doesn't set estimated_tokens should still work
    const event: AnthropicSSEEvent = {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'Hmm...' },
    };
    const wire = serializeSSEEvent(event);
    const parsed = parseSSEEvent('content_block_delta', wire);
    expect(parsed).toEqual(event);
  });

  test('citations_delta round-trips through SSE serialization', () => {
    const citation: import('../protocol-types').TextCitation = {
      type: 'char_location',
      cited_text: 'referenced text',
      document_index: 0,
      document_title: 'Source Document',
      start_char_index: 10,
      end_char_index: 25,
    };
    const event: AnthropicSSEEvent = {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'citations_delta', citation },
    };
    const wire = serializeSSEEvent(event);
    const parsed = parseSSEEvent('content_block_delta', wire);
    expect(parsed).toEqual(event);
  });

  test('citations_delta with web_search_result_location', () => {
    const citation: import('../protocol-types').TextCitation = {
      type: 'web_search_result_location',
      cited_text: 'Pricing data',
      url: 'https://example.com/pricing',
      title: 'Pricing Page',
      encrypted_index: 'enc_idx_123',
    };
    const event: AnthropicSSEEvent = {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'citations_delta', citation },
    };
    const wire = serializeSSEEvent(event);
    const parsed = parseSSEEvent('content_block_delta', wire);
    expect(parsed).toEqual(event);
  });

  test('citations_delta with search_result_location', () => {
    const citation: import('../protocol-types').TextCitation = {
      type: 'search_result_location',
      cited_text: 'Result content',
      search_result_index: 2,
      start_block_index: 0,
      end_block_index: 3,
    };
    const event: AnthropicSSEEvent = {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'citations_delta', citation },
    };
    const wire = serializeSSEEvent(event);
    const parsed = parseSSEEvent('content_block_delta', wire);
    expect(parsed).toEqual(event);
  });

  test('compaction_delta round-trips through SSE serialization', () => {
    const event: AnthropicSSEEvent = {
      type: 'content_block_delta',
      index: 2,
      delta: { type: 'compaction_delta', content: 'compact...', encrypted_content: 'enc_blob' },
    };
    const wire = serializeSSEEvent(event);
    const parsed = parseSSEEvent('content_block_delta', wire);
    expect(parsed).toEqual(event);
  });
});

// =========================================================================
// TextCitation type validation
// =========================================================================

describe('TextCitation', () => {
  test('char_location citation has all required fields', () => {
    const citation: import('../protocol-types').TextCitation = {
      type: 'char_location',
      cited_text: 'exact text match',
      document_index: 0,
      document_title: 'My Doc',
      start_char_index: 5,
      end_char_index: 19,
    };
    expect(citation.type).toBe('char_location');
    expect(citation.cited_text).toBe('exact text match');
    expect(citation.start_char_index).toBe(5);
    expect(citation.end_char_index).toBe(19);
  });

  test('page_location citation', () => {
    const citation: import('../protocol-types').TextCitation = {
      type: 'page_location',
      cited_text: 'text on page',
      document_index: 1,
      document_title: 'PDF Doc',
      start_page_number: 3,
      end_page_number: 5,
    };
    expect(citation.type).toBe('page_location');
    expect(citation.start_page_number).toBe(3);
    expect(citation.end_page_number).toBe(5);
  });

  test('content_block_location citation', () => {
    const citation: import('../protocol-types').TextCitation = {
      type: 'content_block_location',
      cited_text: 'block range text',
      document_index: 0,
      document_title: 'Doc',
      start_block_index: 1,
      end_block_index: 4,
    };
    expect(citation.type).toBe('content_block_location');
    expect(citation.start_block_index).toBe(1);
    expect(citation.end_block_index).toBe(4);
  });

  test('all five citation location types are valid', () => {
    const validTypes = [
      'char_location',
      'page_location',
      'content_block_location',
      'web_search_result_location',
      'search_result_location',
    ] as const;
    validTypes.forEach((t) => {
      const citation: import('../protocol-types').TextCitation = {
        type: t,
        cited_text: 'test',
      };
      expect(citation.type).toBe(t);
    });
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

// =========================================================================
// Runtime Protocol Conformance — validateResponseConformance / validateStreamEventConformance
// =========================================================================

describe('validateResponseConformance', () => {
  test('valid Anthropic response passes conformance check', () => {
    const resp = {
      id: 'msg_123',
      type: 'message',
      role: 'assistant',
      model: 'claude-haiku-4-5-20251001',
      content: [{ type: 'text', text: 'Hello' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      stop_details: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    const result = validateResponseConformance(resp);
    expect(result.valid).toBe(true);
    expect(result.unrecognizedFields.length).toBe(0);
  });

  test('unrecognized top-level field is reported', () => {
    const resp: Record<string, unknown> = {
      id: 'msg_123',
      type: 'message',
      role: 'assistant',
      model: 'claude-haiku-4-5-20251001',
      content: [],
      stop_reason: 'end_turn',
      stop_sequence: null,
      stop_details: null,
      usage: { input_tokens: 10, output_tokens: 5 },
      brand_new_field: 'unexpected!',
    };
    const result = validateResponseConformance(resp);
    expect(result.valid).toBe(false);
    expect(result.unrecognizedFields).toContain('response.brand_new_field');
  });

  test('unrecognized content block type is reported', () => {
    const resp: Record<string, unknown> = {
      id: 'msg_123',
      type: 'message',
      role: 'assistant',
      model: 'claude-test',
      content: [{ type: 'future_block_type', data: 'xyz' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      stop_details: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    const result = validateResponseConformance(resp);
    expect(result.valid).toBe(false);
    expect(result.unrecognizedContentBlockTypes).toContain('content[0].type=future_block_type');
  });

  test('unrecognized usage field is reported', () => {
    const resp: Record<string, unknown> = {
      id: 'msg_123',
      type: 'message',
      role: 'assistant',
      model: 'claude-test',
      content: [],
      stop_reason: 'end_turn',
      stop_sequence: null,
      stop_details: null,
      usage: { input_tokens: 10, output_tokens: 5, new_metric: 42 },
    };
    const result = validateResponseConformance(resp);
    expect(result.valid).toBe(false);
    expect(result.unrecognizedUsageFields).toContain('usage.new_metric');
  });

  test('all 14 known content block types are recognized', () => {
    const knownTypes = [
      'text',
      'thinking',
      'redacted_thinking',
      'tool_use',
      'tool_result',
      'image',
      'document',
      'server_tool_use',
      'web_search_tool_result',
      'web_fetch_tool_result',
      'search_result',
      'compaction',
      'mid_conv_system',
      'fallback',
    ];
    for (const type of knownTypes) {
      const resp: Record<string, unknown> = {
        id: 'msg_123',
        type: 'message',
        role: 'assistant',
        model: 'test',
        content: [{ type }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        stop_details: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      };
      const result = validateResponseConformance(resp);
      expect(result.valid).toBe(true);
    }
  });
});

describe('validateStreamEventConformance', () => {
  test('valid message_delta passes', () => {
    const data = {
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 42 },
    };
    const result = validateStreamEventConformance('message_delta', data);
    expect(result.valid).toBe(true);
  });

  test('unrecognized event type is reported', () => {
    const result = validateStreamEventConformance('new_event_type_2027', {});
    expect(result.valid).toBe(false);
    expect(result.unrecognizedFields).toContain('event.type=new_event_type_2027');
  });

  test('unrecognized delta type is reported', () => {
    const data = {
      delta: { type: 'video_delta', frames: 30 },
      index: 0,
    };
    const result = validateStreamEventConformance('content_block_delta', data);
    expect(result.valid).toBe(false);
    expect(result.unrecognizedDeltaTypes).toContain('delta.type=video_delta');
  });

  test('all 6 known delta types are recognized', () => {
    const deltaTypes = [
      'text_delta',
      'thinking_delta',
      'signature_delta',
      'input_json_delta',
      'citations_delta',
      'compaction_delta',
    ];
    for (const type of deltaTypes) {
      const result = validateStreamEventConformance('content_block_delta', {
        delta: { type },
        index: 0,
      });
      expect(result.valid).toBe(true);
    }
  });

  test('unrecognized usage field in stream is reported', () => {
    const data = {
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 42, stream_tier: 'platinum' },
    };
    const result = validateStreamEventConformance('message_delta', data);
    expect(result.valid).toBe(false);
    expect(result.unrecognizedUsageFields).toContain('usage.stream_tier');
  });
});

// =========================================================================
// stripProviderFields — removes metadata to preserve disk cache prefix
// =========================================================================

describe('stripProviderFields', () => {
  const ds = getConstraints('ds');
  const oc = getConstraints('oc');
  const an = getConstraints('an');

  test('strips metadata from body for ds (DeepSeek)', () => {
    const body: Record<string, unknown> = {
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      metadata: { user_id: 'session-abc-123' },
      messages: [{ role: 'user', content: 'hello' }],
    };
    const stripped = stripProviderFields(body, ds);
    expect(stripped).toBe(true);
    expect(body).not.toHaveProperty('metadata');
    expect(body.model).toBe('claude-sonnet-4-6'); // other fields preserved
    expect(body.max_tokens).toBe(500);
    expect(body.messages).toBeDefined();
  });

  test('strips metadata from body for oc (OpenCode)', () => {
    const body: Record<string, unknown> = {
      model: 'claude-haiku-4-5-20251001',
      metadata: { user_id: 'session-xyz-789' },
    };
    const stripped = stripProviderFields(body, oc);
    expect(stripped).toBe(true);
    expect(body).not.toHaveProperty('metadata');
  });

  test('no stripFields → no-op (Anthropic native)', () => {
    const body: Record<string, unknown> = {
      model: 'claude-opus-4-7',
      metadata: { user_id: 'keep-me' },
    };
    const stripped = stripProviderFields(body, an);
    expect(stripped).toBe(false);
    expect(body.metadata).toBeDefined(); // an has no stripFields
  });

  test('returns false when no fields present to strip', () => {
    const body: Record<string, unknown> = {
      model: 'deepseek-v4-pro',
      messages: [],
    };
    const stripped = stripProviderFields(body, ds);
    expect(stripped).toBe(false);
  });

  test('empty body — no-op', () => {
    const body: Record<string, unknown> = {};
    const stripped = stripProviderFields(body, ds);
    expect(stripped).toBe(false);
  });

  test('multiple fields stripped when multiple in stripFields', () => {
    const or = getConstraints('or');
    const body: Record<string, unknown> = {
      top_k: 40,
      metadata: { user_id: 'test' },
      model: 'deepseek-v4-pro',
    };
    const stripped = stripProviderFields(body, or);
    expect(stripped).toBe(true);
    expect(body).not.toHaveProperty('top_k');
    expect(body).not.toHaveProperty('metadata');
    expect(body.model).toBe('deepseek-v4-pro'); // preserved
  });

  test('identical bodies with different metadata become identical after strip', () => {
    const bodyA = { model: 'x', metadata: { user_id: 'aaa' }, messages: [] };
    const bodyB = { model: 'x', metadata: { user_id: 'bbb' }, messages: [] };
    stripProviderFields(bodyA as Record<string, unknown>, ds);
    stripProviderFields(bodyB as Record<string, unknown>, ds);
    expect(JSON.stringify(bodyA)).toBe(JSON.stringify(bodyB));
  });
});

// =========================================================================
// stripSystemBillingHeader — removes Anthropic billing header from system
// =========================================================================

describe('stripSystemBillingHeader', () => {
  test('strips billing header block from system array', () => {
    const body: Record<string, unknown> = {
      model: 'deepseek-v4-pro',
      system: [
        {
          type: 'text',
          text: 'x-anthropic-billing-header: cc_version=2.1.177.841; cc_entrypoint=cli; cch=6d025;',
        },
        {
          type: 'text',
          text: "You are Claude Code, Anthropic's official CLI for Claude.",
          cache_control: { type: 'ephemeral' },
        },
      ],
    };
    const modified = stripSystemBillingHeader(body);
    expect(modified).toBe(true);
    const sys = body.system as Array<Record<string, unknown>>;
    expect(sys.length).toBe(1);
    expect(sys[0].text).toBe("You are Claude Code, Anthropic's official CLI for Claude.");
  });

  test('no billing header → no-op', () => {
    const body: Record<string, unknown> = {
      model: 'deepseek-v4-pro',
      system: [
        {
          type: 'text',
          text: 'You are a helpful assistant.',
        },
      ],
    };
    const modified = stripSystemBillingHeader(body);
    expect(modified).toBe(false);
    expect((body.system as Array<Record<string, unknown>>).length).toBe(1);
  });

  test('non-array system → no-op', () => {
    const body: Record<string, unknown> = {
      model: 'deepseek-v4-pro',
      system: 'plain string system prompt',
    };
    const modified = stripSystemBillingHeader(body);
    expect(modified).toBe(false);
    expect(body.system).toBe('plain string system prompt');
  });

  test('no system field → no-op', () => {
    const body: Record<string, unknown> = {
      model: 'deepseek-v4-pro',
      messages: [],
    };
    const modified = stripSystemBillingHeader(body);
    expect(modified).toBe(false);
  });

  test('other system blocks preserved after strip', () => {
    const body: Record<string, unknown> = {
      system: [
        {
          type: 'text',
          text: 'x-anthropic-billing-header: cc_version=2.1.177.841; cc_entrypoint=cli; cch=abc12;',
        },
        {
          type: 'text',
          text: 'You are Claude Code.',
          cache_control: { type: 'ephemeral' },
        },
        {
          type: 'text',
          text: 'You are an interactive agent.',
          cache_control: { type: 'ephemeral' },
        },
      ],
    };
    stripSystemBillingHeader(body);
    const sys = body.system as Array<Record<string, unknown>>;
    expect(sys.length).toBe(2);
    expect(sys[0].text).toBe('You are Claude Code.');
    expect(sys[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(sys[1].text).toBe('You are an interactive agent.');
    expect(sys[1].cache_control).toEqual({ type: 'ephemeral' });
  });

  test('idempotent — stripping twice returns false second time', () => {
    const body: Record<string, unknown> = {
      system: [
        {
          type: 'text',
          text: 'x-anthropic-billing-header: cch=6d025;',
        },
        { type: 'text', text: 'You are Claude Code.' },
      ],
    };
    expect(stripSystemBillingHeader(body)).toBe(true);
    expect(stripSystemBillingHeader(body)).toBe(false);
  });

  test('identical bodies with different cch become identical after strip', () => {
    const bodyA: Record<string, unknown> = {
      model: 'deepseek-v4-pro',
      system: [
        {
          type: 'text',
          text: 'x-anthropic-billing-header: cc_version=2.1.177.841; cc_entrypoint=cli; cch=6d025;',
        },
        { type: 'text', text: 'You are Claude Code.' },
      ],
      messages: [{ role: 'user', content: 'hello' }],
    };
    const bodyB: Record<string, unknown> = {
      model: 'deepseek-v4-pro',
      system: [
        {
          type: 'text',
          text: 'x-anthropic-billing-header: cc_version=2.1.999.0; cc_entrypoint=cli; cch=95c1d;',
        },
        { type: 'text', text: 'You are Claude Code.' },
      ],
      messages: [{ role: 'user', content: 'hello' }],
    };
    stripSystemBillingHeader(bodyA);
    stripSystemBillingHeader(bodyB);
    expect(JSON.stringify(bodyA)).toBe(JSON.stringify(bodyB));
  });

  test('strip metadata + billing together', () => {
    const ds = getConstraints('ds');
    const body: Record<string, unknown> = {
      model: 'deepseek-v4-pro',
      metadata: { user_id: 'session-123' },
      system: [
        {
          type: 'text',
          text: 'x-anthropic-billing-header: cch=6d025;',
        },
        { type: 'text', text: 'You are Claude Code.' },
      ],
    };
    const stripped = stripProviderFields(body, ds);
    const billingStripped = stripSystemBillingHeader(body);
    expect(stripped).toBe(true);
    expect(billingStripped).toBe(true);
    expect(body).not.toHaveProperty('metadata');
    const sys = body.system as Array<Record<string, unknown>>;
    expect(sys.length).toBe(1);
    expect(sys[0].text).toBe('You are Claude Code.');
  });
});

// =========================================================================
// stripCacheControl — removes Anthropic prompt-caching metadata from blocks
// =========================================================================

describe('stripCacheControl', () => {
  test('strips cache_control from tool_result blocks', () => {
    const body: Record<string, unknown> = {
      model: 'deepseek-v4-pro',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call_1',
              content: 'ok',
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
      ],
    };
    const modified = stripCacheControl(body);
    expect(modified).toBe(true);
    const block = (body.messages as Array<Record<string, unknown>>)[0].content as Array<
      Record<string, unknown>
    >;
    expect(block[0]).not.toHaveProperty('cache_control');
  });

  test('no cache_control → no-op', () => {
    const body: Record<string, unknown> = {
      model: 'deepseek-v4-pro',
      messages: [
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'ok' }] },
      ],
    };
    const modified = stripCacheControl(body);
    expect(modified).toBe(false);
  });

  test('no messages → no-op', () => {
    const body: Record<string, unknown> = { model: 'deepseek-v4-pro' };
    const modified = stripCacheControl(body);
    expect(modified).toBe(false);
  });

  test('strips multiple cache_control blocks', () => {
    const body: Record<string, unknown> = {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'a', cache_control: { type: 'ephemeral' } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'b', cache_control: { type: 'ephemeral' } },
          ],
        },
      ],
    };
    const modified = stripCacheControl(body);
    expect(modified).toBe(true);
    const msgs = body.messages as Array<Record<string, unknown>>;
    for (const msg of msgs) {
      for (const block of msg.content as Array<Record<string, unknown>>) {
        expect(block).not.toHaveProperty('cache_control');
      }
    }
  });

  test('other block fields preserved', () => {
    const body: Record<string, unknown> = {
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call_1',
              content: 'ok',
              is_error: false,
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
      ],
    };
    stripCacheControl(body);
    const block = (body.messages as Array<Record<string, unknown>>)[0].content as Array<
      Record<string, unknown>
    >;
    expect(block[0].type).toBe('tool_result');
    expect(block[0].tool_use_id).toBe('call_1');
    expect(block[0].content).toBe('ok');
    expect(block[0].is_error).toBe(false);
  });

  test('full strip pipeline: metadata + billing + cache_control', () => {
    const ds = getConstraints('ds');
    const body: Record<string, unknown> = {
      model: 'deepseek-v4-pro',
      metadata: { user_id: 'session-123' },
      system: [
        { type: 'text', text: 'x-anthropic-billing-header: cch=abc12;' },
        { type: 'text', text: 'You are Claude Code.' },
      ],
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call_1',
              content: 'ok',
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
      ],
    };
    const s1 = stripProviderFields(body, ds);
    const s2 = stripSystemBillingHeader(body);
    const s3 = stripCacheControl(body);
    expect(s1).toBe(true);
    expect(s2).toBe(true);
    expect(s3).toBe(true);
    expect(body).not.toHaveProperty('metadata');
    expect((body.system as Array<Record<string, unknown>>).length).toBe(1);
    const block = (body.messages as Array<Record<string, unknown>>)[0].content as Array<
      Record<string, unknown>
    >;
    expect(block[0]).not.toHaveProperty('cache_control');
  });
});

// --- stripDuplicateMessages ---

describe('stripDuplicateMessages', () => {
  test('strips duplicate consecutive tool_result messages', () => {
    const body: Record<string, unknown> = {
      messages: [
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b', content: 'done' }] },
      ],
    };
    expect(stripDuplicateMessages(body)).toBe(true);
    const msgs = body.messages as Array<Record<string, unknown>>;
    expect(msgs.length).toBe(2);
    expect(msgs[1].content).toEqual([{ type: 'tool_result', tool_use_id: 'b', content: 'done' }]);
  });

  test('keeps non-duplicate messages', () => {
    const body: Record<string, unknown> = {
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi there' },
        { role: 'user', content: 'bye' },
      ],
    };
    expect(stripDuplicateMessages(body)).toBe(false);
    expect((body.messages as Array<unknown>).length).toBe(3);
  });

  test('strips only consecutive duplicates (not non-consecutive)', () => {
    const body: Record<string, unknown> = {
      messages: [
        { role: 'user', content: 'A' },
        { role: 'assistant', content: 'B' },
        { role: 'user', content: 'A' },
      ],
    };
    expect(stripDuplicateMessages(body)).toBe(false);
    expect((body.messages as Array<unknown>).length).toBe(3);
  });

  test('different role, same content → not stripped', () => {
    const body: Record<string, unknown> = {
      messages: [
        { role: 'user', content: 'same text' },
        { role: 'assistant', content: 'same text' },
      ],
    };
    expect(stripDuplicateMessages(body)).toBe(false);
    expect((body.messages as Array<unknown>).length).toBe(2);
  });

  test('empty messages array is no-op', () => {
    const body: Record<string, unknown> = { messages: [] };
    expect(stripDuplicateMessages(body)).toBe(false);
  });

  test('single message is no-op', () => {
    const body: Record<string, unknown> = { messages: [{ role: 'user', content: 'hi' }] };
    expect(stripDuplicateMessages(body)).toBe(false);
  });

  test('strips multiple consecutive duplicate groups', () => {
    const body: Record<string, unknown> = {
      messages: [
        { role: 'user', content: 'A' },
        { role: 'user', content: 'A' },
        { role: 'assistant', content: 'B' },
        { role: 'assistant', content: 'B' },
        { role: 'user', content: 'C' },
      ],
    };
    expect(stripDuplicateMessages(body)).toBe(true);
    expect((body.messages as Array<unknown>).length).toBe(3);
  });

  test('no messages field is no-op', () => {
    const body: Record<string, unknown> = { model: 'test' };
    expect(stripDuplicateMessages(body)).toBe(false);
  });
});
