'use strict';

import {
  isServerToolType,
  convertServerTools,
  preprocessServerTools,
  hasPendingToolResult,
  populateToolResults,
  redditSearch,
} from '../server-tools';

// --- Mocks ---
// redditSearch uses simpleHttpGet which calls http.get (SearXNG, port 8888)
// and https.get (old.reddit.com). We mock both.

const mockHttpGet = jest.fn();
const mockHttpsGet = jest.fn();

jest.mock('http', () => ({
  ...jest.requireActual('http'),
  get: (...args: any[]) => mockHttpGet(...args),
}));

jest.mock('https', () => ({
  ...jest.requireActual('https'),
  get: (...args: any[]) => mockHttpsGet(...args),
}));

// Prevent Registry reads
jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  execSync: jest.fn().mockImplementation(() => {
    throw new Error('not found');
  }),
}));

// --- Helpers ---

interface MockReq {
  on: jest.Mock;
  destroy: jest.Mock;
}

function _makeMockStream(): { listeners: Record<string, Array<(...args: any[]) => void>> } {
  return { listeners: {} };
}

function mockHttpGetOnce(
  urlMatcher: RegExp,
  statusCode: number,
  body: string,
  contentType?: string,
): void {
  mockHttpGet.mockImplementationOnce((url: string, opts: any, cb?: any) => {
    // Support both (url, cb) and (url, opts, cb) signatures
    const callback = typeof opts === 'function' ? opts : cb;
    if (callback && typeof callback === 'function') {
      const res = {
        statusCode,
        headers: { 'content-type': contentType || 'text/html' },
        on: (event: string, handler: (...args: any[]) => void) => {
          if (event === 'data') handler(Buffer.from(body));
          if (event === 'end') handler();
          return res;
        },
        destroy: () => {},
      };
      setTimeout(() => callback(res), 0);
    }
    const req: MockReq = {
      on: jest.fn().mockReturnThis(),
      destroy: jest.fn(),
    };
    return req;
  });
}

function mockHttpsGetOnce(urlMatcher: RegExp, statusCode: number, body: string): void {
  mockHttpsGet.mockImplementationOnce((url: string, opts: any, cb?: any) => {
    const callback = typeof opts === 'function' ? opts : cb;
    if (callback && typeof callback === 'function') {
      const res = {
        statusCode,
        headers: {},
        on: (event: string, handler: (...args: any[]) => void) => {
          if (event === 'data') handler(Buffer.from(body));
          if (event === 'end') handler();
          return res;
        },
        destroy: () => {},
      };
      setTimeout(() => callback(res), 0);
    }
    const req: MockReq = {
      on: jest.fn().mockReturnThis(),
      destroy: jest.fn(),
    };
    return req;
  });
}

// Sample SearXNG JSON response for a Reddit search
const SAMPLE_SEARXNG_JSON = JSON.stringify({
  query: 'site:reddit.com deepseek',
  results: [
    {
      title: 'r/ClaudeCode: DeepClaude: full Claude Code agent loop on DeepSeek V4 Pro',
      url: 'https://www.reddit.com/r/ClaudeCode/comments/1t3hrcx/deepclaude_full_claude_code_agent_loop_on/',
      content:
        'DeepClaude works by intercepting Claude Code environment variables at session start.',
    },
    {
      title: 'r/ChatGPTCoding: DeepClaude (deepseek + sonnet) ???',
      url: 'https://www.reddit.com/r/ChatGPTCoding/comments/1ii93ee/deepclaude_deepseek_sonnet/',
      content: 'Anyone try to develop it from deepseek + sonnet?',
    },
  ],
});

// Sample old.reddit.com HTML for a post
const SAMPLE_OLDREDDIT_HTML = `
<html>
<body>
  <a class="title may-blank " data-event-action="title" href="/r/ClaudeCode/comments/1t3hrcx/deepclaude_full_claude_code_agent_loop_on/" tabindex="1">DeepClaude: full Claude Code agent loop on DeepSeek V4 Pro</a>
  <div data-score="99" data-comments-count="49">
    <form action="#" class="usertext warn-on-unload" onsubmit="return post_form(this, 'editusertext')" id="form-t3_1t3hrcxuso">
    <input type="hidden" name="thing_id" value="t3_1t3hrcx"/>
    <div class="usertext-body may-blank-within md-container ">
      <div class="md">
        <p>DeepClaude works by intercepting Claude Code's Anthropic environment variables at session start, routing inference through a local proxy on localhost:3200.</p>
        <p>The full Claude Code agent loop stays intact.</p>
      </div>
    </div>
    </form>
  </div>
  <div class="comment">
    <form action="#" class="usertext warn-on-unload" onsubmit="return post_form(this, 'editusertext')" id="form-t1_abc123uso">
    <input type="hidden" name="thing_id" value="t1_abc123"/>
    <div class="usertext-body may-blank-within md-container ">
      <div class="md">
        <p>This is a great solution for saving on API costs.</p>
      </div>
    </div>
    </form>
  </div>
  <div class="comment">
    <form action="#" class="usertext warn-on-unload" onsubmit="return post_form(this, 'editusertext')" id="form-t1_def456uso">
    <input type="hidden" name="thing_id" value="t1_def456"/>
    <div class="usertext-body may-blank-within md-container ">
      <div class="md">
        <p>How does this compare to just using DeepSeek directly?</p>
      </div>
    </div>
    </form>
  </div>
</body>
</html>
`;

// Sample old.reddit.com HTML for a post with no comments
const SAMPLE_OLDREDDIT_MINIMAL_HTML = `
<html>
<body>
  <a class="title may-blank " href="/r/test/comments/abc123/test/" tabindex="1">Test Post Title</a>
  <div data-score="5" data-comments-count="0">
    <form action="#" class="usertext warn-on-unload" onsubmit="return post_form(this, 'editusertext')" id="form-t3_abc123uso">
    <input type="hidden" name="thing_id" value="t3_abc123"/>
    <div class="usertext-body may-blank-within md-container ">
      <div class="md">
        <p>This is a test post with no comments.</p>
      </div>
    </div>
    </form>
  </div>
</body>
</html>
`;

// --- reset between tests ---
beforeEach(() => {
  mockHttpGet.mockReset();
  mockHttpsGet.mockReset();
});

// ============================================================================
// isServerToolType
// ============================================================================
describe('isServerToolType — reddit_search_', () => {
  it('returns true for reddit_search_ prefix', () => {
    expect(isServerToolType('reddit_search_')).toBe(true);
    expect(isServerToolType('reddit_search_default')).toBe(true);
  });

  it('returns false for similar but different prefixes', () => {
    expect(isServerToolType('reddit_')).toBe(false);
    expect(isServerToolType('search_reddit_')).toBe(false);
    expect(isServerToolType('')).toBe(false);
    expect(isServerToolType(null)).toBe(false);
    expect(isServerToolType(undefined)).toBe(false);
  });
});

// ============================================================================
// convertServerTools
// ============================================================================
describe('convertServerTools — reddit_search_', () => {
  it('converts reddit_search_ tool types to reddit_search', () => {
    const tools = [{ type: 'reddit_search_default', name: 'reddit_search_default' }];
    const result = convertServerTools(tools as any);
    expect(result.hasRedditSearch).toBe(true);
    expect(result.tools).toBeDefined();
    expect(result.tools!.length).toBe(1);
    expect((result.tools![0] as any).name).toBe('reddit_search');
    expect((result.tools![0] as any).input_schema).toBeDefined();
    expect((result.tools![0] as any).input_schema.properties.query.type).toBe('string');
  });

  it('passes through non-reddit tools unchanged', () => {
    const tools = [{ type: 'custom_tool', name: 'my_tool' }];
    const result = convertServerTools(tools as any);
    expect(result.hasRedditSearch).toBe(false);
    expect((result.tools![0] as any).name).toBe('my_tool');
  });

  it('handles null/undefined/empty inputs', () => {
    expect(convertServerTools(null).hasRedditSearch).toBe(false);
    expect(convertServerTools(undefined).hasRedditSearch).toBe(false);
    expect(convertServerTools([]).hasRedditSearch).toBe(false);
  });

  it('sets hasRedditSearch alongside hasWebSearch/hasWebFetch', () => {
    const tools = [{ type: 'web_search_default' }, { type: 'reddit_search_default' }];
    const result = convertServerTools(tools as any);
    expect(result.hasWebSearch).toBe(true);
    expect(result.hasRedditSearch).toBe(true);
  });
});

// ============================================================================
// preprocessServerTools
// ============================================================================
describe('preprocessServerTools — reddit_search_', () => {
  it('tracks hadRedditSearch after conversion', () => {
    const body = {
      tools: [{ type: 'reddit_search_default', name: 'reddit_search_default' } as any],
    };
    const result = preprocessServerTools(body);
    expect(result.hadRedditSearch).toBe(true);
    expect(result.modified).toBe(true);
  });

  it('returns hadRedditSearch=false and modified=true when no reddit tools present', () => {
    const body = {
      tools: [{ type: 'custom_tool', name: 'my_tool' } as any],
    };
    const result = preprocessServerTools(body);
    expect(result.hadRedditSearch).toBe(false);
    // modified=true because .map() always creates a new array
    expect(result.modified).toBe(true);
  });

  it('works alongside web_search tools', () => {
    const body = {
      tools: [{ type: 'web_search_default' as any }, { type: 'reddit_search_default' as any }],
    };
    const result = preprocessServerTools(body);
    expect(result.hadWebSearch).toBe(true);
    expect(result.hadRedditSearch).toBe(true);
  });
});

// ============================================================================
// redditSearch
// ============================================================================
describe('redditSearch', () => {
  it('returns error for empty query', async () => {
    const result = await redditSearch('');
    expect(result).toContain('Error');
  });

  it('returns error for non-string query', async () => {
    const result = await redditSearch(null as any);
    expect(result).toContain('Error');
  });

  it('returns error when SearXNG request fails (http.get returns error)', async () => {
    mockHttpGet.mockImplementationOnce((url: string, opts: any, cb?: any) => {
      const callback = typeof opts === 'function' ? opts : cb;
      if (!callback) {
        const req: MockReq = { on: jest.fn().mockReturnThis(), destroy: jest.fn() };
        setTimeout(
          () =>
            req.on.mock.calls.some((c: any) => c[0] === 'error') &&
            req.on.mock.calls.find((c: any) => c[0] === 'error')[1](),
          0,
        );
        return req;
      }
      const req: MockReq = { on: jest.fn().mockReturnThis(), destroy: jest.fn() };
      req.on.mockImplementation((event: string, handler: any) => {
        if (event === 'error') setTimeout(() => handler(new Error('connection refused')), 0);
        return req;
      });
      return req;
    });

    const result = await redditSearch('test query');
    expect(result).toContain('Error');
  });

  it('returns error when SearXNG returns non-200', async () => {
    mockHttpGetOnce(/localhost:8888/, 500, 'Internal Server Error');

    const result = await redditSearch('test');
    expect(result).toContain('Error');
    expect(result).toContain('500');
  });

  it('returns no results when SearXNG returns empty result set', async () => {
    const emptyJson = JSON.stringify({ query: 'site:reddit.com nothing', results: [] });
    mockHttpGetOnce(/localhost:8888/, 200, emptyJson, 'application/json');

    const result = await redditSearch('nothing');
    expect(result).toContain('No Reddit results found');
  });

  it('returns search results and fetches top post from old.reddit.com', async () => {
    // Step 1: SearXNG search succeeds
    mockHttpGetOnce(/localhost:8888/, 200, SAMPLE_SEARXNG_JSON, 'application/json');
    // Step 2: old.reddit.com fetch succeeds
    mockHttpsGetOnce(/old.reddit.com/, 200, SAMPLE_OLDREDDIT_HTML);

    const result = await redditSearch('deepseek');

    // Check search results appear
    expect(result).toContain('r/ClaudeCode');
    expect(result).toContain('DeepClaude');
    expect(result).toContain('r/ChatGPTCoding');

    // Check full post content
    expect(result).toContain('DeepClaude works by intercepting');
    expect(result).toContain('Score: 99');
    expect(result).toContain('Comments: 49');

    // Check comments
    expect(result).toContain('great solution for saving on API costs');
    expect(result).toContain('compare to just using DeepSeek');
  });

  it('handles old.reddit.com fetch failure gracefully', async () => {
    // Step 1: SearXNG succeeds
    mockHttpGetOnce(/localhost:8888/, 200, SAMPLE_SEARXNG_JSON, 'application/json');
    // Step 2: old.reddit.com fails
    mockHttpsGetOnce(/old.reddit.com/, 503, 'Service Unavailable');

    const result = await redditSearch('deepseek');

    // Should still show search results
    expect(result).toContain('r/ClaudeCode');
    expect(result).toContain('failed to fetch post content');
  });

  it('handles non-reddit URLs being filtered out', async () => {
    const jsonWithNonReddit = JSON.stringify({
      results: [
        { title: 'Google', url: 'https://google.com', content: 'google' },
        {
          title: 'Reddit Post',
          url: 'https://www.reddit.com/r/test/comments/abc/test/',
          content: 'test',
        },
      ],
    });
    mockHttpGetOnce(/localhost:8888/, 200, jsonWithNonReddit, 'application/json');
    mockHttpsGetOnce(/old.reddit.com/, 200, SAMPLE_OLDREDDIT_MINIMAL_HTML);

    const result = await redditSearch('test');
    // Only the Reddit URL should appear
    expect(result).toContain('Reddit Post');
    expect(result).not.toContain('Google');
  });

  it('handles SearXNG JSON parse failure', async () => {
    mockHttpGetOnce(/localhost:8888/, 200, 'not valid json{{{', 'application/json');

    const result = await redditSearch('deepseek');
    expect(result).toContain('Error');
    expect(result).toContain('Failed to parse');
  });
});

// ============================================================================
// hasPendingToolResult — reddit_search_ detection
// ============================================================================
describe('hasPendingToolResult — reddit_search_', () => {
  it('detects reddit_search tool_use blocks', () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', name: 'reddit_search', id: 'rs_1', input: { query: 'deepseek' } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'rs_1', content: '' }] },
    ];
    const result = hasPendingToolResult(messages as any);
    expect(result.needsPopulation).toBe(true);
    expect(result.emptyResults!.length).toBe(1);
    expect(result.emptyResults![0].toolInfo.name).toBe('reddit_search');
  });

  it('detects reddit_search_default tool_use blocks', () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', name: 'reddit_search_default', id: 'rs_2', input: { query: 'test' } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'rs_2', content: '' }] },
    ];
    const result = hasPendingToolResult(messages as any);
    expect(result.needsPopulation).toBe(true);
  });

  it('does not flag populated reddit_search results', () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', name: 'reddit_search', id: 'rs_3', input: { query: 'test' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'rs_3', content: 'Here are the results...' }],
      },
    ];
    const result = hasPendingToolResult(messages as any);
    expect(result.needsPopulation).toBe(false);
  });
});

// ============================================================================
// populateToolResults — reddit_search_ execution
// ============================================================================
describe('populateToolResults — reddit_search_', () => {
  it('populates empty reddit_search tool results', async () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            name: 'reddit_search',
            id: 'rs_pop_1',
            input: { query: 'deepseek coding' },
          },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'rs_pop_1', content: '' }] },
    ];

    // Mock the network calls that redditSearch will make
    mockHttpGetOnce(/localhost:8888/, 200, SAMPLE_SEARXNG_JSON, 'application/json');
    mockHttpsGetOnce(/old.reddit.com/, 200, SAMPLE_OLDREDDIT_HTML);

    const result = await populateToolResults(messages as any);
    expect(result).toBe(true);

    // The block should now have content
    const toolResult = (messages[1] as any).content[0];
    expect(toolResult.content).toBeDefined();
    expect(typeof toolResult.content).toBe('string');
    expect(toolResult.content).toContain('r/ClaudeCode');
    expect(toolResult.content).toContain('DeepClaude works by intercepting');
  });

  it('handles no results gracefully', async () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            name: 'reddit_search',
            id: 'rs_empty',
            input: { query: 'xyzzy_nonexistent' },
          },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'rs_empty', content: '' }] },
    ];

    mockHttpGetOnce(/localhost:8888/, 200, JSON.stringify({ results: [] }), 'application/json');

    const result = await populateToolResults(messages as any);
    expect(result).toBe(true);

    const toolResult = (messages[1] as any).content[0];
    expect(toolResult.content).toContain('No Reddit results found');
  });

  it('returns false when no empty results need population', async () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', name: 'reddit_search', id: 'rs_filled', input: { query: 'test' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'rs_filled', content: 'Already populated content' },
        ],
      },
    ];

    const result = await populateToolResults(messages as any);
    expect(result).toBe(false);
  });
});
