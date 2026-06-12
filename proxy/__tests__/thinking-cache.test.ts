'use strict';

import { store, injectThinkingBlocks, extractThinkingBlocks, Message } from '../thinking-cache';
import { sessionKey } from '../session-key';

// --- Helpers ---

function makeUserMsg(content: string): Message {
    return { role: 'user', content };
}

function makeAssistantMsg(content: Array<Record<string, unknown>>): Message {
    return { role: 'assistant', content };
}

// --- extractThinkingBlocks ---

describe('extractThinkingBlocks', () => {
    test('returns null for empty messages', () => {
        expect(extractThinkingBlocks([])).toBeNull();
    });

    test('returns null when no thinking blocks present', () => {
        const messages: Message[] = [
            makeUserMsg('what is the weather'),
            makeAssistantMsg([
                { type: 'text', text: 'Hello there!' },
            ]),
        ];
        expect(extractThinkingBlocks(messages)).toBeNull();
    });

    test('extracts thinking blocks with tool_use', () => {
        const messages: Message[] = [
            makeUserMsg('what is the weather'),
            makeAssistantMsg([
                { type: 'thinking', thinking: 'I need to check the weather API', signature: 'sig123' },
                { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: {} },
                { type: 'text', text: 'Let me check the weather' },
            ]),
        ];
        const result = extractThinkingBlocks(messages);

        expect(result).not.toBeNull();
        expect(result!.firstToolUseId).toBe('toolu_1');
        expect(result!.blocks).toHaveLength(1);
        expect(result!.blocks[0]).toMatchObject({
            type: 'thinking',
            thinking: 'I need to check the weather API',
            signature: 'sig123',
        });
        expect(typeof result!.sk).toBe('string');
        expect(result!.sk.length).toBeGreaterThan(0);
    });

    test('extracts multiple thinking blocks when present', () => {
        const messages: Message[] = [
            makeUserMsg('hello'),
            makeAssistantMsg([
                { type: 'thinking', thinking: 'First thought', signature: 'sig1' },
                { type: 'thinking', thinking: 'Second thought', signature: 'sig2' },
                { type: 'tool_use', id: 'toolu_multi', name: 'test', input: {} },
            ]),
        ];
        const result = extractThinkingBlocks(messages);
        expect(result).not.toBeNull();
        expect(result!.blocks).toHaveLength(2);
        expect(result!.blocks[0].thinking).toBe('First thought');
        expect(result!.blocks[1].thinking).toBe('Second thought');
    });

    test('returns null when thinking present but no tool_use', () => {
        const messages: Message[] = [
            makeUserMsg('just thinking'),
            makeAssistantMsg([
                { type: 'thinking', thinking: 'thinking without tools', signature: 'sig' },
                { type: 'text', text: 'my response' },
            ]),
        ];
        expect(extractThinkingBlocks(messages)).toBeNull();
    });

    test('returns null when tool_use present but no thinking', () => {
        const messages: Message[] = [
            makeUserMsg('tool only'),
            makeAssistantMsg([
                { type: 'tool_use', id: 'toolu_no_think', name: 'test', input: {} },
            ]),
        ];
        expect(extractThinkingBlocks(messages)).toBeNull();
    });

    test('handles messages with string content', () => {
        const messages: Message[] = [
            makeUserMsg('hello'),
            { role: 'assistant', content: 'a simple string response' },
        ];
        expect(extractThinkingBlocks(messages)).toBeNull();
    });

    test('handles null/undefined messages', () => {
        expect(extractThinkingBlocks(null as unknown as Message[])).toBeNull();
        expect(extractThinkingBlocks(undefined as unknown as Message[])).toBeNull();
    });

    test('scans all messages — picks the last with thinking + tool_use (backward scan)', () => {
        const messages: Message[] = [
            makeUserMsg('hello'),
            makeAssistantMsg([
                { type: 'thinking', thinking: 'first thinking', signature: 'sig1' },
                { type: 'tool_use', id: 'toolu_first', name: 'test', input: {} },
            ]),
            makeAssistantMsg([
                { type: 'thinking', thinking: 'second thinking', signature: 'sig2' },
                { type: 'tool_use', id: 'toolu_second', name: 'test', input: {} },
            ]),
        ];
        const result = extractThinkingBlocks(messages);
        expect(result).not.toBeNull();
        expect(result!.firstToolUseId).toBe('toolu_second');
    });

    test('skips assistant messages without tool_use blocks', () => {
        const messages: Message[] = [
            makeUserMsg('hello'),
            makeAssistantMsg([
                { type: 'thinking', thinking: 'orphan thinking', signature: 's1' },
                { type: 'text', text: 'no tools here' },
            ]),
            makeAssistantMsg([
                { type: 'thinking', thinking: 'valid thinking', signature: 's2' },
                { type: 'tool_use', id: 'toolu_valid', name: 'test', input: {} },
            ]),
        ];
        const result = extractThinkingBlocks(messages);
        expect(result).not.toBeNull();
        expect(result!.firstToolUseId).toBe('toolu_valid');
    });

    test('returns null when no user message exists (no session key)', () => {
        const messages: Message[] = [
            makeAssistantMsg([
                { type: 'thinking', thinking: 'thinking', signature: 'sig' },
                { type: 'tool_use', id: 'toolu_nouser', name: 'test', input: {} },
            ]),
        ];
        expect(extractThinkingBlocks(messages)).toBeNull();
    });
});

// --- store + injectThinkingBlocks ---

describe('store + injectThinkingBlocks', () => {
    test('injects stored thinking blocks when tool_use matches', () => {
        const messages: Message[] = [
            makeUserMsg('inject test'),
            makeAssistantMsg([
                { type: 'tool_use', id: 'toolu_inject', name: 'test_tool', input: {} },
            ]),
        ];
        const sk = sessionKey({ messages })!;

        store(sk, 'toolu_inject', [
            { type: 'thinking', thinking: 'cached thinking content', signature: 'sig_abc' },
        ], messages.length);

        const injected = injectThinkingBlocks(messages);
        expect(injected).toBe(1);

        const content = messages[1].content as Array<Record<string, unknown>>;
        expect(content).toHaveLength(2);
        expect(content[0]).toMatchObject({
            type: 'thinking',
            thinking: 'cached thinking content',
            signature: 'sig_abc',
        });
        expect(content[1]).toMatchObject({
            type: 'tool_use',
            id: 'toolu_inject',
        });
    });

    test('does not inject when message already has thinking', () => {
        const messages: Message[] = [
            makeUserMsg('already has thinking'),
            makeAssistantMsg([
                { type: 'thinking', thinking: 'existing thinking', signature: 'sig_existing' },
                { type: 'tool_use', id: 'toolu_existing', name: 'test', input: {} },
            ]),
        ];

        const injected = injectThinkingBlocks(messages);
        expect(injected).toBe(0);
        // Content should remain unchanged (thinking still at position 0)
        const content = messages[1].content as Array<Record<string, unknown>>;
        expect(content[0]).toMatchObject({ type: 'thinking', thinking: 'existing thinking' });
    });

    test('does not inject when no tool_use in message', () => {
        const messages: Message[] = [
            makeUserMsg('no tool use'),
            makeAssistantMsg([
                { type: 'text', text: 'just a plain text response' },
            ]),
        ];

        const injected = injectThinkingBlocks(messages);
        expect(injected).toBe(0);
    });

    test('returns count of injected messages', () => {
        const messages: Message[] = [
            makeUserMsg('count test'),
            makeAssistantMsg([
                { type: 'tool_use', id: 'toolu_count_1', name: 'tool1', input: {} },
            ]),
            makeAssistantMsg([
                { type: 'tool_use', id: 'toolu_count_2', name: 'tool2', input: {} },
            ]),
        ];
        const sk = sessionKey({ messages })!;

        store(sk, 'toolu_count_1', [
            { type: 'thinking', thinking: 'first cached thought', signature: 's1' },
        ], messages.length);
        store(sk, 'toolu_count_2', [
            { type: 'thinking', thinking: 'second cached thought', signature: 's2' },
        ], messages.length);

        const injected = injectThinkingBlocks(messages);
        expect(injected).toBe(2);

        const content1 = messages[1].content as Array<Record<string, unknown>>;
        expect(content1).toHaveLength(2);
        expect(content1[0]).toMatchObject({ type: 'thinking', thinking: 'first cached thought' });

        const content2 = messages[2].content as Array<Record<string, unknown>>;
        expect(content2).toHaveLength(2);
        expect(content2[0]).toMatchObject({ type: 'thinking', thinking: 'second cached thought' });
    });

    test('handles empty messages array', () => {
        expect(injectThinkingBlocks([])).toBe(0);
    });

    test('handles null/undefined messages', () => {
        expect(injectThinkingBlocks(null as unknown as Message[])).toBe(0);
        expect(injectThinkingBlocks(undefined as unknown as Message[])).toBe(0);
    });

    test('messageCount guard: does not inject when stored message count differs', () => {
        const messages: Message[] = [
            makeUserMsg('guard test'),
            makeAssistantMsg([
                { type: 'tool_use', id: 'toolu_guard', name: 'guard_tool', input: {} },
            ]),
        ];
        const sk = sessionKey({ messages })!;

        // Store with messageCount=99 — far larger than the actual 2 messages
        store(sk, 'toolu_guard', [
            { type: 'thinking', thinking: 'should not appear', signature: 'sig_g' },
        ], 99);

        const injected = injectThinkingBlocks(messages);
        expect(injected).toBe(0);
    });

    test('does not inject when no user message (no session key)', () => {
        const messages: Message[] = [
            makeAssistantMsg([
                { type: 'tool_use', id: 'toolu_nokey', name: 'test', input: {} },
            ]),
        ];
        const injected = injectThinkingBlocks(messages);
        expect(injected).toBe(0);
    });

    test('does not inject on cache miss (wrong tool id)', () => {
        const messages: Message[] = [
            makeUserMsg('cache miss'),
            makeAssistantMsg([
                { type: 'tool_use', id: 'toolu_miss', name: 'test', input: {} },
            ]),
        ];
        const sk = sessionKey({ messages })!;

        // Store for a different tool id
        store(sk, 'toolu_other', [
            { type: 'thinking', thinking: 'wrong tool', signature: 's1' },
        ], messages.length);

        const injected = injectThinkingBlocks(messages);
        expect(injected).toBe(0);
    });

    test('injects into correct message when multiple assistants present', () => {
        const messages: Message[] = [
            makeUserMsg('multi assistant'),
            makeAssistantMsg([
                { type: 'text', text: 'first response without tools' },
            ]),
            makeAssistantMsg([
                { type: 'tool_use', id: 'toolu_multi2', name: 'test', input: {} },
            ]),
        ];
        const sk = sessionKey({ messages })!;

        store(sk, 'toolu_multi2', [
            { type: 'thinking', thinking: 'injected thought', signature: 's1' },
        ], messages.length);

        const injected = injectThinkingBlocks(messages);
        expect(injected).toBe(1);

        // First assistant should be unchanged
        const content0 = messages[1].content as Array<Record<string, unknown>>;
        expect(content0).toHaveLength(1);
        expect(content0[0]).toMatchObject({ type: 'text', text: 'first response without tools' });

        // Second assistant should have thinking prepended
        const content1 = messages[2].content as Array<Record<string, unknown>>;
        expect(content1).toHaveLength(2);
        expect(content1[0]).toMatchObject({ type: 'thinking', thinking: 'injected thought' });
    });
});

// --- Integration: extract -> store -> inject round-trip ---

describe('integration: extract -> store -> inject', () => {
    test('full round-trip: extract thinking from response, inject on next request', () => {
        // Round-trip: extract thinking blocks from a response, store them,
        // then inject into the next request. The cache keys on sessionKey +
        // firstToolUseId only (no fingerprint), so the message window drift
        // between extraction and injection doesn't break the lookup.
        const responseMessages: Message[] = [
            makeUserMsg('what is the capital of France'),
            makeAssistantMsg([
                { type: 'thinking', thinking: 'I need to recall geographic knowledge.', signature: 'sig_geo' },
                { type: 'tool_use', id: 'toolu_france', name: 'get_capital', input: { country: 'France' } },
                { type: 'text', text: 'The capital is Paris' },
            ]),
        ];

        // Extract thinking blocks from the response
        const extracted = extractThinkingBlocks(responseMessages);
        expect(extracted).not.toBeNull();
        expect(extracted!.firstToolUseId).toBe('toolu_france');
        expect(extracted!.blocks).toHaveLength(1);
        expect(extracted!.blocks[0].thinking).toBe('I need to recall geographic knowledge.');

        // Request messages for the next turn (without thinking blocks)
        const requestMessages: Message[] = [
            makeUserMsg('what is the capital of France'),
            makeAssistantMsg([
                { type: 'tool_use', id: 'toolu_france', name: 'get_capital', input: { country: 'France' } },
            ]),
        ];

        store(extracted!.sk, extracted!.firstToolUseId, extracted!.blocks);

        // Inject thinking into request messages
        const injected = injectThinkingBlocks(requestMessages);
        expect(injected).toBe(1);

        const content = requestMessages[1].content as Array<Record<string, unknown>>;
        expect(content).toHaveLength(2);
        expect(content[0]).toMatchObject({
            type: 'thinking',
            thinking: 'I need to recall geographic knowledge.',
            signature: 'sig_geo',
        });
        expect(content[1]).toMatchObject({
            type: 'tool_use',
            id: 'toolu_france',
        });
    });

    test('regression: cache hit even when message window shifts between extract and inject', () => {
        // This directly reproduces the fingerprint-cache-miss bug:
        // Extract happens with messages [A, B, C], but injection happens
        // with messages [B, C, D] — different last-3-message windows.
        // The old fingerprint-based key would miss; the current UUID-based
        // key should hit regardless of the shifting window.
        const extractMessages: Message[] = [
            makeUserMsg('what is the capital of France'),
            makeAssistantMsg([
                { type: 'thinking', thinking: 'Let me look that up.', signature: 'sig1' },
                { type: 'tool_use', id: 'toolu_shift', name: 'search', input: {} },
            ]),
            makeUserMsg('thanks'),
        ];

        const extracted = extractThinkingBlocks(extractMessages);
        expect(extracted).not.toBeNull();
        store(extracted!.sk, extracted!.firstToolUseId, extracted!.blocks);

        // Next turn: different message window — last 3 are not the same
        const injectMessages: Message[] = [
            makeUserMsg('what is the capital of France'),
            makeAssistantMsg([
                { type: 'tool_use', id: 'toolu_shift', name: 'search', input: {} },
            ]),
            makeUserMsg('now ask a different follow-up question here'),
        ];
        // Before fix: computeFingerprint(extractMessages.slice(0,-1)) !=
        //   computeFingerprint(injectMessages) → cache miss → 0 injected
        // After fix: fingerprints ignored → cache hit → 1 injected
        const injected = injectThinkingBlocks(injectMessages);
        expect(injected).toBe(1);
    });
});
