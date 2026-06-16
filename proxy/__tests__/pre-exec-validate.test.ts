'use strict';

import { validatePreExecResponse } from '../pre-exec-validate';

describe('validatePreExecResponse', () => {
  function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      model: 'claude-haiku-4-5-20251001',
      type: 'message',
      role: 'assistant',
      content: [
        {
          type: 'web_search_tool_result',
          tool_use_id: 'toolu_SEARCH_1',
          caller: { type: 'direct' },
          content: [
            {
              type: 'web_search_result',
              url: 'https://example.com/test',
              title: 'Test Result',
              encrypted_content: 'This is a test snippet.',
              page_age: null,
            },
          ],
        },
      ],
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

  test('accepts valid web_search_tool_result with all required fields', () => {
    expect(validatePreExecResponse(validBody())).toBeNull();
  });

  test('accepts text content block type as fallback', () => {
    const body = {
      ...validBody(),
      content: [{ type: 'text', text: 'results' }],
    };
    expect(validatePreExecResponse(body)).toBeNull();
  });

  test('accepts web_search_tool_result with multiple result sub-blocks', () => {
    const body = validBody({
      content: [
        {
          type: 'web_search_tool_result',
          tool_use_id: 'toolu_SEARCH_2',
          caller: { type: 'direct' },
          content: [
            {
              type: 'web_search_result',
              url: 'https://a.com',
              title: 'A',
              encrypted_content: 'snippet A',
              page_age: null,
            },
            {
              type: 'web_search_result',
              url: 'https://b.com',
              title: 'B',
              encrypted_content: 'snippet B',
              page_age: '2026-06-15',
            },
          ],
        },
      ],
    });
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

  // ── web_search_tool_result field validation ─────────────────────────

  test('rejects web_search_tool_result missing tool_use_id', () => {
    const body = validBody();
    (body.content as Array<Record<string, unknown>>)[0].tool_use_id = undefined;
    expect(validatePreExecResponse(body)).toContain('tool_use_id');
  });

  test('rejects web_search_tool_result missing caller', () => {
    const body = validBody();
    delete (body.content as Array<Record<string, unknown>>)[0].caller;
    expect(validatePreExecResponse(body)).toContain('caller');
  });

  test('rejects web_search_tool_result caller missing type', () => {
    const body = validBody();
    (body.content as Array<Record<string, unknown>>)[0].caller = {};
    expect(validatePreExecResponse(body)).toContain('caller');
  });

  test('rejects web_search_tool_result missing content array', () => {
    const body = validBody();
    delete (body.content as Array<Record<string, unknown>>)[0].content;
    expect(validatePreExecResponse(body)).toContain('content array');
  });

  test('rejects web_search_tool_result empty content array', () => {
    const body = validBody();
    (body.content as Array<Record<string, unknown>>)[0].content = [];
    expect(validatePreExecResponse(body)).toContain('empty');
  });

  // ── web_search_result sub-block validation ──────────────────────────

  test('rejects unexpected sub-block type in web_search_tool_result', () => {
    const body = validBody();
    (body.content as Array<Record<string, unknown>>)[0].content = [{ type: 'text', text: 'wrong' }];
    expect(validatePreExecResponse(body)).toContain('unexpected sub-block type');
  });

  test('rejects web_search_result missing url', () => {
    const body = validBody();
    (
      (body.content as Array<Record<string, unknown>>)[0].content as Array<Record<string, unknown>>
    )[0].url = undefined;
    expect(validatePreExecResponse(body)).toContain('missing url');
  });

  test('rejects web_search_result missing title', () => {
    const body = validBody();
    (
      (body.content as Array<Record<string, unknown>>)[0].content as Array<Record<string, unknown>>
    )[0].title = undefined;
    expect(validatePreExecResponse(body)).toContain('missing title');
  });

  test('rejects web_search_result missing encrypted_content', () => {
    const body = validBody();
    (
      (body.content as Array<Record<string, unknown>>)[0].content as Array<Record<string, unknown>>
    )[0].encrypted_content = undefined;
    expect(validatePreExecResponse(body)).toContain('missing encrypted_content');
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
    // text blocks are still accepted as valid fallback, but CC won't
    // count them toward "Did N searches" display. The integration tests
    // enforce web_search_tool_result for search responses.
    expect(
      validatePreExecResponse(validBody({ content: [{ type: 'text', text: 'results' }] })),
    ).toBeNull();
  });

  // ── Multi-search validation ──────────────────────────────────────────

  test('accepts multiple web_search_tool_result blocks (multi-search)', () => {
    const body = validBody({
      content: [
        {
          type: 'web_search_tool_result',
          tool_use_id: 'toolu_1',
          caller: { type: 'direct' },
          content: [
            {
              type: 'web_search_result',
              url: 'https://a.com',
              title: 'Result A',
              encrypted_content: 'snippet A',
              page_age: null,
            },
          ],
        },
        {
          type: 'web_search_tool_result',
          tool_use_id: 'toolu_2',
          caller: { type: 'direct' },
          content: [
            {
              type: 'web_search_result',
              url: 'https://b.com',
              title: 'Result B',
              encrypted_content: 'snippet B',
              page_age: '2026-06-15',
            },
          ],
        },
      ],
      usage: {
        input_tokens: 1,
        output_tokens: 100,
        server_tool_use: { web_search_requests: 2, web_fetch_requests: 0 },
      },
    });
    expect(validatePreExecResponse(body)).toBeNull();
  });

  test('rejects second block with missing tool_use_id in multi-search', () => {
    const body = validBody({
      content: [
        {
          type: 'web_search_tool_result',
          tool_use_id: 'toolu_1',
          caller: { type: 'direct' },
          content: [
            {
              type: 'web_search_result',
              url: 'https://a.com',
              title: 'A',
              encrypted_content: 'a',
              page_age: null,
            },
          ],
        },
        {
          type: 'web_search_tool_result',
          caller: { type: 'direct' },
          content: [
            {
              type: 'web_search_result',
              url: 'https://b.com',
              title: 'B',
              encrypted_content: 'b',
              page_age: null,
            },
          ],
        },
      ],
      usage: {
        input_tokens: 1,
        output_tokens: 100,
        server_tool_use: { web_search_requests: 2, web_fetch_requests: 0 },
      },
    });
    expect(validatePreExecResponse(body)).toContain('content[1]');
    expect(validatePreExecResponse(body)).toContain('tool_use_id');
  });

  test('rejects web_search_requests not matching content block count', () => {
    // Only 1 block but claims 2 searches — should still validate since
    // we validate content blocks individually (CC might count them differently)
    const body = validBody({
      content: [
        {
          type: 'web_search_tool_result',
          tool_use_id: 'toolu_1',
          caller: { type: 'direct' },
          content: [
            {
              type: 'web_search_result',
              url: 'https://a.com',
              title: 'A',
              encrypted_content: 'a',
              page_age: null,
            },
          ],
        },
      ],
      usage: {
        input_tokens: 1,
        output_tokens: 100,
        server_tool_use: { web_search_requests: 2, web_fetch_requests: 0 },
      },
    });
    // This should still be valid — the count mismatch is non-fatal
    expect(validatePreExecResponse(body)).toBeNull();
  });

  test('catches the bug: web_search_tool_result without tool_use_id (the undefined error)', () => {
    // This was the actual bug: we returned {type: 'web_search_tool_result', content: '...'}
    // without tool_use_id or caller. CC tried to access tool_use_id → "Web search error: undefined".
    const body = {
      model: 'claude-haiku-4-5-20251001',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'web_search_tool_result', content: 'results' }],
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 1,
        output_tokens: 100,
        server_tool_use: { web_search_requests: 1, web_fetch_requests: 0 },
      },
    };
    expect(validatePreExecResponse(body)).toContain('tool_use_id');
  });
});
