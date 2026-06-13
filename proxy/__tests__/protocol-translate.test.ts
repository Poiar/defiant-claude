'use strict';

import {
  translateRequest,
  translateResponse,
  createStreamTransformer,
  createAnthropicStreamInterceptor,
} from '../protocol-translate';

// ---------------------------------------------------------------------------
// Stream test helpers
// ---------------------------------------------------------------------------

function sse(data: unknown) {
  return `data: ${JSON.stringify(data)}\n\n`;
}

function collectStream(chunks: string[], model?: string) {
  return new Promise<string>((resolve, reject) => {
    const transformer = createStreamTransformer(model || 'claude-model');
    let output = '';
    transformer.on('data', (chunk: string) => {
      output += chunk.toString();
    });
    transformer.on('end', () => resolve(output));
    transformer.on('error', reject);
    for (const chunk of chunks) {
      transformer.write(chunk);
    }
    transformer.end();
  });
}

function parseSSE(output: string) {
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const parts = output.split('\n\n');
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    let eventType = '';
    let jsonStr = '';
    for (const line of trimmed.split('\n')) {
      if (line.startsWith('event: ')) eventType = line.slice(7);
      else if (line.startsWith('data: ')) jsonStr = line.slice(6);
    }
    if (jsonStr) {
      events.push({ event: eventType, data: JSON.parse(jsonStr) });
    }
  }
  return events;
}

// ===========================================================================
// translateRequest
// ===========================================================================

describe('translateRequest', () => {
  function minimalBody() {
    return { model: 'claude-sonnet-4', messages: [{ role: 'user', content: 'Hi' }] };
  }

  // -- System prompt --------------------------------------------------------

  test('converts system prompt from string', () => {
    const { openaiBody } = translateRequest({
      ...minimalBody(),
      system: 'You are a helpful assistant.',
    });
    expect(openaiBody.messages[0]).toEqual({
      role: 'system',
      content: 'You are a helpful assistant.',
    });
    expect(openaiBody.messages[1].role).toBe('user');
  });

  test('converts system prompt from array of text blocks', () => {
    const { openaiBody } = translateRequest({
      ...minimalBody(),
      system: [
        { type: 'text', text: 'Be concise.' },
        { type: 'text', text: 'Be accurate.' },
      ],
    });
    expect(openaiBody.messages[0].role).toBe('system');
    expect(openaiBody.messages[0].content).toBe('Be concise.\nBe accurate.');
  });

  test('omits system message when system is empty array', () => {
    const { openaiBody } = translateRequest({
      ...minimalBody(),
      system: [],
    });
    expect(openaiBody.messages[0].role).toBe('user');
  });

  test('omits system message when system is undefined', () => {
    const { openaiBody } = translateRequest(minimalBody());
    expect(openaiBody.messages[0].role).toBe('user');
  });

  // -- User messages --------------------------------------------------------

  test('converts user message with string content', () => {
    const { openaiBody } = translateRequest({
      model: 'claude-sonnet-4',
      messages: [{ role: 'user', content: 'Hello world' }],
    });
    expect(openaiBody.messages).toEqual([{ role: 'user', content: 'Hello world' }]);
  });

  test('converts user message with text-only array content', () => {
    const { openaiBody } = translateRequest({
      model: 'claude-sonnet-4',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Hello' },
            { type: 'text', text: ' world' },
          ],
        },
      ],
    });
    expect(openaiBody.messages).toEqual([{ role: 'user', content: 'Hello\n world' }]);
  });

  test('converts user message with tool_result blocks to tool role', () => {
    const { openaiBody } = translateRequest({
      model: 'claude-sonnet-4',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tu_abc', content: '42' },
            { type: 'tool_result', tool_use_id: 'tu_def', content: 'blue' },
          ],
        },
      ],
    });
    expect(openaiBody.messages).toEqual([
      { role: 'tool', tool_call_id: 'tu_abc', content: '42' },
      { role: 'tool', tool_call_id: 'tu_def', content: 'blue' },
    ]);
  });

  test('converts user message with text and tool_result together', () => {
    const { openaiBody } = translateRequest({
      model: 'claude-sonnet-4',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tu_1', content: 'result data' },
            { type: 'text', text: 'Thanks!' },
          ],
        },
      ],
    });
    expect(openaiBody.messages).toEqual([
      { role: 'tool', tool_call_id: 'tu_1', content: 'result data' },
      { role: 'user', content: 'Thanks!' },
    ]);
  });

  test('converts tool_result with array content using stringifyContent', () => {
    const { openaiBody } = translateRequest({
      model: 'claude-sonnet-4',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu_1',
              content: [
                { type: 'text', text: 'Temperature is ' },
                { type: 'text', text: '72F' },
              ],
            },
          ],
        },
      ],
    });
    expect(openaiBody.messages[0].content).toBe('Temperature is \n72F');
  });

  test('converts user message with image blocks', () => {
    const { openaiBody } = translateRequest({
      model: 'claude-sonnet-4',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is this?' },
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: 'abc123' },
            },
          ],
        },
      ],
    });
    expect(openaiBody.messages[0].content).toEqual([
      { type: 'text', text: 'What is this?' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,abc123' } },
    ]);
  });

  test('converts user message with only image and no text', () => {
    const { openaiBody } = translateRequest({
      model: 'claude-sonnet-4',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/jpeg', data: 'xyz' },
            },
          ],
        },
      ],
    });
    expect(openaiBody.messages[0].content).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,xyz' } },
    ]);
  });

  // -- Assistant messages ---------------------------------------------------

  test('converts assistant message with string content', () => {
    const { openaiBody } = translateRequest({
      model: 'claude-sonnet-4',
      messages: [{ role: 'assistant', content: 'Sure, here is the answer.' }],
    });
    expect(openaiBody.messages).toEqual([
      { role: 'assistant', content: 'Sure, here is the answer.' },
    ]);
  });

  test('converts assistant message with text and tool_use blocks', () => {
    const { openaiBody } = translateRequest({
      model: 'claude-sonnet-4',
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me look that up.' },
            { type: 'tool_use', id: 'tu_1', name: 'get_weather', input: { location: 'NYC' } },
          ],
        },
      ],
    });
    const msg = openaiBody.messages[0];
    expect(msg.role).toBe('assistant');
    expect(msg.content).toBe('Let me look that up.');
    expect(msg.tool_calls).toEqual([
      {
        id: 'tu_1',
        type: 'function',
        function: { name: 'get_weather', arguments: '{"location":"NYC"}' },
      },
    ]);
  });

  test('converts assistant message with only tool_use (no text)', () => {
    const { openaiBody } = translateRequest({
      model: 'claude-sonnet-4',
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tu_x', name: 'search', input: { query: 'test' } }],
        },
      ],
    });
    const msg = openaiBody.messages[0];
    expect(msg.role).toBe('assistant');
    expect(msg.content).toBeUndefined();
    expect(msg.tool_calls).toHaveLength(1);
  });

  // -- Tools ----------------------------------------------------------------

  test('converts tools array with input_schema to parameters', () => {
    const { openaiBody } = translateRequest({
      ...minimalBody(),
      tools: [
        {
          name: 'get_weather',
          description: 'Get the weather for a location',
          input_schema: {
            type: 'object',
            properties: { loc: { type: 'string' } },
            required: ['loc'],
          },
        },
      ],
    });
    expect(openaiBody.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get the weather for a location',
          parameters: {
            type: 'object',
            properties: { loc: { type: 'string' } },
            required: ['loc'],
          },
        },
      },
    ]);
  });

  test('handles tools with no description', () => {
    const { openaiBody } = translateRequest({
      ...minimalBody(),
      tools: [{ name: 'ping', input_schema: { type: 'object' } }],
    });
    expect(openaiBody.tools[0].function.description).toBe('');
  });

  test('omits tools when tools array is empty', () => {
    const { openaiBody } = translateRequest({
      ...minimalBody(),
      tools: [],
    });
    expect(openaiBody.tools).toBeUndefined();
  });

  // -- Parameter passthrough ------------------------------------------------

  test('passes max_tokens, temperature, top_p', () => {
    const { openaiBody } = translateRequest({
      ...minimalBody(),
      max_tokens: 4096,
      temperature: 0.7,
      top_p: 0.95,
    });
    expect(openaiBody.max_tokens).toBe(4096);
    expect(openaiBody.temperature).toBe(0.7);
    expect(openaiBody.top_p).toBe(0.95);
  });

  test('omits optional params when not set', () => {
    const { openaiBody } = translateRequest(minimalBody());
    expect(openaiBody.max_tokens).toBeUndefined();
    expect(openaiBody.temperature).toBeUndefined();
    expect(openaiBody.top_p).toBeUndefined();
    expect(openaiBody.stop).toBeUndefined();
  });

  test('converts stop_sequences to stop', () => {
    const { openaiBody } = translateRequest({
      ...minimalBody(),
      stop_sequences: ['\n\n', 'Human:', '###'],
    });
    expect(openaiBody.stop).toEqual(['\n\n', 'Human:', '###']);
  });

  test('omits stop when stop_sequences is empty', () => {
    const { openaiBody } = translateRequest({
      ...minimalBody(),
      stop_sequences: [],
    });
    expect(openaiBody.stop).toBeUndefined();
  });

  // -- tool_choice ----------------------------------------------------------

  test('translates tool_choice auto', () => {
    const { openaiBody } = translateRequest({
      ...minimalBody(),
      tool_choice: 'auto',
    });
    expect(openaiBody.tool_choice).toBe('auto');
  });

  test('translates tool_choice any to required', () => {
    const { openaiBody } = translateRequest({
      ...minimalBody(),
      tool_choice: 'any',
    });
    expect(openaiBody.tool_choice).toBe('required');
  });

  test('translates tool_choice specific tool', () => {
    const { openaiBody } = translateRequest({
      ...minimalBody(),
      tool_choice: { type: 'tool', name: 'get_weather' },
    });
    expect(openaiBody.tool_choice).toEqual({
      type: 'function',
      function: { name: 'get_weather' },
    });
  });

  test('translates tool_choice none to "none"', () => {
    const { openaiBody } = translateRequest({
      ...minimalBody(),
      tool_choice: { type: 'none' },
    });
    expect(openaiBody.tool_choice).toBe('none');
  });

  test('defaults tool_choice to auto when unrecognized', () => {
    const { openaiBody } = translateRequest({
      ...minimalBody(),
      tool_choice: { type: 'something_else' },
    });
    expect(openaiBody.tool_choice).toBe('auto');
  });

  // -- Stream flag ----------------------------------------------------------

  test('passes stream flag as true', () => {
    const { openaiBody } = translateRequest({
      ...minimalBody(),
      stream: true,
    });
    expect(openaiBody.stream).toBe(true);
  });

  test('adds stream_options with include_usage when streaming', () => {
    const { openaiBody } = translateRequest({
      ...minimalBody(),
      stream: true,
    });
    expect(openaiBody.stream_options).toEqual({ include_usage: true });
  });

  test('does not add stream_options when not streaming', () => {
    const { openaiBody } = translateRequest(minimalBody());
    expect(openaiBody.stream_options).toBeUndefined();
  });

  test('defaults stream flag to false when not set', () => {
    const { openaiBody } = translateRequest(minimalBody());
    expect(openaiBody.stream).toBe(false);
  });

  // -- Return structure -----------------------------------------------------

  test('returns model alongside openaiBody', () => {
    const result = translateRequest({
      model: 'my-custom-model',
      messages: [{ role: 'user', content: 'Hi' }],
    });
    expect(result.model).toBe('my-custom-model');
    expect(result.openaiBody.model).toBe('my-custom-model');
  });

  test('handles empty messages array', () => {
    const { openaiBody } = translateRequest({
      model: 'test',
      messages: [],
    });
    expect(openaiBody.messages).toEqual([]);
  });

  // -- Thinking passthrough ---------------------------------------------------

  // thinking is NOT passed through to openaiBody by translateRequest.
  // start-proxy.ts reads budget_tokens from the original Anthropic request
  // body and derives the correct reasoning_effort for the target provider.

  test('does not pass thinking through to openaiBody', () => {
    const { openaiBody } = translateRequest({
      ...minimalBody(),
      thinking: { type: 'enabled', budget_tokens: 32000 },
    });
    // translateRequest deliberately omits thinking — start-proxy.ts
    // injects it with the correctly mapped reasoning_effort.
    expect(openaiBody.thinking).toBeUndefined();
  });

  test('omits thinking when not present in request', () => {
    const { openaiBody } = translateRequest(minimalBody());
    expect(openaiBody.thinking).toBeUndefined();
  });
});

// ===========================================================================
// translateResponse
// ===========================================================================

describe('translateResponse', () => {
  // -- Basic response -------------------------------------------------------

  test('converts a basic text response', () => {
    const result = translateResponse(
      {
        id: 'chatcmpl-abc123',
        choices: [
          {
            message: { content: 'Hello there!' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 15, completion_tokens: 25 },
      },
      'claude-sonnet-4',
    );

    expect(result.id).toBe('chatcmpl-abc123');
    expect(result.type).toBe('message');
    expect(result.model).toBe('claude-sonnet-4');
    expect(result.role).toBe('assistant');
    expect(result.content).toEqual([{ type: 'text', text: 'Hello there!' }]);
    expect(result.stop_reason).toBe('end_turn');
    expect(result.stop_sequence).toBeNull();
    expect(result.usage).toEqual({ input_tokens: 15, output_tokens: 25 });
  });

  test('converts response with no content field', () => {
    const result = translateResponse(
      {
        choices: [{ message: {}, finish_reason: 'stop' }],
        usage: {},
      },
      'test',
    );
    expect(result.content).toEqual([]);
  });

  // -- Tool calls -----------------------------------------------------------

  test('converts response with tool_calls', () => {
    const result = translateResponse(
      {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: 'call_weather',
                  type: 'function',
                  function: { name: 'get_weather', arguments: '{"location":"NYC"}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      },
      'claude-sonnet-4',
    );

    expect(result.content).toEqual([
      { type: 'tool_use', id: 'call_weather', name: 'get_weather', input: { location: 'NYC' } },
    ]);
    expect(result.stop_reason).toBe('tool_use');
  });

  test('converts response with both text and tool_calls', () => {
    const result = translateResponse(
      {
        choices: [
          {
            message: {
              content: 'Let me check...',
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'search', arguments: '{"q":"weather"}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: {},
      },
      'test',
    );

    expect(result.content).toHaveLength(2);
    expect(result.content[0]).toEqual({ type: 'text', text: 'Let me check...' });
    expect(result.content[1].type).toBe('tool_use');
    expect(result.content[1].name).toBe('search');
  });

  test('handles malformed JSON in tool_call arguments gracefully', () => {
    const result = translateResponse(
      {
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'bad_json', arguments: 'not-valid-json' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: {},
      },
      'test',
    );

    expect(result.content[0].input).toEqual({});
  });

  // -- Finish reason mappings -----------------------------------------------

  test('maps finish_reason stop to end_turn', () => {
    const r = translateResponse(
      {
        choices: [{ message: { content: 'x' }, finish_reason: 'stop' }],
        usage: {},
      },
      't',
    );
    expect(r.stop_reason).toBe('end_turn');
  });

  test('maps finish_reason tool_calls to tool_use', () => {
    const r = translateResponse(
      {
        choices: [{ message: { content: '' }, finish_reason: 'tool_calls' }],
        usage: {},
      },
      't',
    );
    expect(r.stop_reason).toBe('tool_use');
  });

  test('maps finish_reason length to max_tokens', () => {
    const r = translateResponse(
      {
        choices: [{ message: { content: 'x' }, finish_reason: 'length' }],
        usage: {},
      },
      't',
    );
    expect(r.stop_reason).toBe('max_tokens');
  });

  test('maps finish_reason content_filter to content_filter', () => {
    const r = translateResponse(
      {
        choices: [{ message: { content: 'x' }, finish_reason: 'content_filter' }],
        usage: {},
      },
      't',
    );
    expect(r.stop_reason).toBe('content_filter');
  });

  test('defaults unknown finish_reason to end_turn', () => {
    const r = translateResponse(
      {
        choices: [{ message: { content: 'x' }, finish_reason: null }],
        usage: {},
      },
      't',
    );
    expect(r.stop_reason).toBe('end_turn');
  });

  // -- Usage ----------------------------------------------------------------

  test('defaults missing usage fields to zero', () => {
    const r = translateResponse(
      {
        choices: [{ message: { content: 'Hi' }, finish_reason: 'stop' }],
        usage: {},
      },
      'test',
    );
    expect(r.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
  });

  test('defaults usage to zeros when usage is absent', () => {
    const r = translateResponse(
      {
        choices: [{ message: { content: 'Hi' }, finish_reason: 'stop' }],
      },
      'test',
    );
    expect(r.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
  });

  // -- Edge cases -----------------------------------------------------------

  test('handles empty choices array', () => {
    const r = translateResponse(
      {
        choices: [],
        usage: {},
      },
      'test',
    );
    expect(r.content).toEqual([]);
    expect(r.stop_reason).toBe('end_turn');
  });

  test('handles undefined choices', () => {
    const r = translateResponse({}, 'test');
    expect(r.content).toEqual([]);
    expect(r.stop_reason).toBe('end_turn');
  });

  test('generates fallback id when no id provided', () => {
    const r = translateResponse(
      {
        choices: [{ message: { content: 'Hi' }, finish_reason: 'stop' }],
        usage: {},
      },
      'test',
    );
    expect(r.id).toMatch(/^msg_/);
    expect(r.id.length).toBeGreaterThan(4);
  });

  test('preserves provided id', () => {
    const r = translateResponse(
      {
        id: 'preserved-id',
        choices: [{ message: { content: 'Hi' }, finish_reason: 'stop' }],
        usage: {},
      },
      'test',
    );
    expect(r.id).toBe('preserved-id');
  });
});

// ===========================================================================
// createStreamTransformer
// ===========================================================================

describe('createStreamTransformer', () => {
  // -- Basic text streaming -------------------------------------------------

  test('produces correct events for a single text chunk with finish_reason', async () => {
    const output = await collectStream([
      sse({ choices: [{ delta: { content: 'Hello' }, finish_reason: 'stop' }] }),
    ]);
    const events = parseSSE(output);

    expect(events).toHaveLength(6);

    expect(events[0].event).toBe('message_start');
    expect(events[0].data.type).toBe('message_start');
    expect(events[0].data.message.role).toBe('assistant');
    expect(events[0].data.message.model).toBe('claude-model');

    expect(events[1].event).toBe('content_block_start');
    expect(events[1].data.content_block.type).toBe('text');

    expect(events[2].event).toBe('content_block_delta');
    expect(events[2].data.delta.type).toBe('text_delta');
    expect(events[2].data.delta.text).toBe('Hello');

    expect(events[3].event).toBe('content_block_stop');

    expect(events[4].event).toBe('message_delta');
    expect(events[4].data.delta.stop_reason).toBe('end_turn');

    expect(events[5].event).toBe('message_stop');
  });

  test('accumulates multiple text chunks across stream events', async () => {
    const output = await collectStream([
      sse({ choices: [{ delta: { content: 'Hello' } }] }),
      sse({ choices: [{ delta: { content: ' world' } }] }),
      sse({ choices: [{ delta: { content: '!' }, finish_reason: 'stop' }] }),
    ]);
    const events = parseSSE(output);

    expect(events).toHaveLength(8);

    expect(events[0].event).toBe('message_start');
    expect(events[1].event).toBe('content_block_start');
    expect(events[2].event).toBe('content_block_delta');
    expect(events[2].data.delta.text).toBe('Hello');
    expect(events[3].event).toBe('content_block_delta');
    expect(events[3].data.delta.text).toBe(' world');
    expect(events[4].event).toBe('content_block_delta');
    expect(events[4].data.delta.text).toBe('!');
    expect(events[5].event).toBe('content_block_stop');
    expect(events[6].event).toBe('message_delta');
    expect(events[7].event).toBe('message_stop');
  });

  test('message_start is emitted only once', async () => {
    const output = await collectStream([
      sse({ choices: [{ delta: { content: 'A' } }] }),
      sse({ choices: [{ delta: { content: 'B' } }] }),
      sse({ choices: [{ delta: { content: 'C' }, finish_reason: 'stop' }] }),
    ]);
    const events = parseSSE(output);
    const starts = events.filter((e) => e.event === 'message_start');
    expect(starts).toHaveLength(1);
  });

  // -- Reasoning (thinking) content -----------------------------------------

  test('produces thinking blocks for reasoning_content', async () => {
    const output = await collectStream([
      sse({
        choices: [{ delta: { reasoning_content: 'Let me think...' }, finish_reason: 'stop' }],
      }),
    ]);
    const events = parseSSE(output);

    expect(events).toHaveLength(7);
    expect(events[1].data.content_block.type).toBe('thinking');
    expect(events[1].data.content_block.thinking).toBe('');
    expect(events[1].data.content_block.signature).toBe('');
    expect(events[2].event).toBe('content_block_delta');
    expect(events[2].data.delta.type).toBe('thinking_delta');
    expect(events[2].data.delta.thinking).toBe('Let me think...');
    // signature_delta at events[3], content_block_stop at events[4]
    expect(events[3].data.delta.type).toBe('signature_delta');
  });

  test('produces correct events for reasoning then text in the same chunk', async () => {
    const output = await collectStream([
      sse({
        choices: [
          {
            delta: { reasoning_content: 'think...', content: 'answer' },
            finish_reason: 'stop',
          },
        ],
      }),
    ]);
    const events = parseSSE(output);

    expect(events).toHaveLength(10);

    expect(events[1].data.content_block.type).toBe('thinking');
    expect(events[2].data.delta.thinking).toBe('think...');
    // signature_delta at events[3]
    expect(events[3].data.delta.type).toBe('signature_delta');
    expect(events[4].event).toBe('content_block_stop');

    expect(events[5].data.content_block.type).toBe('text');
    expect(events[6].data.delta.text).toBe('answer');
    expect(events[7].event).toBe('content_block_stop');

    expect(events[8].data.delta.stop_reason).toBe('end_turn');
  });

  test('produces correct events for reasoning then text in separate chunks', async () => {
    const output = await collectStream([
      sse({ choices: [{ delta: { reasoning_content: 'think...' } }] }),
      sse({ choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }] }),
    ]);
    const events = parseSSE(output);

    expect(events).toHaveLength(10);

    expect(events[0].event).toBe('message_start');
    expect(events[1].data.content_block.type).toBe('thinking');
    expect(events[2].data.delta.thinking).toBe('think...');

    // signature_delta at events[3]
    expect(events[3].data.delta.type).toBe('signature_delta');
    expect(events[4].event).toBe('content_block_stop');
    expect(events[5].data.content_block.type).toBe('text');
    expect(events[6].data.delta.text).toBe('answer');
    expect(events[7].event).toBe('content_block_stop');
    expect(events[8].event).toBe('message_delta');
    expect(events[9].event).toBe('message_stop');
  });

  // -- Tool call streaming --------------------------------------------------

  test('handles tool call with name and arguments in separate deltas', async () => {
    const output = await collectStream([
      sse({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'call_1', function: { name: 'get_weather', arguments: '' } },
              ],
            },
          },
        ],
      }),
      sse({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { arguments: '{"loc":"NYC"}' } }],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }),
    ]);
    const events = parseSSE(output);

    expect(events).toHaveLength(6);

    expect(events[1].event).toBe('content_block_start');
    expect(events[1].data.content_block.type).toBe('tool_use');
    expect(events[1].data.content_block.name).toBe('get_weather');

    expect(events[2].event).toBe('content_block_delta');
    expect(events[2].data.delta.type).toBe('input_json_delta');
    expect(events[2].data.delta.partial_json).toBe('{"loc":"NYC"}');

    expect(events[3].event).toBe('content_block_stop');
    expect(events[4].data.delta.stop_reason).toBe('tool_use');
  });

  test('handles multiple tool calls in one chunk', async () => {
    const output = await collectStream([
      sse({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_a',
                  function: { name: 'get_weather', arguments: '{"city":"NYC"}' },
                },
                {
                  index: 1,
                  id: 'call_b',
                  function: { name: 'get_time', arguments: '{"tz":"EST"}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }),
    ]);
    const events = parseSSE(output);

    expect(events).toHaveLength(9);

    expect(events[1].data.content_block.name).toBe('get_weather');
    expect(events[2].data.delta.partial_json).toBe('{"city":"NYC"}');

    expect(events[3].event).toBe('content_block_stop');

    expect(events[4].data.content_block.name).toBe('get_time');
    expect(events[5].data.delta.partial_json).toBe('{"tz":"EST"}');

    expect(events[6].event).toBe('content_block_stop');
  });

  // -- [DONE] signal --------------------------------------------------------

  test('handles [DONE] after content stream', async () => {
    const output = await collectStream([
      sse({ choices: [{ delta: { content: 'Hello' } }] }),
      'data: [DONE]\n\n',
    ]);
    const events = parseSSE(output);

    expect(events).toHaveLength(6);
    expect(events[0].event).toBe('message_start');
    expect(events[1].data.content_block.type).toBe('text');
    expect(events[2].data.delta.text).toBe('Hello');
    expect(events[3].event).toBe('content_block_stop');
    expect(events[4].event).toBe('message_delta');
    expect(events[4].data.delta.stop_reason).toBe('end_turn');
    expect(events[5].event).toBe('message_stop');
  });

  test('handles [DONE] with no prior content', async () => {
    const output = await collectStream(['data: [DONE]\n\n']);
    const events = parseSSE(output);

    expect(events).toHaveLength(3);
    expect(events[0].event).toBe('message_start');
    expect(events[1].event).toBe('message_delta');
    expect(events[1].data.delta.stop_reason).toBe('end_turn');
    expect(events[2].event).toBe('message_stop');
  });

  test('ignores data after stream is finished', async () => {
    const output = await collectStream([
      sse({ choices: [{ delta: { content: 'Hi' }, finish_reason: 'stop' }] }),
      sse({ choices: [{ delta: { content: 'IGNORED' } }] }),
    ]);
    const events = parseSSE(output);

    const deltas = events.filter((e) => e.event === 'content_block_delta');
    expect(deltas).toHaveLength(1);
    expect(deltas[0].data.delta.text).toBe('Hi');
  });

  // -- Usage in mid-stream --------------------------------------------------

  test('captures usage from mid-stream chunk and includes in message_delta', async () => {
    const output = await collectStream([
      sse({
        choices: [{ delta: { content: 'Hello' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
      sse({ choices: [{ delta: { content: ' world' }, finish_reason: 'stop' }] }),
    ]);
    const events = parseSSE(output);

    const msgDelta = events.find((e) => e.event === 'message_delta');
    expect(msgDelta!.data.usage).toEqual({ output_tokens: 5 });
  });

  test('handles partial usage info (missing fields default to 0)', async () => {
    const output = await collectStream([
      sse({
        choices: [{ delta: { content: 'Hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 7 },
      }),
    ]);
    const events = parseSSE(output);
    const msgDelta = events.find((e) => e.event === 'message_delta');
    // message_delta only includes output_tokens per Anthropic spec
    expect(msgDelta!.data.usage.input_tokens).toBeUndefined();
    expect(msgDelta!.data.usage.output_tokens).toBe(0);
  });

  // -- Recovering from bad input --------------------------------------------

  test('skips invalid JSON silently', async () => {
    const output = await collectStream([
      'data: not-valid-json\n\n',
      sse({ choices: [{ delta: { content: 'Hi' }, finish_reason: 'stop' }] }),
    ]);
    const events = parseSSE(output);
    expect(events).toHaveLength(6);
    expect(events[0].event).toBe('message_start');
  });

  test('skips chunks with no choices array', async () => {
    const output = await collectStream([
      sse({ foo: 'bar' }),
      sse({ choices: [{ delta: { content: 'Hi' }, finish_reason: 'stop' }] }),
    ]);
    const events = parseSSE(output);
    expect(events).toHaveLength(6);
  });

  test('skips chunks with empty choices array', async () => {
    const output = await collectStream([
      sse({ choices: [] }),
      sse({ choices: [{ delta: { content: 'Hi' }, finish_reason: 'stop' }] }),
    ]);
    const events = parseSSE(output);
    expect(events).toHaveLength(6);
  });

  test('skips chunks with no data: prefix line', async () => {
    const output = await collectStream([
      'event: ping\n\n',
      sse({ choices: [{ delta: { content: 'Hi' }, finish_reason: 'stop' }] }),
    ]);
    const events = parseSSE(output);
    expect(events).toHaveLength(6);
  });

  // -- Buffer management ----------------------------------------------------

  test('handles buffer splitting across chunk boundaries', async () => {
    const transformer = createStreamTransformer('test');
    let output = '';
    const promise = new Promise((resolve: (v: string) => void) => {
      transformer.on('data', (chunk: string) => {
        output += chunk.toString();
      });
      transformer.on('end', () => resolve(output));
    });

    transformer.write('data: {"choices":[{"delta":{"conten');
    transformer.write('t":"Hello"},"finish_reason":"stop"}]}\n\n');
    transformer.end();

    const result = await promise;
    const events = parseSSE(result);
    expect(events).toHaveLength(6);
    expect(events[2].data.delta.text).toBe('Hello');
  });

  test('flush processes remaining buffered data', async () => {
    const transformer = createStreamTransformer('test');
    let output = '';
    const promise = new Promise((resolve: (v: string) => void) => {
      transformer.on('data', (chunk: string) => {
        output += chunk.toString();
      });
      transformer.on('end', () => resolve(output));
    });

    transformer.write('data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":"stop"}]}');
    transformer.end();

    const result = await promise;
    const events = parseSSE(result);
    expect(events).toHaveLength(6);
    expect(events[2].data.delta.text).toBe('Hi');
  });

  test('flush gracefully finishes unclosed stream', async () => {
    const transformer = createStreamTransformer('test');
    let output = '';
    const promise = new Promise((resolve: (v: string) => void) => {
      transformer.on('data', (chunk: string) => {
        output += chunk.toString();
      });
      transformer.on('end', () => resolve(output));
    });

    transformer.write('data: {"choices":[{"delta":{"content":"Incomplete"}}]}\n\n');
    transformer.end();

    const result = await promise;
    const events = parseSSE(result);
    expect(events).toHaveLength(6);
    expect(events[4].data.delta.stop_reason).toBe('end_turn');
  });

  // -- Buffer overflow ------------------------------------------------------

  test('destroys stream on buffer overflow', (done) => {
    const transformer = createStreamTransformer('test');
    transformer.on('error', (err: Error) => {
      expect(err.message).toBe('SSE buffer exceeded 1MB');
      done();
    });
    transformer.write(Buffer.alloc(1_048_577, 'x').toString());
  });

  // -- Message structure ----------------------------------------------------

  test('message_start contains correct message shape', async () => {
    const output = await collectStream(
      [sse({ choices: [{ delta: { content: 'Hello' }, finish_reason: 'stop' }] })],
      'opus-4',
    );
    const events = parseSSE(output);
    const msg = events[0].data.message as Record<string, unknown>;

    expect(msg.type).toBe('message');
    expect(msg.role).toBe('assistant');
    expect(msg.model).toBe('opus-4');
    expect(msg.content).toEqual([]);
    expect(msg.stop_reason).toBeNull();
    expect(msg.stop_sequence).toBeNull();
    expect(msg.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
    expect(msg.id).toBeDefined();
    expect(msg.id).toMatch(/^msg_/);
  });

  // -- Error propagation -------------------------------------------------------

  test('upstream error event produces message_stop', () => {
    const transformer = createStreamTransformer('sonnet');
    const events: Array<{ event?: string; data: unknown }> = [];
    transformer.on('data', (chunk: string | Buffer) => {
      const str = chunk.toString();
      const sseEvents = str.split('\n\n').filter(Boolean);
      for (const evt of sseEvents) {
        const lines = evt.split('\n');
        const ev: { event?: string; data: unknown } = {};
        for (const line of lines) {
          if (line.startsWith('event: ')) ev.event = line.slice(7);
          if (line.startsWith('data: ')) {
            try {
              ev.data = JSON.parse(line.slice(6));
            } catch (_) {
              ev.data = line.slice(6);
            }
          }
        }
        if (ev.data !== undefined) events.push(ev);
      }
    });
    transformer.write('data: {"error":{"type":"api_error","message":"content filter"}}\n\n');
    transformer.end();
    const hasError = events.some((e) => e.event === 'error');
    const hasStop = events.some(
      (e) =>
        e.data &&
        typeof e.data === 'object' &&
        (e.data as Record<string, unknown>).type === 'message_stop',
    );
    expect(hasError).toBe(true);
    expect(hasStop).toBe(true);
  });
});

describe('document content block translation', () => {
  const { translateRequest } = require('../protocol-translate');

  test('document block with base64 source produces data URI and annotation', () => {
    const body = {
      model: 'sonnet:ds:deepseek-v4-pro',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Analyze this PDF' },
            {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0xLjQK' },
            },
          ],
        },
      ],
      max_tokens: 100,
    };
    const result = translateRequest(body);
    const lastMsg = result.openaiBody.messages[result.openaiBody.messages.length - 1];
    const content = (lastMsg as any).content as Array<Record<string, unknown>>;
    const imageUrls = content.filter((c) => c.type === 'image_url');
    expect(imageUrls.length).toBe(1);
    expect((imageUrls[0] as any).image_url.url).toContain('data:application/pdf;base64,');
    const annotations = content.filter(
      (c) => c.type === 'text' && (c as any).text?.includes('[Attached document:'),
    );
    expect(annotations.length).toBe(1);
  });

  test('document block with URL source includes actual URL', () => {
    const body = {
      model: 'sonnet:ds:deepseek-v4-pro',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Check this file' },
            {
              type: 'document',
              source: {
                type: 'url',
                url: 'https://example.com/report.pdf',
                media_type: 'application/pdf',
              },
            },
          ],
        },
      ],
      max_tokens: 100,
    };
    const result = translateRequest(body);
    const lastMsg = result.openaiBody.messages[result.openaiBody.messages.length - 1];
    const content = (lastMsg as any).content as Array<Record<string, unknown>>;
    const imageUrls = content.filter((c) => c.type === 'image_url');
    expect(imageUrls.length).toBe(1);
    expect((imageUrls[0] as any).image_url.url).toBe('https://example.com/report.pdf');
  });
});

// ===========================================================================
// createAnthropicStreamInterceptor — server_tool_use injection
// ===========================================================================

// Helper: build Anthropic-format SSE chunks for realistic streaming.
function makeAnthroSSE(opts: {
  tools?: Array<{ name: string; id?: string }>;
  outputTokens?: number;
  stopReason?: string;
  withThinking?: boolean;
}): string {
  const chunks: string[] = [];
  chunks.push(
    `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_test","type":"message","role":"assistant","content":[],"model":"claude-haiku-4-5-20251001","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":0}}}\n\n`,
  );

  if (opts.withThinking) {
    chunks.push(
      `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}\n\n`,
    );
    chunks.push(
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Hmm..."}}\n\n`,
    );
    chunks.push(`event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n`);
  }

  if (opts.tools) {
    for (let i = 0; i < opts.tools.length; i++) {
      const t = opts.tools[i];
      const idx = opts.withThinking ? i + 1 : i;
      chunks.push(
        `event: content_block_start\ndata: {"type":"content_block_start","index":${idx},"content_block":{"type":"tool_use","id":"${t.id || 'tool_' + i}","name":"${t.name}","input":{}}}\n\n`,
      );
      chunks.push(
        `event: content_block_delta\ndata: {"type":"content_block_delta","index":${idx},"delta":{"type":"input_json_delta","partial_json":"{\\"query\\":\\"hello\\"}"}}\n\n`,
      );
      chunks.push(
        `event: content_block_stop\ndata: {"type":"content_block_stop","index":${idx}}\n\n`,
      );
    }
  }

  chunks.push(
    `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"${opts.stopReason || 'end_turn'}"},"usage":{"output_tokens":${opts.outputTokens || 50}}}\n\n`,
  );
  chunks.push(`event: message_stop\ndata: {"type":"message_stop"}\n\n`);
  return chunks.join('');
}

function collectAnthroStream(
  input: string,
): Promise<{ output: string; events: Array<{ event: string; data: Record<string, unknown> }> }> {
  return new Promise((resolve, reject) => {
    const transformer = createAnthropicStreamInterceptor();
    let output = '';
    transformer.on('data', (chunk: string) => {
      output += chunk.toString();
    });
    transformer.on('end', () => {
      const events = parseSSE(output);
      resolve({ output, events });
    });
    transformer.on('error', reject);
    transformer.write(input);
    transformer.end();
  });
}

function findLastIndex<T>(arr: T[], fn: (el: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (fn(arr[i])) return i;
  }
  return -1;
}

describe('createAnthropicStreamInterceptor server_tool_use', () => {
  test('injects web_search count into message_delta.usage', async () => {
    const input = makeAnthroSSE({ tools: [{ name: 'web_search' }] });
    const { events } = await collectAnthroStream(input);

    const deltaEvent = events.find((e) => e.event === 'message_delta');
    expect(deltaEvent).toBeDefined();
    const usage = (deltaEvent!.data as any).usage;
    expect(usage.server_tool_use).toBeDefined();
    expect(usage.server_tool_use.web_search_requests).toBe(1);
    expect(usage.server_tool_use.web_fetch_requests).toBe(0);
  });

  test('injects web_fetch count into message_delta.usage', async () => {
    const input = makeAnthroSSE({ tools: [{ name: 'web_fetch' }] });
    const { events } = await collectAnthroStream(input);

    const deltaEvent = events.find((e) => e.event === 'message_delta');
    const usage = (deltaEvent!.data as any).usage;
    expect(usage.server_tool_use.web_search_requests).toBe(0);
    expect(usage.server_tool_use.web_fetch_requests).toBe(1);
  });

  test('counts mixed web_search + web_fetch correctly', async () => {
    const input = makeAnthroSSE({
      tools: [{ name: 'web_search' }, { name: 'web_search' }, { name: 'web_fetch' }],
      outputTokens: 120,
    });
    const { events } = await collectAnthroStream(input);

    const deltaEvent = events.find((e) => e.event === 'message_delta');
    const usage = (deltaEvent!.data as any).usage;
    expect(usage.server_tool_use.web_search_requests).toBe(2);
    expect(usage.server_tool_use.web_fetch_requests).toBe(1);
    expect(usage.output_tokens).toBe(120);
  });

  test('does NOT inject server_tool_use when no web tools are used', async () => {
    const input = makeAnthroSSE({ tools: [{ name: 'bash' }, { name: 'read' }] });
    const { events } = await collectAnthroStream(input);

    const deltaEvent = events.find((e) => e.event === 'message_delta');
    expect(deltaEvent).toBeDefined();
    const usage = (deltaEvent!.data as any).usage;
    expect(usage.server_tool_use).toBeUndefined();
  });

  test('preserves existing usage fields alongside server_tool_use', async () => {
    const input = makeAnthroSSE({ tools: [{ name: 'web_search' }], outputTokens: 75 });
    const { events } = await collectAnthroStream(input);

    // message_start usage is unaffected
    const startEvent = events.find((e) => e.event === 'message_start');
    const startMsg = (startEvent!.data as any).message;
    expect(startMsg.usage.output_tokens).toBe(0);
    expect(startMsg.usage.input_tokens).toBe(10);

    // message_delta has server_tool_use + output_tokens
    const deltaEvent = events.find((e) => e.event === 'message_delta');
    const usage = (deltaEvent!.data as any).usage;
    expect(usage.output_tokens).toBe(75);
    expect(usage.server_tool_use.web_search_requests).toBe(1);
  });

  test('handles stream with thinking blocks before tool_use', async () => {
    const input = makeAnthroSSE({
      tools: [{ name: 'web_search' }],
      withThinking: true,
    });
    const { events } = await collectAnthroStream(input);

    const deltaEvent = events.find((e) => e.event === 'message_delta');
    expect(deltaEvent).toBeDefined();
    const usage = (deltaEvent!.data as any).usage;
    expect(usage.server_tool_use.web_search_requests).toBe(1);

    const thinkingStart = events.find((e) => e.event === 'content_block_start');
    expect(thinkingStart).toBeDefined();
    const cb = (thinkingStart!.data as any).content_block;
    expect(cb.type).toBe('thinking');
  });

  test('text-only stream (no tools) passes through unchanged structure', async () => {
    const chunks = [
      `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":5,"output_tokens":0}}}\n\n`,
      `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`,
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello world"}}\n\n`,
      `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n`,
      `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n`,
      `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
    ];
    const { events } = await collectAnthroStream(chunks.join(''));

    const deltaEvent = events.find((e) => e.event === 'message_delta');
    const usage = (deltaEvent!.data as any).usage;
    expect(usage.output_tokens).toBe(3);
    expect(usage.server_tool_use).toBeUndefined();
  });

  test('ordering: message_delta comes before message_stop', async () => {
    const input = makeAnthroSSE({ tools: [{ name: 'web_search' }] });
    const { events } = await collectAnthroStream(input);

    const deltaIdx = events.findIndex((e) => e.event === 'message_delta');
    const stopIdx = events.findIndex((e) => e.data.type === 'message_stop');
    expect(deltaIdx).toBeGreaterThan(-1);
    expect(stopIdx).toBeGreaterThan(-1);
    expect(deltaIdx).toBeLessThan(stopIdx);
  });

  test('tool_use blocks are emitted before message_delta', async () => {
    const input = makeAnthroSSE({ tools: [{ name: 'web_search' }] });
    const { events } = await collectAnthroStream(input);

    const lastBlockStopIdx = findLastIndex(events, (e) => e.event === 'content_block_stop');
    const deltaIdx = events.findIndex((e) => e.event === 'message_delta');
    expect(lastBlockStopIdx).toBeGreaterThan(-1);
    expect(deltaIdx).toBeGreaterThan(lastBlockStopIdx);
  });

  test('preExecutedSearches seed is honored', async () => {
    const input = makeAnthroSSE({ tools: [{ name: 'web_search' }] });
    const { events } = await new Promise<{
      events: Array<{ event: string; data: Record<string, unknown> }>;
    }>((resolve, reject) => {
      const transformer = createAnthropicStreamInterceptor(5);
      let output = '';
      transformer.on('data', (chunk: string) => {
        output += chunk.toString();
      });
      transformer.on('end', () => resolve({ events: parseSSE(output) }));
      transformer.on('error', reject);
      transformer.write(input);
      transformer.end();
    });

    const deltaEvent = events.find((e) => e.event === 'message_delta');
    const usage = (deltaEvent!.data as any).usage;
    expect(usage.server_tool_use.web_search_requests).toBe(6); // 5 seed + 1 from stream
  });

  test('preserves upstream server_tool_use when already present (does not overwrite)', async () => {
    // Simulate a real Anthropic response where server_tool_use is already
    // in message_delta. The interceptor must not overwrite it with its
    // own SSE-parsed count, even if they differ (Anthropic is authoritative).
    const chunks = [
      `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":5,"output_tokens":0}}}\n\n`,
      `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tool_ws_0","name":"web_search","input":{}}}\n\n`,
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"query\\":\\"test\\"}"}}\n\n`,
      `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n`,
      // Anthropic provides 3 web_search_requests natively. Interceptor
      // only counted 1 — must NOT overwrite with 1.
      `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":30,"server_tool_use":{"web_search_requests":3,"web_fetch_requests":0}}}\n\n`,
      `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
    ];
    const { events } = await collectAnthroStream(chunks.join(''));

    const deltaEvent = events.find((e) => e.event === 'message_delta');
    const usage = (deltaEvent!.data as any).usage;
    // Must preserve Anthropic's count (3), not the interceptor's count (1)
    expect(usage.server_tool_use.web_search_requests).toBe(3);
    expect(usage.server_tool_use.web_fetch_requests).toBe(0);
    expect(usage.output_tokens).toBe(30);
  });
});
