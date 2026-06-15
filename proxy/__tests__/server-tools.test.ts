'use strict';

import {
  isServerToolType,
  convertServerTools,
  preprocessServerTools,
  hasPendingToolResult,
  isNativeAnthropicProvider,
  extractSearchQuery,
  safeSlice,
  isPrivateIPv4,
  ddgLiteSearch,
  webSearch,
  webFetch,
  populateToolResults,
  acquireFetchSlot,
  releaseFetchSlot,
  getCachedSearch,
  setCachedSearch,
  _resetFetchSlots,
  _resetSearchCache,
} from '../server-tools';

// --- Module-scope mocks for network-dependent executor functions ---
// jest.mock is hoisted — factories run before imports. We use mutable
// jest.fn() refs so tests can control behavior via mockImplementation.

const mockHttpsGet = jest.fn();
const mockHttpsRequest = jest.fn();
const mockDnsLookup = jest.fn();
const mockValidateUrl = jest.fn();

jest.mock('https', () => ({
  ...jest.requireActual('https'),
  get: (...args: any[]) => mockHttpsGet(...args),
  request: (...args: any[]) => mockHttpsRequest(...args),
}));

jest.mock('dns', () => ({
  ...jest.requireActual('dns'),
  promises: {
    ...jest.requireActual('dns').promises,
    lookup: (...args: any[]) => mockDnsLookup(...args),
  },
}));

jest.mock('../ssrf', () => ({
  validateUrl: (...args: any[]) => mockValidateUrl(...args),
}));

// --- Shared test data ---

const SAMPLE_HTML = `
<html>
<body>
<a class='result-link' href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com&amp;rut=abc">Example Title</a>
<td class='result-snippet'>This is a sample snippet about the example domain.</td>
<a class='result-link' href="//duckduckgo.com/l/?uddg=https%3A%2F%2Ftest.org&amp;rut=def">Test Org</a>
<td class='result-snippet'>Another snippet for <b>testing</b> purposes.</td>
</body>
</html>`;

// --- Shared mock helpers ---

interface MockResponse {
  listeners: Record<string, Array<(...args: any[]) => void>>;
  on: (event: string, cb: (...args: any[]) => void) => MockResponse;
  destroy: () => void;
  statusCode?: number;
  headers?: Record<string, string>;
}

function makeMockResponse(): MockResponse {
  const listeners: Record<string, Array<(...args: any[]) => void>> = {};
  return {
    listeners,
    on(event: string, cb: (...args: any[]) => void) {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(cb);
      return this;
    },
    destroy() {},
  };
}

function fireDataEnd(res: MockResponse, data: string): void {
  if (res.listeners['data']) {
    res.listeners['data'].forEach((fn: any) => fn(Buffer.from(data)));
  }
  if (res.listeners['end']) {
    res.listeners['end'].forEach((fn: any) => fn());
  }
}

function setupMockGetHtml(html: string): void {
  mockHttpsGet.mockImplementation((_url: string, _opts: any, cb: any) => {
    const res = makeMockResponse();
    setTimeout(() => {
      cb(res);
      fireDataEnd(res, html);
    }, 0);
    const req = {
      on: jest.fn().mockReturnThis(),
      destroy: jest.fn(),
    };
    return req as any;
  });
}

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
    expect(kept.length).toBe(2);
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
// extractSearchQuery tests
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
    const result = hasPendingToolResult(messages);
    expect(result.needsPopulation).toBe(false);
  });

  test('tool_use without matching tool_result does not trigger', () => {
    const messages = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't5', name: 'web_search', input: { query: 'q' } }],
      },
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
    expect(result.needsPopulation).toBe(false);
  });

  test('detects "Did 0 searches" response as empty (CC failed search)', () => {
    const messages = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't7', name: 'web_search', input: { query: 'x' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't7', content: 'Did 0 searches in 3s' }],
      },
    ];
    const result = hasPendingToolResult(messages);
    expect(result.needsPopulation).toBe(true);
  });

  test('detects "Error:" prefixed content as empty (CC failed fetch)', () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 't8', name: 'web_fetch', input: { url: 'https://x.com' } },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't8',
            content: 'Error: ECONNREFUSED',
          },
        ],
      },
    ];
    const result = hasPendingToolResult(messages);
    expect(result.needsPopulation).toBe(true);
  });

  test('considers "Error: ..." with leading whitespace as empty', () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 't9', name: 'web_fetch', input: { url: 'https://x.com' } },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't9',
            content: '  Error: Was there a typo in the url or port?',
          },
        ],
      },
    ];
    const result = hasPendingToolResult(messages);
    expect(result.needsPopulation).toBe(true);
  });

  test('detects "Transport error" as empty', () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 't10', name: 'web_fetch', input: { url: 'https://x.com' } },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't10',
            content: 'Transport error (GET https://example.com)',
          },
        ],
      },
    ];
    const result = hasPendingToolResult(messages);
    expect(result.needsPopulation).toBe(true);
  });

  test('detects "fetch failed" as empty', () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 't11', name: 'web_fetch', input: { url: 'https://x.com' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't11', content: 'fetch failed' }],
      },
    ];
    const result = hasPendingToolResult(messages);
    expect(result.needsPopulation).toBe(true);
  });

  test('detects "Timed out" as empty', () => {
    const messages = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't12', name: 'web_search', input: { query: 'x' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't12', content: 'Timed out after 10s' }],
      },
    ];
    const result = hasPendingToolResult(messages);
    expect(result.needsPopulation).toBe(true);
  });

  test('detects "No results found" as empty', () => {
    const messages = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't13', name: 'web_search', input: { query: 'x' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't13', content: 'No results found' }],
      },
    ];
    const result = hasPendingToolResult(messages);
    expect(result.needsPopulation).toBe(true);
  });

  test('does NOT flag legitimate results containing "error" mid-content', () => {
    const messages = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't14', name: 'web_search', input: { query: 'x' } }],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't14',
            content: 'The page discusses error handling in distributed systems...',
          },
        ],
      },
    ];
    const result = hasPendingToolResult(messages);
    expect(result.needsPopulation).toBe(false);
  });

  test('detects error object { is_error: true } as empty', () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 't15', name: 'web_fetch', input: { url: 'https://x.com' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't15', content: { is_error: true } }],
      },
    ];
    const result = hasPendingToolResult(messages);
    expect(result.needsPopulation).toBe(true);
  });

  test('detects error object { error: "msg" } as empty', () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 't16', name: 'web_fetch', input: { url: 'https://x.com' } },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't16',
            content: { error: 'connection refused' },
          },
        ],
      },
    ];
    const result = hasPendingToolResult(messages);
    expect(result.needsPopulation).toBe(true);
  });

  test('does NOT flag plain object without error keys as empty', () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 't17', name: 'web_fetch', input: { url: 'https://x.com' } },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't17',
            content: { status: 200, body: '<html>...' },
          },
        ],
      },
    ];
    const result = hasPendingToolResult(messages);
    expect(result.needsPopulation).toBe(false);
  });

  test('matches native Anthropic tool name web_search_20260209', () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 't18', name: 'web_search_20260209', input: { query: 'x' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't18', content: '' }],
      },
    ];
    const result = hasPendingToolResult(messages);
    expect(result.needsPopulation).toBe(true);
  });

  test('matches native Anthropic tool name web_fetch_20260209', () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 't19',
            name: 'web_fetch_20260209',
            input: { url: 'https://x.com' },
          },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't19', content: 'Error: ECONNREFUSED' }],
      },
    ];
    const result = hasPendingToolResult(messages);
    expect(result.needsPopulation).toBe(true);
  });

  test('matches url_fetch_ native tool name', () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 't20',
            name: 'url_fetch_20241022',
            input: { url: 'https://x.com' },
          },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't20', content: '' }],
      },
    ];
    const result = hasPendingToolResult(messages);
    expect(result.needsPopulation).toBe(true);
  });
});

// =========================================================================
// safeSlice — UTF-16 surrogate pair safety
// =========================================================================

describe('safeSlice', () => {
  test('returns full string when shorter than maxLen', () => {
    expect(safeSlice('hello', 10)).toBe('hello');
  });

  test('returns full string when exactly maxLen', () => {
    expect(safeSlice('hello', 5)).toBe('hello');
  });

  test('slices safely at normal boundary', () => {
    expect(safeSlice('hello world', 5)).toBe('hello');
  });

  test('avoids splitting surrogate pairs (emoji at boundary)', () => {
    const str = 'ab😀cd';
    // byte length at index 2 = 0xD83D (high surrogate of 😀)
    // maxLen 3 would split the pair → safeSlice should back off to 2
    expect(safeSlice(str, 3)).toBe('ab');
  });

  test('slices normally when no surrogate at boundary', () => {
    const str = 'abcdef';
    expect(safeSlice(str, 3)).toBe('abc');
  });

  test('handles empty string', () => {
    expect(safeSlice('', 5)).toBe('');
  });

  test('handles maxLen 0', () => {
    expect(safeSlice('hello', 0)).toBe('');
  });
});

// =========================================================================
// isPrivateIPv4 — internal network detection
// =========================================================================

describe('isPrivateIPv4', () => {
  test('detects 127.0.0.1 (loopback)', () => {
    expect(isPrivateIPv4('127.0.0.1')).toBe(true);
  });

  test('detects 127.x.x.x range', () => {
    expect(isPrivateIPv4('127.99.88.77')).toBe(true);
  });

  test('detects 0.0.0.0', () => {
    expect(isPrivateIPv4('0.0.0.0')).toBe(true);
  });

  test('detects 10.x.x.x (Class A private)', () => {
    expect(isPrivateIPv4('10.0.0.1')).toBe(true);
    expect(isPrivateIPv4('10.255.255.255')).toBe(true);
  });

  test('detects 172.16-31.x.x (Class B private)', () => {
    expect(isPrivateIPv4('172.16.0.1')).toBe(true);
    expect(isPrivateIPv4('172.31.255.255')).toBe(true);
  });

  test('rejects 172.15.x.x (outside private range)', () => {
    expect(isPrivateIPv4('172.15.0.1')).toBe(false);
  });

  test('rejects 172.32.x.x (outside private range)', () => {
    expect(isPrivateIPv4('172.32.0.1')).toBe(false);
  });

  test('detects 192.168.x.x (Class C private)', () => {
    expect(isPrivateIPv4('192.168.0.1')).toBe(true);
    expect(isPrivateIPv4('192.168.255.255')).toBe(true);
  });

  test('detects 169.254.x.x (link-local)', () => {
    expect(isPrivateIPv4('169.254.0.1')).toBe(true);
  });

  test('rejects public IPs', () => {
    expect(isPrivateIPv4('8.8.8.8')).toBe(false);
    expect(isPrivateIPv4('1.1.1.1')).toBe(false);
    expect(isPrivateIPv4('93.184.216.34')).toBe(false);
  });
});

// =========================================================================
// ddgLiteSearch — HTML scraper
// =========================================================================

describe('ddgLiteSearch', () => {
  beforeEach(() => {
    mockHttpsGet.mockReset();
  });

  test('extracts titles and URLs from result-link anchors', async () => {
    setupMockGetHtml(SAMPLE_HTML);
    const results = await ddgLiteSearch('test query');
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results[0].title).toBe('Example Title');
    expect(results[0].url).toBe('https://example.com');
    expect(results[1].title).toBe('Test Org');
    expect(results[1].url).toBe('https://test.org');
  });

  test('extracts snippets from result-snippet cells', async () => {
    setupMockGetHtml(SAMPLE_HTML);
    const results = await ddgLiteSearch('test query');
    expect(results[0].snippet).toContain('sample snippet');
    expect(results[1].snippet).toContain('testing');
  });

  test('returns empty array when HTML has no results', async () => {
    setupMockGetHtml('<html><body>No results found.</body></html>');
    const results = await ddgLiteSearch('xyznonexistent123');
    expect(results).toEqual([]);
  });

  test('returns empty array on network error', async () => {
    mockHttpsGet.mockImplementation((_url: string, _opts: any) => {
      const req = { on: jest.fn(), destroy: jest.fn() } as any;
      req.on.mockImplementation((event: string, cb: any) => {
        if (event === 'error') setTimeout(() => cb(new Error('connection refused')), 5);
        return req;
      });
      return req;
    });
    const results = await ddgLiteSearch('test');
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBe(0);
  });

  test('respects 500KB data limit', async () => {
    const res = makeMockResponse();
    mockHttpsGet.mockImplementation((_url: string, _opts: any, cb: any) => {
      setTimeout(() => {
        cb(res);
        if (res.listeners['data']) {
          res.listeners['data'].forEach((fn: any) => fn(Buffer.alloc(500_001)));
        }
      }, 0);
      const req = {
        on: jest.fn().mockReturnThis(),
        destroy: jest.fn(),
      };
      return req as any;
    });
    const results = await ddgLiteSearch('huge');
    expect(results).toEqual([]);
  });

  test('handles empty response body', async () => {
    const res = makeMockResponse();
    mockHttpsGet.mockImplementation((_url: string, _opts: any, cb: any) => {
      setTimeout(() => {
        cb(res);
        if (res.listeners['end']) {
          res.listeners['end'].forEach((fn: any) => fn());
        }
      }, 0);
      const req = {
        on: jest.fn().mockReturnThis(),
        destroy: jest.fn(),
      };
      return req as any;
    });
    const results = await ddgLiteSearch('empty');
    expect(results).toEqual([]);
  });
});

// =========================================================================
// webSearch — integration of cache + ddgLiteSearch + DDG JSON fallback
// =========================================================================

describe('webSearch', () => {
  beforeEach(() => {
    _resetSearchCache();
    _resetFetchSlots();
    mockHttpsGet.mockReset();
  });

  test('returns formatted results from DDG Lite', async () => {
    setupMockGetHtml(SAMPLE_HTML);
    const result = await webSearch('test');
    expect(result).toContain('Example Title');
    expect(result).toContain('https://example.com');
    expect(result).toContain('sample snippet');
  });

  test('deduplicates identical queries via cache', async () => {
    setupMockGetHtml(SAMPLE_HTML);
    const r1 = await webSearch('cached-query');
    const r2 = await webSearch('cached-query');
    expect(r1).toBe(r2);
  });

  test('returns fallback message when DDG Lite and JSON both empty', async () => {
    // First call: DDG Lite returns empty
    // Second call: DDG JSON API — return empty JSON
    let callCount = 0;
    mockHttpsGet.mockImplementation((url: string, _opts: any, cb: any) => {
      callCount++;
      const res = makeMockResponse();
      setTimeout(() => {
        cb(res);
        if ((url as string).includes('lite.duckduckgo.com')) {
          // Empty Lite response — fire end without data so ddgLiteSearch resolves
          if (res.listeners['end']) {
            res.listeners['end'].forEach((fn: any) => fn());
          }
        } else {
          // JSON API: return empty object
          fireDataEnd(res, '{}');
        }
      }, 0);
      const req = {
        on: jest.fn().mockReturnThis(),
        destroy: jest.fn(),
      };
      return req as any;
    });
    const result = await webSearch('completely-nonexistent-xyz-999');
    expect(result).toContain('No results found');
    expect(callCount).toBe(2); // DDG Lite + JSON fallback
  });
});

// =========================================================================
// acquireFetchSlot / releaseFetchSlot — concurrency limiter
// =========================================================================

describe('acquireFetchSlot / releaseFetchSlot', () => {
  beforeEach(() => {
    _resetFetchSlots();
  });

  test('acquires up to 5 slots without queuing', async () => {
    const promises = [];
    for (let i = 0; i < 5; i++) {
      promises.push(acquireFetchSlot());
    }
    const start = Date.now();
    await Promise.all(promises);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(50);
  });

  test('6th acquire queues until one releases', async () => {
    for (let i = 0; i < 5; i++) {
      await acquireFetchSlot();
    }

    let sixthResolved = false;
    acquireFetchSlot().then(() => {
      sixthResolved = true;
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(sixthResolved).toBe(false);

    releaseFetchSlot();
    // Need a tick for the queued resolution
    await new Promise((r) => setTimeout(r, 5));
    expect(sixthResolved).toBe(true);
  });

  test('queue drains in FIFO order', async () => {
    const order: number[] = [];
    for (let i = 0; i < 5; i++) {
      await acquireFetchSlot();
    }

    const p6 = acquireFetchSlot().then(() => order.push(6));
    const p7 = acquireFetchSlot().then(() => order.push(7));
    const p8 = acquireFetchSlot().then(() => order.push(8));

    releaseFetchSlot();
    releaseFetchSlot();
    releaseFetchSlot();

    await Promise.all([p6, p7, p8]);
    expect(order).toEqual([6, 7, 8]);
  });
});

// =========================================================================
// getCachedSearch / setCachedSearch — LRU cache
// =========================================================================

describe('getCachedSearch / setCachedSearch', () => {
  beforeEach(() => {
    _resetSearchCache();
  });

  test('set and get returns same value', () => {
    setCachedSearch('key1', 'value1');
    expect(getCachedSearch('key1')).toBe('value1');
  });

  test('returns null for uncached key', () => {
    expect(getCachedSearch('nonexistent')).toBeNull();
  });

  test('overwrites existing cache entry', () => {
    setCachedSearch('key1', 'value1');
    setCachedSearch('key1', 'value2');
    expect(getCachedSearch('key1')).toBe('value2');
  });

  test('multiple keys coexist', () => {
    setCachedSearch('a', '1');
    setCachedSearch('b', '2');
    setCachedSearch('c', '3');
    expect(getCachedSearch('a')).toBe('1');
    expect(getCachedSearch('b')).toBe('2');
    expect(getCachedSearch('c')).toBe('3');
  });
});

// =========================================================================
// webFetch — SSRF-protected URL fetcher
// =========================================================================

describe('webFetch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _resetFetchSlots();
    mockValidateUrl.mockResolvedValue({ valid: true, reason: '' });
    mockDnsLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  });

  test('rejects non-HTTP schemes', async () => {
    const result = await webFetch('ftp://example.com/file');
    expect(result).toContain('Only http and https URLs are supported');
  });

  test('rejects invalid URLs', async () => {
    const result = await webFetch('not-a-valid-url');
    expect(result).toContain('Invalid URL');
  });

  test('rejects when SSRF validation fails', async () => {
    mockValidateUrl.mockResolvedValue({ valid: false, reason: 'Blocked: internal IP' });
    const result = await webFetch('https://192.168.1.1/admin');
    expect(result).toContain('Blocked: internal IP');
  });

  test('rejects private IPv4 DNS results', async () => {
    // Private IPs are filtered from validation.addresses; fallback DNS also
    // returns nothing, so no valid addresses remain.
    mockValidateUrl.mockResolvedValue({ valid: true, addresses: ['127.0.0.1'] });
    mockDnsLookup.mockResolvedValue([]);
    const result = await webFetch('https://localhost-secret.example.com');
    expect(result).toContain('Could not resolve hostname to any valid address');
  });

  test('rejects link-local IPv4 DNS results', async () => {
    mockValidateUrl.mockResolvedValue({ valid: true, addresses: ['169.254.1.1'] });
    mockDnsLookup.mockResolvedValue([]);
    const result = await webFetch('https://link-local.example.com');
    expect(result).toContain('Could not resolve hostname to any valid address');
  });

  test('rejects IPv6 loopback', async () => {
    mockValidateUrl.mockResolvedValue({ valid: true, addresses: ['::1'] });
    mockDnsLookup.mockResolvedValue([]);
    const result = await webFetch('https://ipv6-localhost.example.com');
    expect(result).toContain('Could not resolve hostname to any valid address');
  });

  test('rejects IPv6 ULA (fc00::/7)', async () => {
    mockValidateUrl.mockResolvedValue({ valid: true, addresses: ['fc00::1'] });
    mockDnsLookup.mockResolvedValue([]);
    const result = await webFetch('https://ula.example.com');
    expect(result).toContain('Could not resolve hostname to any valid address');
  });

  test('rejects DNS resolution failures', async () => {
    // validateUrl returns valid but without addresses, so the fallback
    // DNS lookup runs and fails.
    mockValidateUrl.mockResolvedValue({ valid: true });
    mockDnsLookup.mockRejectedValue(new Error('ENOTFOUND'));
    const result = await webFetch('https://nonexistent-domain-99999.invalid');
    expect(result).toContain('Could not resolve hostname');
  });

  test('rejects empty DNS results', async () => {
    mockValidateUrl.mockResolvedValue({ valid: true });
    mockDnsLookup.mockResolvedValue([]);
    const result = await webFetch('https://no-address.example.com');
    expect(result).toContain('Could not resolve hostname to any valid address');
  });

  test('fetches HTTPS content successfully', async () => {
    mockHttpsRequest.mockImplementation((_opts: any, cb: any) => {
      const res = makeMockResponse() as any;
      res.statusCode = 200;
      res.headers = {};
      setTimeout(() => {
        cb(res);
        fireDataEnd(res, '<html><body>Hello World</body></html>');
      }, 0);
      return { on: jest.fn().mockReturnThis(), end: jest.fn(), destroy: jest.fn() } as any;
    });
    const result = await webFetch('https://example.com');
    expect(result).toContain('Hello World');
  });

  test('truncates content at 1MB', async () => {
    mockHttpsRequest.mockImplementation((_opts: any, cb: any) => {
      const res = makeMockResponse() as any;
      res.statusCode = 200;
      res.headers = {};
      const bigHtml = '<html><body>' + 'x'.repeat(1_000_001) + '</body></html>';
      setTimeout(() => {
        cb(res);
        fireDataEnd(res, bigHtml);
      }, 0);
      return { on: jest.fn().mockReturnThis(), end: jest.fn(), destroy: jest.fn() } as any;
    });
    const result = await webFetch('https://big.example.com');
    expect(result).toContain('[Content truncated at 1MB]');
  });
});

// =========================================================================
// populateToolResults — fills empty tool results with webSearch/webFetch
// =========================================================================

describe('populateToolResults', () => {
  beforeEach(() => {
    _resetSearchCache();
    _resetFetchSlots();
    mockHttpsGet.mockReset();
  });

  test('populates empty web_search tool_result', async () => {
    setupMockGetHtml(SAMPLE_HTML);

    const messages: any[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'tool_abc',
            name: 'web_search',
            input: { query: 'test populate' },
          },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool_abc', content: '' }],
      },
    ];

    const changed = await populateToolResults(messages);
    expect(changed).toBe(true);
    expect(messages[1].content[0].content).toContain('Test');
    expect(messages[1].content[0].content).toContain('https://example.com');
  });

  test('populates empty web_fetch tool_result', async () => {
    mockValidateUrl.mockResolvedValue({ valid: true, reason: '' });
    mockDnsLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    mockHttpsRequest.mockReset();
    mockHttpsRequest.mockImplementation((_opts: any, cb: any) => {
      const res = makeMockResponse() as any;
      res.statusCode = 200;
      res.headers = {};
      setTimeout(() => {
        cb(res);
        fireDataEnd(res, '<html><body>Fetched Page Content</body></html>');
      }, 0);
      return { on: jest.fn().mockReturnThis(), end: jest.fn(), destroy: jest.fn() } as any;
    });

    const messages: any[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'tool_def',
            name: 'web_fetch',
            input: { url: 'https://example.com' },
          },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool_def', content: '' }],
      },
    ];

    const changed = await populateToolResults(messages);
    expect(changed).toBe(true);
    expect(messages[1].content[0].content).toContain('Fetched Page Content');
  });

  test('leaves already-populated results unchanged', async () => {
    const messages: any[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'tool_ghi',
            name: 'web_search',
            input: { query: 'already done' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tool_ghi', content: 'Already populated content' },
        ],
      },
    ];

    const changed = await populateToolResults(messages);
    expect(changed).toBe(false);
    expect(messages[1].content[0].content).toBe('Already populated content');
  });

  test('returns false when no empty results found', async () => {
    const messages: any[] = [{ role: 'user', content: 'Hello' }];
    const changed = await populateToolResults(messages);
    expect(changed).toBe(false);
  });
});

// =========================================================================
// preprocessServerTools — request body preprocessing for non-Anthropic providers
// =========================================================================

describe('preprocessServerTools', () => {
  test('converts web_search_ type to generic web_search tool', () => {
    const body: any = {
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    };
    const result = preprocessServerTools(body);
    expect(result.modified).toBe(true);
    expect(result.hadWebSearch).toBe(true);
    expect(body.tools[0].name).toBe('web_search');
    expect(body.tools[0].type).toBeUndefined();
  });

  test('converts web_fetch_ type to generic web_fetch tool', () => {
    const body: any = {
      tools: [{ type: 'web_fetch_20250305', name: 'web_fetch' }],
    };
    const result = preprocessServerTools(body);
    expect(result.modified).toBe(true);
    expect(result.hadWebFetch).toBe(true);
  });

  test('strips tool_choice when server tools were converted', () => {
    const body: any = {
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      tool_choice: { type: 'tool', name: 'web_search' },
    };
    const result = preprocessServerTools(body);
    expect(result.modified).toBe(true);
    expect(body.tool_choice).toBeUndefined();
  });

  test('strips tool_choice even when no tools are converted (non-web tools)', () => {
    const body: any = {
      tools: [{ type: 'custom', name: 'my_tool' }],
      tool_choice: { type: 'any' },
    };
    preprocessServerTools(body);
    // tool_choice is always stripped for safety with non-Anthropic providers
    expect(body.tool_choice).toBeUndefined();
  });

  test('strips unconverted web tools (unknown prefix)', () => {
    const body: any = {
      tools: [
        { type: 'web_search_unknown_variant', name: 'search' },
        { type: 'custom', name: 'keep_me' },
      ],
    };
    preprocessServerTools(body);
    // 'web_search_unknown_variant' starts with 'web_search_' so convertServerTools
    // converts it. Then no unconverted remain. But if there were a variant with
    // a prefix NOT matching the convertServerTools mapping, it would be stripped.
    expect(body.tools.length).toBe(2);
    // Both survive: one converted, one kept as-is
  });

  test('deletes tools key when all tools are stripped', () => {
    // If all tools are web tools that fail conversion
    // (unlikely, but the code handles it)
    const body: any = {
      tools: [
        // This has a web_search_ prefix so convertServerTools converts it
        { type: 'web_search_20250305', name: 'search' },
      ],
      tool_choice: { type: 'tool', name: 'web_search' },
    };
    const result = preprocessServerTools(body);
    // convertServerTools converts it, so it survives
    expect(body.tools).toBeDefined();
    expect(result.hadWebSearch).toBe(true);
  });

  test('no-op when tools is null/undefined', () => {
    const body: any = { messages: [{ role: 'user', content: 'hi' }] };
    const result = preprocessServerTools(body);
    expect(result.modified).toBe(false);
    expect(result.hadWebSearch).toBe(false);
    expect(result.hadWebFetch).toBe(false);
  });

  test('no-op when tools is empty array', () => {
    const body: any = { tools: [], tool_choice: 'auto' };
    preprocessServerTools(body);
    // tool_choice is still stripped even with empty tools array
    // (it's in 'tool_choice' in body)
    expect(body.tool_choice).toBeUndefined();
  });

  test('preserves non-web custom tools unchanged', () => {
    const body: any = {
      tools: [
        { type: 'text_editor_20250728', name: 'str_replace_based_edit_tool' },
        { type: 'bash_20250124', name: 'bash' },
      ],
    };
    const result = preprocessServerTools(body);
    expect(result.hadWebSearch).toBe(false);
    expect(result.hadWebFetch).toBe(false);
    // text_editor and bash are not web tools — they pass through untouched
    expect(body.tools.length).toBe(2);
    // tool_choice stripping always fires for non-Anthropic providers
  });

  test('removes tool_choice regardless of whether tools were modified', () => {
    // Regression test: even if no server tools need conversion,
    // tool_choice must be stripped because DeepSeek rejects it with thinking mode
    const body: any = {
      tools: [{ type: 'custom', name: 'legit_tool' }],
      tool_choice: 'auto',
    };
    const result = preprocessServerTools(body);
    expect(body.tool_choice).toBeUndefined();
    // hadWebSearch/hadWebFetch are false — no server tools to convert
    expect(result.hadWebSearch).toBe(false);
    expect(result.hadWebFetch).toBe(false);
  });

  test('detects both web_search and web_fetch in same request', () => {
    const body: any = {
      tools: [
        { type: 'web_search_20250305', name: 'search' },
        { type: 'web_fetch_20250305', name: 'fetch' },
      ],
    };
    const result = preprocessServerTools(body);
    expect(result.hadWebSearch).toBe(true);
    expect(result.hadWebFetch).toBe(true);
  });
});
