'use strict'

import { sessionKey, extractReasoningContent, store, get, reinjectReasoningContent } from '../reasoning-cache'

interface ToolCall {
    id: string;
    type: string;
    function: { name: string; arguments: string };
}

interface Message {
    role: string;
    content?: string | Array<{ type: string; text?: string }>;
    tool_calls?: ToolCall[];
    reasoning_content?: string;
}

function userMsg(content: string): Message {
    return { role: 'user', content }
}

function asstMsg(content: string, toolCalls: ToolCall[] | null, reasoningContent?: string): Message {
    const msg: Message = { role: 'assistant', content }
    if (toolCalls) msg.tool_calls = toolCalls
    if (reasoningContent) msg.reasoning_content = reasoningContent
    return msg
}

function toolCall(id: string): ToolCall {
    return { id, type: 'function', function: { name: 'test_func', arguments: '{}' } }
}

function generateBody(messages: Message[]): { messages: Message[] } {
    return { messages }
}

describe('sessionKey', () => {
    test('returns null for null body', () => {
        expect(sessionKey(null)).toBeNull()
    })

    test('returns null for body without messages', () => {
        expect(sessionKey({})).toBeNull()
    })

    test('returns null when no user message exists', () => {
        expect(sessionKey(generateBody([asstMsg('hello', null)]))).toBeNull()
    })

    test('produces a 32-char hex key from user message content', () => {
        const sk = sessionKey(generateBody([userMsg('hello world')]))
        expect(sk).toEqual(expect.any(String))
        expect(sk.length).toBe(32)
    })

    test('produces same key for same content', () => {
        const a = sessionKey(generateBody([userMsg('same text')]))
        const b = sessionKey(generateBody([userMsg('same text')]))
        expect(a).toBe(b)
    })

    test('produces different key for different content', () => {
        const a = sessionKey(generateBody([userMsg('text a')]))
        const b = sessionKey(generateBody([userMsg('text b')]))
        expect(a).not.toBe(b)
    })
})

describe('extractReasoningContent', () => {
    test('finds reasoning_content on last assistant message with tool_calls', () => {
        const messages = [
            userMsg('what is the weather'),
            asstMsg('Let me check', [toolCall('call_1')], 'First, I need to look up weather data.'),
        ]
        const result = extractReasoningContent(messages)
        expect(result).not.toBeNull()
        expect(result!.sk).toEqual(expect.any(String))
        expect(result!.firstToolCallId).toBe('call_1')
        expect(result!.reasoningContent).toBe('First, I need to look up weather data.')
    })

    test('returns null when no reasoning_content present', () => {
        const messages = [
            userMsg('hello'),
            asstMsg('hi', [toolCall('call_1')]),
        ]
        expect(extractReasoningContent(messages)).toBeNull()
    })

    test('returns null when no tool_calls present', () => {
        const messages = [
            userMsg('hello'),
            asstMsg('hi there', null, 'thinking text without tools'),
        ]
        expect(extractReasoningContent(messages)).toBeNull()
    })

    test('returns null for empty tool_calls array', () => {
        const messages = [
            userMsg('hello'),
            asstMsg('hi', [], 'thinking without actual tools'),
        ]
        expect(extractReasoningContent(messages as Message[])).toBeNull()
    })

    test('returns null for null messages', () => {
        expect(extractReasoningContent(null)).toBeNull()
    })

    test('returns null for empty messages array', () => {
        expect(extractReasoningContent([])).toBeNull()
    })

    test('scans from the end — picks last assistant with reasoning', () => {
        const messages = [
            userMsg('hello'),
            asstMsg('first response', [toolCall('call_1')], 'reasoning 1'),
            asstMsg('second response', [toolCall('call_2')], 'reasoning 2'),
        ]
        const result = extractReasoningContent(messages)
        expect(result).not.toBeNull()
        expect(result!.firstToolCallId).toBe('call_2')
        expect(result!.reasoningContent).toBe('reasoning 2')
    })

    test('skips assistant messages without tool_calls', () => {
        const messages = [
            userMsg('hello'),
            asstMsg('plain response without tools', null, 'some reasoning'),
            asstMsg('response with tools', [toolCall('call_3')], 'valid reasoning'),
        ]
        const result = extractReasoningContent(messages)
        expect(result).not.toBeNull()
        expect(result!.firstToolCallId).toBe('call_3')
    })

    test('works with Anthropic-format content arrays for user messages', () => {
        const messages = [
            { role: 'user', content: [{ type: 'text', text: 'hello from blocks' }] },
            asstMsg('response', [toolCall('call_4')], 'reasoning text'),
        ]
        const result = extractReasoningContent(messages)
        expect(result).not.toBeNull()
        expect(result!.firstToolCallId).toBe('call_4')
        expect(result!.reasoningContent).toBe('reasoning text')
    })
})

describe('store and get', () => {
    test('store and get round-trip', () => {
        store('sk_test', 'call_roundtrip', 'some reasoning content')
        expect(get('sk_test', 'call_roundtrip')).toBe('some reasoning content')
    })

    test('get returns undefined for missing key', () => {
        expect(get('sk_unknown', 'call_unknown')).toBeUndefined()
    })

    test('get returns undefined for wrong firstToolCallId', () => {
        store('sk_test2', 'call_a', 'reasoning a')
        expect(get('sk_test2', 'call_b')).toBeUndefined()
    })

    test('store with null params does nothing', () => {
        store(null, 'call_1', 'content')
        store('sk', null, 'content')
        store('sk', 'call_1', null)
        expect(get(null, 'call_1')).toBeUndefined()
    })

    test('get with null params returns undefined', () => {
        expect(get(null, 'call_1')).toBeUndefined()
        expect(get('sk', null)).toBeUndefined()
    })

    test('different keys store independently', () => {
        store('sk_a', 'call_1', 'content a')
        store('sk_b', 'call_1', 'content b')
        expect(get('sk_a', 'call_1')).toBe('content a')
        expect(get('sk_b', 'call_1')).toBe('content b')
    })
})

describe('reinjectReasoningContent', () => {
    test('adds missing reasoning_content from cache', () => {
        const body = generateBody([userMsg('inject test')])
        const sk = sessionKey(body)
        store(sk, 'call_inject', 'cached reasoning')

        const messages = [
            userMsg('inject test'),
            asstMsg('tool response', [toolCall('call_inject')]),
        ]
        const result = reinjectReasoningContent(messages)
        expect(result.modified).toBe(true)
        expect(result.messages[1].reasoning_content).toBe('cached reasoning')
    })

    test('returns modified: false when reasoning_content already present', () => {
        const messages = [
            userMsg('already has it'),
            asstMsg('has reasoning', [toolCall('call_present')], 'already here'),
        ]
        const result = reinjectReasoningContent(messages)
        expect(result.modified).toBe(false)
        expect(result.messages[1].reasoning_content).toBe('already here')
    })

    test('returns modified: false for empty messages array', () => {
        const result = reinjectReasoningContent([])
        expect(result.modified).toBe(false)
        expect(result.messages).toEqual([])
    })

    test('returns modified: false for null messages', () => {
        const result = reinjectReasoningContent(null)
        expect(result.modified).toBe(false)
        expect(result.messages).toBeNull()
    })

    test('does not inject for non-assistant messages', () => {
        const body = generateBody([userMsg('non-asst')])
        const sk = sessionKey(body)
        store(sk, 'call_user', 'should not appear')

        const messages: Message[] = [
            userMsg('non-asst'),
            { role: 'user', content: 'user tool result', tool_calls: [toolCall('call_user')] },
        ]
        const result = reinjectReasoningContent(messages)
        expect(result.modified).toBe(false)
    })

    test('does not inject when cache miss', () => {
        const messages = [
            userMsg('cache miss'),
            asstMsg('no cache', [toolCall('call_miss')]),
        ]
        const result = reinjectReasoningContent(messages)
        expect(result.modified).toBe(false)
    })

    test('multiple assistant turns — injects only cached ones', () => {
        const body = generateBody([userMsg('multi-turn')])
        const sk = sessionKey(body)
        store(sk, 'call_first', 'first reasoning')

        const messages = [
            userMsg('multi-turn'),
            asstMsg('first turn', [toolCall('call_first')]),
            asstMsg('second turn', [toolCall('call_second')]),
        ]
        const result = reinjectReasoningContent(messages)
        expect(result.modified).toBe(true)
        expect(result.messages[1].reasoning_content).toBe('first reasoning')
        expect(result.messages[2].reasoning_content).toBeUndefined()
    })

    test('all messages processed regardless of position', () => {
        const body = generateBody([userMsg('all-positions')])
        const sk = sessionKey(body)
        store(sk, 'call_pos_1', 'pos 1')
        store(sk, 'call_pos_2', 'pos 2')

        const messages = [
            userMsg('all-positions'),
            asstMsg('first tool', [toolCall('call_pos_1')]),
            asstMsg('second tool', [toolCall('call_pos_2')]),
        ]
        const result = reinjectReasoningContent(messages)
        expect(result.modified).toBe(true)
        expect(result.messages[1].reasoning_content).toBe('pos 1')
        expect(result.messages[2].reasoning_content).toBe('pos 2')
    })
})

describe('integration: extract → store → reinject round-trip', () => {
    test('full flow: extract reasoning from response, reinject on next request', () => {
        const messages = [
            userMsg('what is the capital of France'),
            asstMsg('The capital is Paris', [toolCall('call_france')], 'I need to recall geographic knowledge.'),
        ]

        const extracted = extractReasoningContent(messages)
        expect(extracted).not.toBeNull()
        expect(extracted!.firstToolCallId).toBe('call_france')
        expect(extracted!.reasoningContent).toBe('I need to recall geographic knowledge.')

        store(extracted!.sk, extracted!.firstToolCallId, extracted!.reasoningContent)
        expect(get(extracted!.sk, extracted!.firstToolCallId)).toBe('I need to recall geographic knowledge.')

        const nextRequestMessages = [
            userMsg('what is the capital of France'),
            asstMsg('The capital is Paris', [toolCall('call_france')]),
        ]

        const reinjected = reinjectReasoningContent(nextRequestMessages)
        expect(reinjected.modified).toBe(true)
        expect(reinjected.messages[1].reasoning_content).toBe('I need to recall geographic knowledge.')
    })
})
