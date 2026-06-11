'use strict';

import {
    isServerToolType,
    convertServerTools,
    hasPendingToolResult,
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

describe('convertServerTools', () => {
    test('converts web_search_ tool to custom', () => {
        const { tools, hasWebSearch, hasWebFetch } = convertServerTools([
            { type: 'web_search_20250101', name: 'web_search', description: 'Search' },
        ]);
        expect(hasWebSearch).toBe(true);
        expect(hasWebFetch).toBe(false);
        expect(tools[0].type).toBe('custom');
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
        expect(tools[0].type).toBe('custom');
        expect(tools[1].type).toBe('custom');
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
            { role: 'assistant', content: [{ type: 'tool_use', id: 'tool_1', name: 'web_search', input: { query: 'test' } }] },
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool_1', content: '' }] },
        ];
        const result = hasPendingToolResult(messages);
        expect(result.needsPopulation).toBe(true);
        expect(result.emptyResults).toHaveLength(1);
    });

    test('detects unrecognized tool_result for web_fetch', () => {
        const messages = [
            { role: 'assistant', content: [{ type: 'tool_use', id: 'tool_2', name: 'web_fetch', input: { url: 'https://example.com' } }] },
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool_2', content: 'No tool implementation found for web_fetch' }] },
        ];
        const result = hasPendingToolResult(messages);
        expect(result.needsPopulation).toBe(true);
    });

    test('returns false when all tool results are populated', () => {
        const messages = [
            { role: 'assistant', content: [{ type: 'tool_use', id: 'tool_3', name: 'web_search', input: { query: 'test' } }] },
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool_3', content: 'Here are the results...' }] },
        ];
        const result = hasPendingToolResult(messages);
        expect(result.needsPopulation).toBe(false);
    });

    test('returns false when no tool_use blocks exist', () => {
        const messages = [
            { role: 'user', content: 'Hello' },
        ];
        const result = hasPendingToolResult(messages);
        expect(result.needsPopulation).toBe(false);
    });

    test('handles null messages', () => {
        const result = hasPendingToolResult(null);
        expect(result.needsPopulation).toBe(false);
    });
});

// -- Tool-strip retry on 400 --------------------------------------------------
// Simulates the per-provider retry logic in start-proxy.ts: when a
// non-Anthropic provider returns HTTP 400 and the request had Anthropic
// server-side tools converted to custom tools, the proxy strips all tools
// and retries once.  The model answers from its own knowledge on the retry.

describe('400 tool-strip retry path', () => {

    test('convertServerTools flags web_search for strip-on-400', () => {
        const tools = [
            { type: 'web_search_20260209', name: 'web_search' },
            { type: 'text_editor_20250728', name: 'str_replace_based_edit_tool' },
        ];
        const conv = convertServerTools(tools);
        expect(conv.hasWebSearch).toBe(true);
        expect(conv.hasWebFetch).toBe(false);
        // Web search converted to custom, text editor left alone
        expect(conv.tools[0].type).toBe('custom');
        expect(conv.tools[0].name).toBe('web_search');
        expect(conv.tools[1].type).toBe('text_editor_20250728');
    });

    test('convertServerTools flags web_fetch for strip-on-400', () => {
        const tools = [
            { type: 'web_fetch_20260209', name: 'web_fetch' },
        ];
        const conv = convertServerTools(tools);
        expect(conv.hasWebFetch).toBe(true);
        expect(conv.tools[0].type).toBe('custom');
        expect(conv.tools[0].name).toBe('web_fetch');
    });

    test('retry condition: 400 + tools present + not yet stripped → retry', () => {
        const conv = convertServerTools([
            { type: 'web_search_20260209', name: 'web_search' },
        ]);
        const parsedBody: Record<string, unknown> = {
            model: 'test',
            messages: [{ role: 'user', content: 'search for cats' }],
            tools: conv.tools,
        };
        let toolsStripped = false;
        const status = 400;
        const modified = true;

        // Simulate the retry logic: first 400 → strip tools, retry
        const shouldRetry = status === 400 && modified && !toolsStripped
            && parsedBody.tools && Array.isArray(parsedBody.tools) && parsedBody.tools.length > 0;

        expect(shouldRetry).toBe(true);

        // Apply the fix
        toolsStripped = true;
        parsedBody.tools = undefined;

        // After stripping, a second 400 would NOT retry (toolsStripped is true)
        const shouldRetryAgain = status === 400 && modified && !toolsStripped
            && parsedBody.tools && Array.isArray(parsedBody.tools) && parsedBody.tools.length > 0;
        expect(shouldRetryAgain).toBe(false);
    });

    test('no retry on 400 when tools were already stripped', () => {
        const parsedBody: Record<string, unknown> = {
            model: 'test',
            messages: [{ role: 'user', content: 'hello' }],
            // tools already stripped
        };
        const toolsStripped = true;
        const modified = true;
        const shouldRetry = 400 === 400 && modified && !toolsStripped
            && parsedBody.tools && Array.isArray(parsedBody.tools) && (parsedBody.tools as any[]).length > 0;

        expect(shouldRetry).toBe(false);
    });

    test('no retry on 400 when tools were never present', () => {
        const parsedBody: Record<string, unknown> = {
            model: 'test',
            messages: [{ role: 'user', content: 'hello' }],
        };
        const toolsStripped = false;
        const modified = false; // No tools, nothing modified
        const shouldRetry = 400 === 400 && modified && !toolsStripped
            && parsedBody.tools && Array.isArray(parsedBody.tools) && (parsedBody.tools as any[]).length > 0;

        expect(shouldRetry).toBe(false);
    });

    test('no retry on 401 (auth failure — not a tool problem)', () => {
        const conv = convertServerTools([
            { type: 'web_search_20260209', name: 'web_search' },
        ]);
        const parsedBody: Record<string, unknown> = {
            model: 'test',
            messages: [{ role: 'user', content: 'search for cats' }],
            tools: conv.tools,
        };
        const toolsStripped = false;
        const modified = true;
        const shouldRetry = 401 === 400 && modified && !toolsStripped  // status is 401, not 400
            && parsedBody.tools && Array.isArray(parsedBody.tools) && (parsedBody.tools as any[]).length > 0;

        expect(shouldRetry).toBe(false);
    });
});
