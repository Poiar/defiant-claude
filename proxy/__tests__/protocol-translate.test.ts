'use strict';

import { translateRequest, translateResponse, createStreamTransformer } from '../protocol-translate';

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
    transformer.on('data', (chunk: string) => { output += chunk.toString(); });
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
    expect(openaiBody.messages).toEqual([
      { role: 'user', content: 'Hello world' },
    ]);
  });

  test('converts user message with text-only array content', () => {
    const { openaiBody } = translateRequest({
      model: 'claude-sonnet-4',
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: 'Hello' }, { type: 'text', text: ' world' }],
      }],
    });
    expect(openaiBody.messages).toEqual([
      { role: 'user', content: 'Hello\n world' },
    ]);
  });

  test('converts user message with tool_result blocks to tool role', () => {
    const { openaiBody } = translateRequest({
      model: 'claude-sonnet-4',
      messages: [{
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu_abc', content: '42' },
          { type: 'tool_result', tool_use_id: 'tu_def', content: 'blue' },
        ],
      }],
    });
    expect(openaiBody.messages).toEqual([
      { role: 'tool', tool_call_id: 'tu_abc', content: '42' },
      { role: 'tool', tool_call_id: 'tu_def', content: 'blue' },
    ]);
  });

  test('converts user message with text and tool_result together', () => {
    const { openaiBody } = translateRequest({
      model: 'claude-sonnet-4',
      messages: [{
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu_1', content: 'result data' },
          { type: 'text', text: 'Thanks!' },
        ],
      }],
    });
    expect(openaiBody.messages).toEqual([
      { role: 'tool', tool_call_id: 'tu_1', content: 'result data' },
      { role: 'user', content: 'Thanks!' },
    ]);
  });

  test('converts tool_result with array content using stringifyContent', () => {
    const { openaiBody } = translateRequest({
      model: 'claude-sonnet-4',
      messages: [{
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'tu_1',
          content: [
            { type: 'text', text: 'Temperature is ' },
            { type: 'text', text: '72F' },
          ],
        }],
      }],
    });
    expect(openaiBody.messages[0].content).toBe('Temperature is \n72F');
  });

  test('converts user message with image blocks', () => {
    const { openaiBody } = translateRequest({
      model: 'claude-sonnet-4',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'What is this?' },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'abc123' },
          },
        ],
      }],
    });
    expect(openaiBody.messages[0].content).toEqual([
      { type: 'text', text: 'What is this?' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,abc123' } },
    ]);
  });

  test('converts user message with only image and no text', () => {
    const { openaiBody } = translateRequest({
      model: 'claude-sonnet-4',
      messages: [{
        role: 'user',
        content: [{
          type: 'image',
          source: { type: 'base64', media_type: 'image/jpeg', data: 'xyz' },
        }],
      }],
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
      messages: [{
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me look that up.' },
          { type: 'tool_use', id: 'tu_1', name: 'get_weather', input: { location: 'NYC' } },
        ],
      }],
    });
    const msg = openaiBody.messages[0];
    expect(msg.role).toBe('assistant');
    expect(msg.content).toBe('Let me look that up.');
    expect(msg.tool_calls).toEqual([{
      id: 'tu_1',
      type: 'function',
      function: { name: 'get_weather', arguments: '{"location":"NYC"}' },
    }]);
  });

  test('converts assistant message with only tool_use (no text)', () => {
    const { openaiBody } = translateRequest({
      model: 'claude-sonnet-4',
      messages: [{
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu_x', name: 'search', input: { query: 'test' } },
        ],
      }],
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
      tools: [{
        name: 'get_weather',
        description: 'Get the weather for a location',
        input_schema: {
          type: 'object',
          properties: { loc: { type: 'string' } },
          required: ['loc'],
        },
      }],
    });
    expect(openaiBody.tools).toEqual([{
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
    }]);
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
});

// ===========================================================================
// translateResponse
// ===========================================================================

describe('translateResponse', () => {
  // -- Basic response -------------------------------------------------------

  test('converts a basic text response', () => {
    const result = translateResponse({
      id: 'chatcmpl-abc123',
      choices: [{
        message: { content: 'Hello there!' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 15, completion_tokens: 25 },
    }, 'claude-sonnet-4');

    expect(result.id).toBe('chatcmpl-abc123');
    expect(result.type).toBe('message');
    expect(result.model).toBe('claude-sonnet-4');
    expect(result.role).toBe('assistant');
    expect(result.content).toEqual([
      { type: 'text', text: 'Hello there!' },
    ]);
    expect(result.stop_reason).toBe('end_turn');
    expect(result.stop_sequence).toBeNull();
    expect(result.usage).toEqual({ input_tokens: 15, output_tokens: 25 });
  });

  test('converts response with no content field', () => {
    const result = translateResponse({
      choices: [{ message: {}, finish_reason: 'stop' }],
      usage: {},
    }, 'test');
    expect(result.content).toEqual([]);
  });

  // -- Tool calls -----------------------------------------------------------

  test('converts response with tool_calls', () => {
    const result = translateResponse({
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            id: 'call_weather',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"location":"NYC"}' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 10, completion_tokens: 20 },
    }, 'claude-sonnet-4');

    expect(result.content).toEqual([
      { type: 'tool_use', id: 'call_weather', name: 'get_weather', input: { location: 'NYC' } },
    ]);
    expect(result.stop_reason).toBe('tool_use');
  });

  test('converts response with both text and tool_calls', () => {
    const result = translateResponse({
      choices: [{
        message: {
          content: 'Let me check...',
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'search', arguments: '{"q":"weather"}' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
      usage: {},
    }, 'test');

    expect(result.content).toHaveLength(2);
    expect(result.content[0]).toEqual({ type: 'text', text: 'Let me check...' });
    expect(result.content[1].type).toBe('tool_use');
    expect(result.content[1].name).toBe('search');
  });

  test('handles malformed JSON in tool_call arguments gracefully', () => {
    const result = translateResponse({
      choices: [{
        message: {
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'bad_json', arguments: 'not-valid-json' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
      usage: {},
    }, 'test');

    expect(result.content[0].input).toEqual({});
  });

  // -- Finish reason mappings -----------------------------------------------

  test('maps finish_reason stop to end_turn', () => {
    const r = translateResponse({
      choices: [{ message: { content: 'x' }, finish_reason: 'stop' }],
      usage: {},
    }, 't');
    expect(r.stop_reason).toBe('end_turn');
  });

  test('maps finish_reason tool_calls to tool_use', () => {
    const r = translateResponse({
      choices: [{ message: { content: '' }, finish_reason: 'tool_calls' }],
      usage: {},
    }, 't');
    expect(r.stop_reason).toBe('tool_use');
  });

  test('maps finish_reason length to max_tokens', () => {
    const r = translateResponse({
      choices: [{ message: { content: 'x' }, finish_reason: 'length' }],
      usage: {},
    }, 't');
    expect(r.stop_reason).toBe('max_tokens');
  });

  test('maps finish_reason content_filter to content_filter', () => {
    const r = translateResponse({
      choices: [{ message: { content: 'x' }, finish_reason: 'content_filter' }],
      usage: {},
    }, 't');
    expect(r.stop_reason).toBe('content_filter');
  });

  test('defaults unknown finish_reason to end_turn', () => {
    const r = translateResponse({
      choices: [{ message: { content: 'x' }, finish_reason: null }],
      usage: {},
    }, 't');
    expect(r.stop_reason).toBe('end_turn');
  });

  // -- Usage ----------------------------------------------------------------

  test('defaults missing usage fields to zero', () => {
    const r = translateResponse({
      choices: [{ message: { content: 'Hi' }, finish_reason: 'stop' }],
      usage: {},
    }, 'test');
    expect(r.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
  });

  test('defaults usage to zeros when usage is absent', () => {
    const r = translateResponse({
      choices: [{ message: { content: 'Hi' }, finish_reason: 'stop' }],
    }, 'test');
    expect(r.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
  });

  // -- Edge cases -----------------------------------------------------------

  test('handles empty choices array', () => {
    const r = translateResponse({
      choices: [],
      usage: {},
    }, 'test');
    expect(r.content).toEqual([]);
    expect(r.stop_reason).toBe('end_turn');
  });

  test('handles undefined choices', () => {
    const r = translateResponse({}, 'test');
    expect(r.content).toEqual([]);
    expect(r.stop_reason).toBe('end_turn');
  });

  test('generates fallback id when no id provided', () => {
    const r = translateResponse({
      choices: [{ message: { content: 'Hi' }, finish_reason: 'stop' }],
      usage: {},
    }, 'test');
    expect(r.id).toMatch(/^msg_/);
    expect(r.id.length).toBeGreaterThan(4);
  });

  test('preserves provided id', () => {
    const r = translateResponse({
      id: 'preserved-id',
      choices: [{ message: { content: 'Hi' }, finish_reason: 'stop' }],
      usage: {},
    }, 'test');
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
    const starts = events.filter(e => e.event === 'message_start');
    expect(starts).toHaveLength(1);
  });

  // -- Reasoning (thinking) content -----------------------------------------

  test('produces thinking blocks for reasoning_content', async () => {
    const output = await collectStream([
      sse({ choices: [{ delta: { reasoning_content: 'Let me think...' }, finish_reason: 'stop' }] }),
    ]);
    const events = parseSSE(output);

    expect(events).toHaveLength(6);
    expect(events[1].data.content_block.type).toBe('thinking');
    expect(events[1].data.content_block.thinking).toBe('');
    expect(events[2].event).toBe('content_block_delta');
    expect(events[2].data.delta.type).toBe('thinking_delta');
    expect(events[2].data.delta.thinking).toBe('Let me think...');
  });

  test('produces correct events for reasoning then text in the same chunk', async () => {
    const output = await collectStream([
      sse({
        choices: [{
          delta: { reasoning_content: 'think...', content: 'answer' },
          finish_reason: 'stop',
        }],
      }),
    ]);
    const events = parseSSE(output);

    expect(events).toHaveLength(9);

    expect(events[1].data.content_block.type).toBe('thinking');
    expect(events[2].data.delta.thinking).toBe('think...');
    expect(events[3].event).toBe('content_block_stop');

    expect(events[4].data.content_block.type).toBe('text');
    expect(events[5].data.delta.text).toBe('answer');
    expect(events[6].event).toBe('content_block_stop');

    expect(events[7].data.delta.stop_reason).toBe('end_turn');
  });

  test('produces correct events for reasoning then text in separate chunks', async () => {
    const output = await collectStream([
      sse({ choices: [{ delta: { reasoning_content: 'think...' } }] }),
      sse({ choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }] }),
    ]);
    const events = parseSSE(output);

    expect(events).toHaveLength(9);

    expect(events[0].event).toBe('message_start');
    expect(events[1].data.content_block.type).toBe('thinking');
    expect(events[2].data.delta.thinking).toBe('think...');

    expect(events[3].event).toBe('content_block_stop');
    expect(events[4].data.content_block.type).toBe('text');
    expect(events[5].data.delta.text).toBe('answer');
    expect(events[6].event).toBe('content_block_stop');
    expect(events[7].event).toBe('message_delta');
    expect(events[8].event).toBe('message_stop');
  });

  // -- Tool call streaming --------------------------------------------------

  test('handles tool call with name and arguments in separate deltas', async () => {
    const output = await collectStream([
      sse({
        choices: [{
          delta: {
            tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_weather', arguments: '' } }],
          },
        }],
      }),
      sse({
        choices: [{
          delta: {
            tool_calls: [{ index: 0, function: { arguments: '{"loc":"NYC"}' } }],
          },
          finish_reason: 'tool_calls',
        }],
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
        choices: [{
          delta: {
            tool_calls: [
              { index: 0, id: 'call_a', function: { name: 'get_weather', arguments: '{"city":"NYC"}' } },
              { index: 1, id: 'call_b', function: { name: 'get_time', arguments: '{"tz":"EST"}' } },
            ],
          },
          finish_reason: 'tool_calls',
        }],
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
    const output = await collectStream([
      'data: [DONE]\n\n',
    ]);
    const events = parseSSE(output);

    expect(events).toHaveLength(2);
    expect(events[0].event).toBe('message_delta');
    expect(events[0].data.delta.stop_reason).toBe('end_turn');
    expect(events[1].event).toBe('message_stop');
  });

  test('ignores data after stream is finished', async () => {
    const output = await collectStream([
      sse({ choices: [{ delta: { content: 'Hi' }, finish_reason: 'stop' }] }),
      sse({ choices: [{ delta: { content: 'IGNORED' } }] }),
    ]);
    const events = parseSSE(output);

    const deltas = events.filter(e => e.event === 'content_block_delta');
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

    const msgDelta = events.find(e => e.event === 'message_delta');
    expect(msgDelta!.data.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
  });

  test('handles partial usage info (missing fields default to 0)', async () => {
    const output = await collectStream([
      sse({
        choices: [{ delta: { content: 'Hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 7 },
      }),
    ]);
    const events = parseSSE(output);
    const msgDelta = events.find(e => e.event === 'message_delta');
    expect(msgDelta!.data.usage.input_tokens).toBe(7);
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
      transformer.on('data', (chunk: string) => { output += chunk.toString(); });
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
      transformer.on('data', (chunk: string) => { output += chunk.toString(); });
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
      transformer.on('data', (chunk: string) => { output += chunk.toString(); });
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
    const output = await collectStream([
      sse({ choices: [{ delta: { content: 'Hello' }, finish_reason: 'stop' }] }),
    ], 'opus-4');
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
});
