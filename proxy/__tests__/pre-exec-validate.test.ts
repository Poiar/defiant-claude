'use strict';

import { validatePreExecResponse } from '../pre-exec-validate';

describe('validatePreExecResponse', () => {
  function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      model: 'claude-haiku-4-5-20251001',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'web_search_tool_result', content: 'search results here' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 1,
        output_tokens: 100,
        server_tool_use: { web_search_requests: 1, web_fetch_requests: 0 },
      },
      ...overrides,
    };
  }

  // ── Valid responses ─────────────────────────────────────────────────

  test('accepts web_search_tool_result content block type', () => {
    expect(validatePreExecResponse(validBody())).toBeNull();
  });

  test('accepts text content block type as fallback', () => {
    const body = validBody({ content: [{ type: 'text', text: 'results' }] });
    expect(validatePreExecResponse(body)).toBeNull();
  });

  // ── Model validation ────────────────────────────────────────────────

  test('rejects missing model', () => {
    const body = validBody();
    delete body.model;
    expect(validatePreExecResponse(body)).toContain('model');
  });

  test('rejects non-string model', () => {
    const body = validBody({ model: 123 });
    expect(validatePreExecResponse(body)).toContain('model');
  });

  test('rejects model not starting with claude-', () => {
    expect(validatePreExecResponse(validBody({ model: 'deepseek-v4-flash' }))).toContain(
      'does not start with claude-',
    );
    expect(validatePreExecResponse(validBody({ model: 'haiku:deepseek-v4-flash' }))).toContain(
      'does not start with claude-',
    );
  });

  // ── Content block validation ────────────────────────────────────────

  test('rejects missing content array', () => {
    const body = validBody();
    delete body.content;
    expect(validatePreExecResponse(body)).toContain('content');
  });

  test('rejects empty content array', () => {
    expect(validatePreExecResponse(validBody({ content: [] }))).toContain('empty');
  });

  test('rejects non-array content', () => {
    expect(validatePreExecResponse(validBody({ content: 'not an array' }))).toContain('content');
  });

  test('rejects unexpected content block type', () => {
    expect(
      validatePreExecResponse(
        validBody({ content: [{ type: 'tool_use', id: 'x', name: 'y', input: {} }] }),
      ),
    ).toContain('unexpected content block type');
  });

  // ── Usage / server_tool_use validation ─────────────────────────────

  test('rejects missing usage', () => {
    const body = validBody();
    delete body.usage;
    expect(validatePreExecResponse(body)).toContain('missing usage');
  });

  test('rejects missing server_tool_use', () => {
    const body = validBody({ usage: { input_tokens: 1, output_tokens: 2 } });
    expect(validatePreExecResponse(body)).toContain('server_tool_use');
  });

  test('rejects server_tool_use with web_search_requests < 1', () => {
    const body = validBody({
      usage: {
        input_tokens: 1,
        output_tokens: 2,
        server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
      },
    });
    expect(validatePreExecResponse(body)).toContain('web_search_requests');
  });

  test('rejects server_tool_use with missing web_search_requests', () => {
    const body = validBody({
      usage: {
        input_tokens: 1,
        output_tokens: 2,
        server_tool_use: { web_fetch_requests: 0 },
      },
    });
    expect(validatePreExecResponse(body)).toContain('web_search_requests');
  });

  // ── Real-world scenarios ────────────────────────────────────────────

  test('catches the bug: text block without web_search_tool_result', () => {
    // This was the actual bug: pre-exec returned text blocks instead
    // of web_search_tool_result. CC counted zero search blocks → "Did 0 searches".
    // The validator still ACCEPTS text (it's a valid fallback), but the
    // integration tests now check for web_search_tool_result specifically.
    // This test ensures the validator doesn't reject text — it's the
    // integration test's job to enforce web_search_tool_result.
    expect(
      validatePreExecResponse(validBody({ content: [{ type: 'text', text: 'results' }] })),
    ).toBeNull();
  });
});
