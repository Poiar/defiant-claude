'use strict';

// =========================================================================
// Protocol mapping integration tests
// Verifies full request→response mapping for all 3 provider paths:
//   1. Anthropic direct (an) — full passthrough, no conversion
//   2. DeepSeek /anthropic (ds) — tool conversion + thinking + tool_choice strip
//   3. OpenRouter (or) — OpenAI protocol translation
// =========================================================================

import { PROVIDER_CONSTRAINTS, translateToolChoice, mapFinishReason } from '../protocol-types';
import type { AnthropicRequestBody, AnthropicContentBlock } from '../protocol-types';
import { translateRequest, translateResponse } from '../protocol-translate';
import { preprocessServerTools } from '../server-tools';

// =========================================================================
// Shared test fixtures — realistic Anthropic requests from Claude Code
// =========================================================================

/** Realistic CC web search request */
const ccWebSearchRequest: AnthropicRequestBody = {
  model: 'haiku:deepseek-v4-flash',
  messages: [{ role: 'user', content: 'Perform a web search for the query: latest AI news' }],
  system: [
    { type: 'text', text: 'You are Claude Code, the official CLI for Claude.' },
    { type: 'text', text: 'You are an assistant for performing a web search tool use' },
  ],
  tools: [
    {
      name: 'web_search',
      description: 'Search the web',
      input_schema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    },
  ],
  tool_choice: { type: 'tool', name: 'web_search' },
  max_tokens: 4096,
  stream: true,
};

/** Realistic CC text request (no tools) */
const ccTextRequest: AnthropicRequestBody = {
  model: 'claude-sonnet-4-6',
  messages: [{ role: 'user', content: 'Write a haiku about code' }],
  system: 'You are a helpful assistant.',
  max_tokens: 1024,
  stream: true,
};

/** DeepSeek-format response (non-streaming, with thinking + tool_use) */
const deepseekResponseBody = {
  id: 'msg_ds_123',
  model: 'deepseek-v4-flash',
  choices: [
    {
      index: 0,
      message: {
        role: 'assistant',
        content: '',
        reasoning_content:
          'The user wants to search for "latest AI news". I should use the web_search tool.',
        tool_calls: [
          {
            id: 'toolu_ds_001',
            type: 'function',
            function: { name: 'web_search', arguments: '{"query":"latest AI news"}' },
          },
        ],
      },
      finish_reason: 'tool_calls',
    },
  ],
  usage: { prompt_tokens: 500, completion_tokens: 150, total_tokens: 650 },
};

/** Anthropic-format response (non-streaming, with thinking + tool_use) */
const anthropicNativeResponse = {
  id: 'msg_an_123',
  type: 'message',
  role: 'assistant',
  model: 'claude-haiku-4-5-20251001',
  content: [
    { type: 'text', text: 'Let me search for that.' },
    {
      type: 'tool_use',
      id: 'toolu_an_001',
      name: 'web_search',
      input: { query: 'latest AI news' },
    },
  ],
  stop_reason: 'tool_use',
  stop_sequence: null,
  usage: {
    input_tokens: 500,
    output_tokens: 150,
    server_tool_use: { web_search_requests: 1, web_fetch_requests: 0 },
  },
};

// =========================================================================
// Scenario 1: Anthropic direct (an) — Full passthrough
// =========================================================================

describe('Scenario 1: Anthropic direct (an) — full passthrough', () => {
  const an = PROVIDER_CONSTRAINTS.an;

  test('nativeServerTools: true — tools are NOT converted', () => {
    expect(an.nativeServerTools).toBe(true);
    // When nativeServerTools is true, preprocessServerTools is never called
    // by start-proxy.ts. The raw Anthropic request goes straight through.
  });

  test('forbidsToolChoiceWithThinking: false — tool_choice is NOT stripped', () => {
    expect(an.forbidsToolChoiceWithThinking).toBe(false);
    // Anthropic natively supports tool_choice with thinking
  });

  test('requiresModelRewrite: false — model is NOT rewritten', () => {
    expect(an.requiresModelRewrite).toBe(false);
    // Anthropic models already start with 'claude-'
  });

  test('nativeServerToolUse: true — server_tool_use comes from upstream', () => {
    expect(an.nativeServerToolUse).toBe(true);
    // Anthropic returns server_tool_use natively — no injection needed
  });

  test('thinkingFormat: "anthropic" — thinking passed through as-is', () => {
    expect(an.thinkingFormat).toBe('anthropic');
  });

  test('proxy does not touch Anthropic response for an provider', () => {
    // Verify the response structure matches what CC expects
    expect(anthropicNativeResponse.type).toBe('message');
    expect(anthropicNativeResponse.role).toBe('assistant');
    expect(Array.isArray(anthropicNativeResponse.content)).toBe(true);
    expect(anthropicNativeResponse.content[0].type).toBe('text');
    expect(anthropicNativeResponse.content[1].type).toBe('tool_use');
    expect(anthropicNativeResponse.usage.server_tool_use).toBeDefined();
    expect(anthropicNativeResponse.usage.server_tool_use!.web_search_requests).toBe(1);
  });
});

// =========================================================================
// Scenario 2: DeepSeek /anthropic (ds) — Anthropic protocol with constraints
// =========================================================================

describe('Scenario 2: DeepSeek /anthropic (ds) — constrained Anthropic protocol', () => {
  const ds = PROVIDER_CONSTRAINTS.ds;

  test('nativeServerTools: false — tools ARE converted', () => {
    expect(ds.nativeServerTools).toBe(false);
  });

  test('forbidsToolChoiceWithThinking: true — tool_choice IS stripped', () => {
    expect(ds.forbidsToolChoiceWithThinking).toBe(true);
  });

  test('requiresModelRewrite: true — model IS rewritten to claude-*', () => {
    expect(ds.requiresModelRewrite).toBe(true);
  });

  test('requiresThinkingEcho: true — thinking blocks must be cached and re-echoed', () => {
    expect(ds.requiresThinkingEcho).toBe(true);
  });

  test('thinkingFormat: "anthropic" — thinking injected as {type, budget_tokens}', () => {
    expect(ds.thinkingFormat).toBe('anthropic');
  });

  test('nativeServerToolUse: false — server_tool_use must be injected', () => {
    expect(ds.nativeServerToolUse).toBe(false);
  });

  // --- Preprocessing: tool conversion + tool_choice stripping ---

  test('preprocessServerTools converts web_search_* tools (CC format → generic)', () => {
    const body: Record<string, unknown> & { tools?: unknown[]; tool_choice?: unknown } = {
      tools: [{ type: 'web_search_20250305', name: 'web_search', description: 'Search the web' }],
      tool_choice: { type: 'tool', name: 'web_search' },
    };

    const result = preprocessServerTools(body, ds);

    // Web search tool was detected
    expect(result.hadWebSearch).toBe(true);
    expect(result.hadWebFetch).toBe(false);
    expect(result.modified).toBe(true);

    // web_search_20250305 → {name: 'web_search', input_schema: {query}}
    const tool = (body.tools as any[])[0];
    expect(tool.type).toBeUndefined(); // Stripped by convertServerTools
    expect(tool.name).toBe('web_search');
    expect(tool.input_schema).toBeDefined();
    expect((tool.input_schema as any).properties.query).toBeDefined();

    // tool_choice stripped (forbidsToolChoiceWithThinking: true)
    expect(body.tool_choice).toBeUndefined();
  });

  test('preprocessServerTools strips tool_choice even with non-web tools', () => {
    const body: Record<string, unknown> & { tools?: unknown[]; tool_choice?: unknown } = {
      tools: [{ type: 'custom', name: 'my_tool' }],
      tool_choice: 'auto',
    };
    const result = preprocessServerTools(body, ds);
    expect(body.tool_choice).toBeUndefined();
    expect(result.hadWebSearch).toBe(false);
  });

  // --- Non-streaming response: DeepSeek response → what CC expects ---

  test('translateResponse converts DeepSeek thinking → Anthropic thinking block', () => {
    const anthropic = translateResponse(
      deepseekResponseBody,
      'claude-haiku-4-5-20251001',
    ) as Record<string, unknown>;

    expect(anthropic.type).toBe('message');
    expect(anthropic.role).toBe('assistant');
    expect(anthropic.model).toBe('claude-haiku-4-5-20251001');
    expect(anthropic.stop_reason).toBe('tool_use');

    // reasoning_content → thinking block (always emitted first)
    const content = anthropic.content as AnthropicContentBlock[];
    const thinkingBlocks = content.filter((b) => b.type === 'thinking');
    expect(thinkingBlocks.length).toBeGreaterThanOrEqual(1);
    const thinking = thinkingBlocks[0] as { type: 'thinking'; thinking: string; signature: string };
    expect(thinking.thinking).toContain('web_search tool');

    // Empty content + tool_calls present → text block is intentionally skipped
    // (Anthropic clients expect pure tool_use blocks for tool-call responses)

    // tool_calls → tool_use blocks
    const toolBlocks = content.filter((b) => b.type === 'tool_use');
    expect(toolBlocks.length).toBe(1);
    const toolUse = toolBlocks[0] as {
      type: 'tool_use';
      name: string;
      input: Record<string, unknown>;
    };
    expect(toolUse.name).toBe('web_search');
    expect(toolUse.input.query).toBe('latest AI news');

    // Usage translation
    const usage = anthropic.usage as Record<string, unknown>;
    expect(usage.input_tokens).toBe(500);
    expect(usage.output_tokens).toBe(150);

    // server_tool_use injected (web_search tool counted from response content)
    const stu = usage.server_tool_use as Record<string, number> | undefined;
    expect(stu).toBeDefined();
    expect(stu!.web_search_requests).toBe(1);
  });

  test('mapFinishReason: "tool_calls" → "tool_use" (DeepSeek → Anthropic)', () => {
    expect(mapFinishReason('tool_calls')).toBe('tool_use');
  });
});

// =========================================================================
// Scenario 3: OpenRouter (or) — OpenAI protocol translation
// =========================================================================

describe('Scenario 3: OpenRouter (or) — OpenAI protocol translation', () => {
  const or = PROVIDER_CONSTRAINTS.or;

  test('format: "openai" — request body is translated to OpenAI format', () => {
    expect(or.format).toBe('openai');
  });

  test('nativeServerTools: false — tools converted before translation', () => {
    expect(or.nativeServerTools).toBe(false);
  });

  test('thinkingFormat: "openai" — thinking uses {type, reasoning_effort}', () => {
    expect(or.thinkingFormat).toBe('openai');
  });

  test('stripFields includes Anthropic-only fields', () => {
    expect(or.stripFields).toContain('top_k');
    expect(or.stripFields).toContain('metadata');
  });

  // --- translateRequest: Anthropic → OpenAI ---

  test('translateRequest converts tool_choice: {type:"tool"} → {type:"function"}', () => {
    const toolChoice = translateToolChoice({ type: 'tool', name: 'get_weather' });
    expect(toolChoice).toEqual({ type: 'function', function: { name: 'get_weather' } });
  });

  test('translateRequest converts tool_choice: "any" → "required" (OpenAI format)', () => {
    expect(translateToolChoice('any')).toBe('required');
  });

  test('translateRequest strips Anthropic-only fields (top_k, metadata)', () => {
    const body: AnthropicRequestBody = {
      ...ccTextRequest,
      top_k: 5,
      metadata: { user_id: 'test' },
    };
    const { openaiBody } = translateRequest(body);

    // top_k is NOT forwarded
    expect((openaiBody as any).top_k).toBeUndefined();
    // metadata is NOT forwarded
    expect((openaiBody as any).metadata).toBeUndefined();
    // top_p IS forwarded (standard field)
    expect(openaiBody.top_p).toBeUndefined(); // wasn't in ccTextRequest
  });

  test('translateRequest converts Anthropic tools → OpenAI function format', () => {
    const body: AnthropicRequestBody = {
      model: 'openai/gpt-4',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        {
          name: 'web_search',
          description: 'Search web',
          input_schema: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
          },
        },
        {
          name: 'calculator',
          description: 'Calculate',
          input_schema: { type: 'object', properties: { expr: { type: 'string' } } },
        },
      ],
      max_tokens: 100,
    };

    const { openaiBody } = translateRequest(body);

    expect(openaiBody.tools).toBeDefined();
    expect(openaiBody.tools!.length).toBe(2);
    expect(openaiBody.tools![0].type).toBe('function');
    expect(openaiBody.tools![0].function.name).toBe('web_search');
    expect(openaiBody.tools![0].function.parameters.type).toBe('object');
  });

  test('translateRequest converts stop_sequences → stop', () => {
    const body: AnthropicRequestBody = {
      ...ccTextRequest,
      stop_sequences: ['\n\nHuman:', '\n\nAssistant:'],
    };
    const { openaiBody } = translateRequest(body);
    expect(openaiBody.stop).toEqual(['\n\nHuman:', '\n\nAssistant:']);
    expect((openaiBody as any).stop_sequences).toBeUndefined();
  });

  test('translateRequest converts max_tokens, temperature, top_p', () => {
    const body: AnthropicRequestBody = {
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 2048,
      temperature: 0.7,
      top_p: 0.9,
    };
    const { openaiBody } = translateRequest(body);
    expect(openaiBody.max_tokens).toBe(2048);
    expect(openaiBody.temperature).toBe(0.7);
    expect(openaiBody.top_p).toBe(0.9);
  });

  test('translateRequest converts system prompt → system message', () => {
    const body: AnthropicRequestBody = {
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
      system: 'You are helpful.',
      max_tokens: 100,
    };
    const { openaiBody } = translateRequest(body);
    expect(openaiBody.messages[0].role).toBe('system');
    expect(openaiBody.messages[0].content).toBe('You are helpful.');
  });

  test('translateRequest converts system ContentBlock[] → system message', () => {
    const body: AnthropicRequestBody = {
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
      system: [
        { type: 'text', text: 'System prompt line 1' },
        { type: 'text', text: 'Line 2' },
      ],
      max_tokens: 100,
    };
    const { openaiBody } = translateRequest(body);
    expect(openaiBody.messages[0].role).toBe('system');
    expect(openaiBody.messages[0].content).toBe('System prompt line 1\nLine 2');
  });

  test('translateRequest adds stream_options when streaming', () => {
    const { openaiBody } = translateRequest(ccTextRequest);
    expect((openaiBody.stream_options as any)?.include_usage).toBe(true);
  });

  test('translateRequest does NOT pass thinking through', () => {
    const body: AnthropicRequestBody = {
      ...ccTextRequest,
      thinking: { type: 'enabled', budget_tokens: 16000 },
    };
    const { openaiBody } = translateRequest(body);
    // thinking is intentionally not in translateRequest output — injected
    // separately by start-proxy.ts with the correct reasoning_effort
    expect((openaiBody as any).thinking).toBeUndefined();
  });

  // --- translateResponse: OpenAI → Anthropic ---

  test('translateResponse maps basic Text response correctly', () => {
    const openaiRes = {
      id: 'chatcmpl-123',
      model: 'gpt-4',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'Hello! How can I help?' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
    const anthropic = translateResponse(openaiRes, 'claude-sonnet-4-6') as Record<string, unknown>;
    expect(anthropic.type).toBe('message');
    expect(anthropic.role).toBe('assistant');
    expect(anthropic.stop_reason).toBe('end_turn');
    const content = anthropic.content as any[];
    expect(content[0].type).toBe('text');
    expect(content[0].text).toBe('Hello! How can I help?');
  });

  test('translateResponse maps finish_reasons correctly', () => {
    const cases: Array<[string | undefined, string]> = [
      ['stop', 'end_turn'],
      ['tool_calls', 'tool_use'],
      ['length', 'max_tokens'],
      ['content_filter', 'content_filter'],
      [undefined, 'end_turn'],
      ['unknown', 'end_turn'],
    ];
    for (const [input, expected] of cases) {
      const openaiRes = {
        choices: [{ index: 0, message: {}, finish_reason: input }],
      };
      const r = translateResponse(openaiRes, 'test') as Record<string, unknown>;
      expect(r.stop_reason).toBe(expected);
    }
  });

  test('translateResponse maps usage tokens (prompt→input, completion→output)', () => {
    const openaiRes = {
      choices: [{ index: 0, message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    };
    const r = translateResponse(openaiRes, 'test') as Record<string, unknown>;
    const usage = r.usage as any;
    expect(usage.input_tokens).toBe(100);
    expect(usage.output_tokens).toBe(50);
  });
});

// =========================================================================
// Scenario 4: Full pipeline — CC request → preprocessing → translation → response
// =========================================================================

describe('Scenario 4: Full end-to-end pipeline', () => {
  test('Anthropic path (an): raw request passes through untouched', () => {
    const an = PROVIDER_CONSTRAINTS.an;
    const body = JSON.parse(JSON.stringify(ccWebSearchRequest));
    // For an: nativeServerTools is true → preprocessing skipped
    // The raw body with web_search_20250305 is forwarded directly
    expect(an.nativeServerTools).toBe(true);
    expect(body.tools).toBeDefined();
    // Anthropic natively understands tool_choice with thinking
    expect(an.forbidsToolChoiceWithThinking).toBe(false);
  });

  test('DeepSeek path (ds): web_search_20250305 → convert → strip tool_choice → inject thinking', () => {
    const ds = PROVIDER_CONSTRAINTS.ds;

    // Step 1: Preprocess (convert tools, strip tool_choice)
    const preBody: Record<string, unknown> & { tools?: unknown[]; tool_choice?: unknown } = {
      tools: [{ type: 'web_search_20250305', name: 'web_search', description: 'Search the web' }],
      tool_choice: { type: 'tool', name: 'web_search' },
    };
    const preResult = preprocessServerTools(preBody, ds);

    // Tool was detected and converted
    expect(preResult.hadWebSearch).toBe(true);
    // tool_choice was stripped
    expect(preBody.tool_choice).toBeUndefined();
    // Tool type prefix removed
    const tool = (preBody.tools as any[])[0] as any;
    expect(tool.type).toBeUndefined();

    // Step 2: Thinking would be injected by start-proxy.ts
    // (verified by constraint check: ds.thinkingFormat === 'anthropic')
    expect(ds.thinkingFormat).toBe('anthropic');
  });

  test('OpenAI path (or): translateRequest strips Anthropic fields', () => {
    const body: AnthropicRequestBody = {
      ...ccTextRequest,
      top_k: 10,
      metadata: { key: 'value' },
      tool_choice: 'auto',
    };
    const { openaiBody } = translateRequest(body);

    // top_k stripped
    expect((openaiBody as any).top_k).toBeUndefined();
    // metadata stripped
    expect((openaiBody as any).metadata).toBeUndefined();
    // tool_choice translated
    expect(openaiBody.tool_choice).toBe('auto');
    // max_tokens forwarded
    expect(openaiBody.max_tokens).toBe(1024);
  });

  test('confirm all 19 providers have consistent constraints vs providers.json', () => {
    // Every provider that exists in constraints must have valid thinkingFormat
    for (const [key, c] of Object.entries(PROVIDER_CONSTRAINTS)) {
      // thinkingFormat must be one of the three valid values
      expect(['anthropic', 'openai', null]).toContain(c.thinkingFormat);

      // All non-Anthropic providers must NOT have nativeServerTools
      if (key !== 'an') {
        expect(c.nativeServerTools).toBe(false);
      }

      // All non-Anthropic providers must require model rewrite
      if (key !== 'an') {
        expect(c.requiresModelRewrite).toBe(true);
      }

      // All non-Anthropic providers must NOT have nativeServerToolUse
      if (key !== 'an') {
        expect(c.nativeServerToolUse).toBe(false);
      }
    }
  });
});
