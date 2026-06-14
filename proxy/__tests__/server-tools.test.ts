'use strict';

import {
  isServerToolType,
  convertServerTools,
  hasPendingToolResult,
  isNativeAnthropicProvider,
  extractSearchQuery,
} from '../server-tools';

describe('isServerToolType', () => {
  test('matches web_search_ prefix', () => {
    expect(isServerToolType('web_search_20250101')).toBe(true);
  });

  test('matches web_fetch_ prefix', () => {
    expect(isServerToolType('web_fetch_20250101')).toBe(true);
  });

  test('matches computer_ prefix', () => {
    expect(isServerToolType('computer_20250101')).toBe(true);
  });

  test('matches bash_ prefix', () => {
    expect(isServerToolType('bash_20250101')).toBe(true);
  });

  test('rejects standard tool types', () => {
    expect(isServerToolType('custom')).toBe(false);
    expect(isServerToolType('function')).toBe(false);
  });

  test('rejects null/undefined/empty', () => {
    expect(isServerToolType(null)).toBe(false);
    expect(isServerToolType(undefined)).toBe(false);
    expect(isServerToolType('')).toBe(false);
  });
});

describe('isNativeAnthropicProvider', () => {
  test('returns true for the "an" provider key (regardless of hostname)', () => {
    expect(isNativeAnthropicProvider('an')).toBe(true);
    expect(isNativeAnthropicProvider('an', 'api.anthropic.com')).toBe(true);
    expect(isNativeAnthropicProvider('an', 'custom-proxy.example.com')).toBe(true);
  });

  test('returns true for api.anthropic.com hostname with any provider key', () => {
    // Should still match even if providerKey isn't 'an' — the hostname is
    // the canonical signal that we are talking to the real Anthropic API.
    expect(isNativeAnthropicProvider('direct', 'api.anthropic.com')).toBe(true);
    expect(isNativeAnthropicProvider('', 'api.anthropic.com')).toBe(true);
  });

  test('returns false for non-Anthropic provider keys (ds, oc, or, etc.)', () => {
    expect(isNativeAnthropicProvider('ds')).toBe(false);
    expect(isNativeAnthropicProvider('oc')).toBe(false);
    expect(isNativeAnthropicProvider('or')).toBe(false);
    expect(isNativeAnthropicProvider('fw')).toBe(false);
    expect(isNativeAnthropicProvider('km')).toBe(false);
    expect(isNativeAnthropicProvider('mt')).toBe(false);
  });

  test('returns false for non-Anthropic hostnames', () => {
    expect(isNativeAnthropicProvider('ds', 'api.deepseek.com')).toBe(false);
    expect(isNativeAnthropicProvider('oc', 'opencode.ai')).toBe(false);
    expect(isNativeAnthropicProvider('or', 'openrouter.ai')).toBe(false);
  });

  test('returns false for empty provider key with no hostname', () => {
    expect(isNativeAnthropicProvider('')).toBe(false);
  });

  test('hostname match is exact — subdomain variants do not match', () => {
    expect(isNativeAnthropicProvider('staging', 'staging.api.anthropic.com')).toBe(false);
    expect(isNativeAnthropicProvider('test', 'test-api.anthropic.com')).toBe(false);
  });
});

describe('convertServerTools', () => {
  test('converts web_search_ tool to custom', () => {
    const { tools, hasWebSearch, hasWebFetch } = convertServerTools([
      { type: 'web_search_20250101', name: 'web_search', description: 'Search' },
    ]);
    expect(hasWebSearch).toBe(true);
    expect(hasWebFetch).toBe(false);
    expect(tools[0].type).toBeUndefined();
    expect(tools[0].name).toBe('web_search');
    expect(tools[0].input_schema).toBeDefined();
  });

  test('converts web_fetch_ and url_fetch_ to custom', () => {
    const { tools, hasWebSearch, hasWebFetch } = convertServerTools([
      { type: 'web_fetch_20250101', name: 'fetch' },
      { type: 'url_fetch_20250101', name: 'url_fetch' },
    ]);
    expect(hasWebSearch).toBe(false);
    expect(hasWebFetch).toBe(true);
    expect(tools[0].type).toBeUndefined();
    expect(tools[0].name).toBe('web_fetch');
    expect(tools[1].type).toBeUndefined();
    expect(tools[1].name).toBe('web_fetch');
  });

  test('passes through non-server tools unchanged', () => {
    const input = [{ type: 'custom', name: 'my_tool' }];
    const { tools, hasWebSearch, hasWebFetch } = convertServerTools(input);
    expect(hasWebSearch).toBe(false);
    expect(hasWebFetch).toBe(false);
    expect(tools[0]).toBe(input[0]);
  });

  test('handles null/undefined tools', () => {
    const { tools: t1 } = convertServerTools(null);
    expect(t1).toEqual([]);
    const { tools: t2 } = convertServerTools(undefined);
    expect(t2).toEqual([]);
  });

  test('handles empty array', () => {
    const { tools, hasWebSearch, hasWebFetch } = convertServerTools([]);
    expect(tools).toEqual([]);
    expect(hasWebSearch).toBe(false);
    expect(hasWebFetch).toBe(false);
  });
});

describe('hasPendingToolResult', () => {
  test('detects empty tool_result for web_search', () => {
    const messages = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tool_1', name: 'web_search', input: { query: 'test' } }],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool_1', content: '' }] },
    ];
    const result = hasPendingToolResult(messages);
    expect(result.needsPopulation).toBe(true);
    expect(result.emptyResults).toHaveLength(1);
  });

  test('detects unrecognized tool_result for web_fetch', () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'tool_2',
            name: 'web_fetch',
            input: { url: 'https://example.com' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool_2',
            content: 'No tool implementation found for web_fetch',
          },
        ],
      },
    ];
    const result = hasPendingToolResult(messages);
    expect(result.needsPopulation).toBe(true);
  });

  test('returns false when all tool results are populated', () => {
    const messages = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tool_3', name: 'web_search', input: { query: 'test' } }],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tool_3', content: 'Here are the results...' },
        ],
      },
    ];
    const result = hasPendingToolResult(messages);
    expect(result.needsPopulation).toBe(false);
  });

  test('returns false when no tool_use blocks exist', () => {
    const messages = [{ role: 'user', content: 'Hello' }];
    const result = hasPendingToolResult(messages);
    expect(result.needsPopulation).toBe(false);
  });

  test('handles null messages', () => {
    const result = hasPendingToolResult(null);
    expect(result.needsPopulation).toBe(false);
  });
});

// -- Tool pre-execute + selective strip before forwarding --------------------
// Only web_search/web_fetch are pre-executed locally and stripped — they cause
// 400s on DeepSeek when forwarded as custom tools.
// text_editor, bash, code_execution etc. are converted to custom tools via
// convertServerTools and forwarded — DeepSeek typically accepts these.

describe('tool pre-execute + selective strip path', () => {
  test('web_search stripped, text_editor kept (not converted — passed through)', () => {
    const WEB_PREFIXES = ['web_search_', 'web_fetch_', 'url_fetch_'];
    const isWeb = (type: string) => WEB_PREFIXES.some((p) => type.startsWith(p));
    const tools: any[] = [
      { type: 'web_search_20260209', name: 'web_search' },
      { type: 'text_editor_20250728', name: 'str_replace_based_edit_tool' },
    ];
    const kept = tools.filter((t: any) => !isWeb(t.type));
    expect(kept.length).toBe(1);
    expect(kept[0].type).toBe('text_editor_20250728');
  });

  test('only web_search stripped — all others converted', () => {
    const WEB_PREFIXES = ['web_search_', 'web_fetch_', 'url_fetch_'];
    const isWeb = (type: string) => WEB_PREFIXES.some((p) => type.startsWith(p));
    const tools: any[] = [
      { type: 'web_search_20260209', name: 'web_search' },
      { type: 'web_fetch_20260209', name: 'web_fetch' },
    ];
    const stripped = tools.filter((t: any) => !isWeb(t.type));
    expect(stripped.length).toBe(0);
  });

  test('bash and text_editor pass through — only web tools are stripped', () => {
    const WEB_PREFIXES = ['web_search_', 'web_fetch_', 'url_fetch_'];
    const isWeb = (type: string) => WEB_PREFIXES.some((p) => type.startsWith(p));
    const tools: any[] = [
      { type: 'bash_20250124', name: 'bash' },
      { type: 'text_editor_20250728', name: 'str_replace_based_edit_tool' },
    ];
    const kept = tools.filter((t: any) => !isWeb(t.type));
    expect(kept.length).toBe(2); // Neither is a web tool — both pass through
  });

  test('convertServerTools flags hasWebSearch/hasWebFetch for pre-execution', () => {
    const conv = convertServerTools([
      { type: 'web_search_20260209', name: 'web_search' },
      { type: 'web_fetch_20260209', name: 'web_fetch' },
    ]);
    expect(conv.hasWebSearch).toBe(true);
    expect(conv.hasWebFetch).toBe(true);
  });
});

// =========================================================================
// extractSearchQuery tests — pure function, no HTTP deps
// =========================================================================

describe('extractSearchQuery', () => {
  test('extracts query from string content with "Perform a web search for the query:" prefix', () => {
    const messages = [
      { role: 'user', content: 'Perform a web search for the query: latest AI news' },
    ];
    expect(extractSearchQuery(messages)).toBe('latest AI news');
  });

  test('extracts query from text block in content array', () => {
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Perform a web search for the query: climate change 2026' },
        ],
      },
    ];
    expect(extractSearchQuery(messages)).toBe('climate change 2026');
  });

  test('scans backward to find last user message with search query', () => {
    const messages = [
      { role: 'user', content: 'Perform a web search for the query: first query' },
      { role: 'assistant', content: 'some response' },
      { role: 'user', content: 'Perform a web search for the query: second query' },
    ];
    // Last user message wins
    expect(extractSearchQuery(messages)).toBe('second query');
  });

  test('skips user messages without search prefix and finds the one with it', () => {
    const messages = [
      { role: 'user', content: 'Hello, can you help me?' },
      { role: 'assistant', content: 'Sure!' },
      { role: 'user', content: 'Perform a web search for the query: stock prices' },
    ];
    expect(extractSearchQuery(messages)).toBe('stock prices');
  });

  test('returns null when no user message has search prefix', () => {
    const messages = [
      { role: 'user', content: 'What is the weather?' },
      { role: 'assistant', content: 'It is sunny.' },
    ];
    expect(extractSearchQuery(messages)).toBeNull();
  });

  test('returns null for null/undefined messages', () => {
    expect(extractSearchQuery(null as any)).toBeNull();
    expect(extractSearchQuery(undefined as any)).toBeNull();
  });

  test('returns null for non-array messages', () => {
    expect(extractSearchQuery('not an array' as any)).toBeNull();
    expect(extractSearchQuery(42 as any)).toBeNull();
  });

  test('returns null for empty messages array', () => {
    expect(extractSearchQuery([])).toBeNull();
  });

  test('returns null when only assistant has search-like text', () => {
    const messages = [
      { role: 'assistant', content: 'Perform a web search for the query: ignored' },
    ];
    expect(extractSearchQuery(messages)).toBeNull();
  });

  test('trims whitespace from extracted query', () => {
    const messages = [
      { role: 'user', content: 'Perform a web search for the query:   padded query   ' },
    ];
    expect(extractSearchQuery(messages)).toBe('padded query');
  });

  test('handles content array with non-text blocks gracefully', () => {
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'image', source: { data: 'abc' } },
          { type: 'text', text: 'Perform a web search for the query: machine learning' },
        ],
      },
    ];
    expect(extractSearchQuery(messages)).toBe('machine learning');
  });

  test('case-insensitive match of search prefix', () => {
    const messages = [
      { role: 'user', content: 'PERFORM A WEB SEARCH FOR THE QUERY: uppercase test' },
    ];
    expect(extractSearchQuery(messages)).toBe('uppercase test');
  });

  test('handles mixed-case search prefix', () => {
    const messages = [{ role: 'user', content: 'Perform a Web Search for the query: mixed case' }];
    expect(extractSearchQuery(messages)).toBe('mixed case');
  });
});

// =========================================================================
// isServerToolType — all prefix coverage
// =========================================================================

describe('isServerToolType — all prefixes', () => {
  test('matches text_editor_ prefix', () => {
    expect(isServerToolType('text_editor_20250728')).toBe(true);
  });

  test('matches memory_ prefix', () => {
    expect(isServerToolType('memory_20250101')).toBe(true);
  });

  test('matches tool_search_tool_ prefix', () => {
    expect(isServerToolType('tool_search_tool_20250219')).toBe(true);
  });

  test('matches url_fetch_ prefix', () => {
    expect(isServerToolType('url_fetch_20250101')).toBe(true);
  });

  test('rejects non-string types', () => {
    expect(isServerToolType(123 as any)).toBe(false);
    expect(isServerToolType(true as any)).toBe(false);
    expect(isServerToolType({} as any)).toBe(false);
  });

  test('rejects strings that only partially match prefix', () => {
    // Must START with the prefix, not just contain it
    expect(isServerToolType('custom_web_search_tool')).toBe(false);
    expect(isServerToolType('my_bash_script')).toBe(false);
  });
});

// =========================================================================
// convertServerTools — additional edge cases
// =========================================================================

describe('convertServerTools — edge cases', () => {
  test('handles tools array containing null entries', () => {
    const result = convertServerTools([
      { type: 'web_search_20260209', name: 'search' },
      null as any,
      { type: 'custom', name: 'other' },
    ]);
    expect(result.hasWebSearch).toBe(true);
    expect(result.tools.length).toBe(3);
    // null entry passes through (guarded by `if (!tool || typeof tool !== 'object')`)
    expect(result.tools[1]).toBeNull();
  });

  test('handles tools array containing undefined entries', () => {
    const result = convertServerTools([
      undefined as any,
      { type: 'web_fetch_20260209', name: 'f' },
    ]);
    expect(result.hasWebFetch).toBe(true);
    expect(result.tools[0]).toBeUndefined();
  });

  test('handles tools array containing non-object entries (number)', () => {
    const result = convertServerTools([42 as any, { type: 'web_search_20260209', name: 's' }]);
    expect(result.hasWebSearch).toBe(true);
  });

  test('handles tool with empty type string', () => {
    const tool = { type: '', name: 'empty' };
    const result = convertServerTools([tool]);
    expect(result.hasWebSearch).toBe(false);
    expect(result.hasWebFetch).toBe(false);
    expect(result.tools[0]).toBe(tool);
  });

  test('handles tool with no type property', () => {
    const tool = { name: 'no-type' } as any;
    const result = convertServerTools([tool]);
    expect(result.hasWebSearch).toBe(false);
    expect(result.hasWebFetch).toBe(false);
  });

  test('non-array input returns as-is with both flags false', () => {
    const obj = { type: 'web_search' } as any;
    const result = convertServerTools(obj);
    expect(result.tools).toBe(obj);
    expect(result.hasWebSearch).toBe(false);
    expect(result.hasWebFetch).toBe(false);
  });

  test('web_search_ tool gets web_search schema', () => {
    const result = convertServerTools([{ type: 'web_search_20260209', name: 'search' }]);
    const schema = result.tools[0].input_schema as any;
    expect(schema).toBeDefined();
    expect(schema.properties.query).toBeDefined();
    expect(schema.required).toContain('query');
  });

  test('web_fetch_ tool gets web_fetch schema', () => {
    const result = convertServerTools([{ type: 'web_fetch_20260209', name: 'fetch' }]);
    const schema = result.tools[0].input_schema as any;
    expect(schema).toBeDefined();
    expect(schema.properties.url).toBeDefined();
    expect(schema.required).toContain('url');
  });
});

// =========================================================================
// hasPendingToolResult — additional edge cases
// =========================================================================

describe('hasPendingToolResult — edge cases', () => {
  test('detects "not recognized" content as empty', () => {
    const messages = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'web_search', input: { query: 'x' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'not recognized' }],
      },
    ];
    const result = hasPendingToolResult(messages);
    expect(result.needsPopulation).toBe(true);
  });

  test('empty array content is considered empty', () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 't2', name: 'web_fetch', input: { url: 'https://x.com' } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: [] }] },
    ];
    const result = hasPendingToolResult(messages);
    expect(result.needsPopulation).toBe(true);
  });

  test('returns false for messages with no assistant role', () => {
    const messages = [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't3', content: '' }] },
    ];
    const result = hasPendingToolResult(messages);
    expect(result.needsPopulation).toBe(false);
  });

  test('handles non-array content in assistant message', () => {
    const messages = [
      { role: 'assistant', content: 'plain text response' },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't4', content: '' }] },
    ];
    // No tool_use blocks found in assistant message (content is string, not array)
    const result = hasPendingToolResult(messages);
    expect(result.needsPopulation).toBe(false);
  });

  test('tool_use without matching tool_result does not trigger', () => {
    const messages = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't5', name: 'web_search', input: { query: 'q' } }],
      },
      // No user message with tool_result for t5
    ];
    const result = hasPendingToolResult(messages);
    expect(result.needsPopulation).toBe(false);
  });

  test('tool_result with unknown tool_use_id is ignored', () => {
    const messages = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't6', name: 'web_search', input: { query: 'q' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'different-id', content: '' }],
      },
    ];
    const result = hasPendingToolResult(messages);
    expect(result.needsPopulation).toBe(false); // empty result, but tool_use_id doesn't match
  });
});
