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

// -- Tool pre-execute + selective strip before forwarding --------------------
// Only web_search/web_fetch are pre-executed locally and stripped — they cause
// 400s on DeepSeek when forwarded as custom tools.
// text_editor, bash, code_execution etc. are converted to custom tools via
// convertServerTools and forwarded — DeepSeek typically accepts these.

describe('tool pre-execute + selective strip path', () => {

    test('web_search stripped, text_editor kept (not converted — passed through)', () => {
        const WEB_PREFIXES = ['web_search_', 'web_fetch_', 'url_fetch_'];
        const isWeb = (type: string) => WEB_PREFIXES.some(p => type.startsWith(p));
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
        const isWeb = (type: string) => WEB_PREFIXES.some(p => type.startsWith(p));
        const tools: any[] = [
            { type: 'web_search_20260209', name: 'web_search' },
            { type: 'web_fetch_20260209', name: 'web_fetch' },
        ];
        const stripped = tools.filter((t: any) => !isWeb(t.type));
        expect(stripped.length).toBe(0);
    });

    test('bash and text_editor pass through — only web tools are stripped', () => {
        const WEB_PREFIXES = ['web_search_', 'web_fetch_', 'url_fetch_'];
        const isWeb = (type: string) => WEB_PREFIXES.some(p => type.startsWith(p));
        const tools: any[] = [
            { type: 'bash_20250124', name: 'bash' },
            { type: 'text_editor_20250728', name: 'str_replace_based_edit_tool' },
        ];
        const kept = tools.filter((t: any) => !isWeb(t.type));
        expect(kept.length).toBe(2);  // Neither is a web tool — both pass through
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
