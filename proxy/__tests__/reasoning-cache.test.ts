'use strict';

import {
  sessionKey,
  extractReasoningContent,
  store,
  reinjectReasoningContent,
} from '../reasoning-cache';

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
  return { role: 'user', content };
}

function asstMsg(
  content: string,
  toolCalls: ToolCall[] | null,
  reasoningContent?: string,
): Message {
  const msg: Message = { role: 'assistant', content };
  if (toolCalls) msg.tool_calls = toolCalls;
  if (reasoningContent) msg.reasoning_content = reasoningContent;
  return msg;
}

function toolCall(id: string): ToolCall {
  return { id, type: 'function', function: { name: 'test_func', arguments: '{}' } };
}

function generateBody(messages: Message[]): { messages: Message[] } {
  return { messages };
}

describe('sessionKey', () => {
  test('returns null for null body', () => {
    expect(sessionKey(null)).toBeNull();
  });

  test('returns null for body without messages', () => {
    expect(sessionKey({})).toBeNull();
  });

  test('returns null when no user message exists', () => {
    expect(sessionKey(generateBody([asstMsg('hello', null)]))).toBeNull();
  });

  test('produces a 32-char hex key from user message content', () => {
    const sk = sessionKey(generateBody([userMsg('hello world')]));
    expect(sk).toEqual(expect.any(String));
    expect(sk.length).toBe(32);
  });

  test('produces same key for same content', () => {
    const a = sessionKey(generateBody([userMsg('same text')]));
    const b = sessionKey(generateBody([userMsg('same text')]));
    expect(a).toBe(b);
  });

  test('produces different key for different content', () => {
    const a = sessionKey(generateBody([userMsg('text a')]));
    const b = sessionKey(generateBody([userMsg('text b')]));
    expect(a).not.toBe(b);
  });
});

describe('extractReasoningContent', () => {
  test('finds reasoning_content on last assistant message with tool_calls', () => {
    const messages = [
      userMsg('what is the weather'),
      asstMsg('Let me check', [toolCall('call_1')], 'First, I need to look up weather data.'),
    ];
    const result = extractReasoningContent(messages);
    expect(result).not.toBeNull();
    expect(result!.sk).toEqual(expect.any(String));
    expect(result!.firstToolCallId).toBe('call_1');
    expect(result!.reasoningContent).toBe('First, I need to look up weather data.');
  });

  test('returns null when no reasoning_content present', () => {
    const messages = [userMsg('hello'), asstMsg('hi', [toolCall('call_1')])];
    expect(extractReasoningContent(messages)).toBeNull();
  });

  test('returns null when no tool_calls present', () => {
    const messages = [userMsg('hello'), asstMsg('hi there', null, 'thinking text without tools')];
    expect(extractReasoningContent(messages)).toBeNull();
  });

  test('returns null for empty tool_calls array', () => {
    const messages = [userMsg('hello'), asstMsg('hi', [], 'thinking without actual tools')];
    expect(extractReasoningContent(messages as Message[])).toBeNull();
  });

  test('returns null for null messages', () => {
    expect(extractReasoningContent(null)).toBeNull();
  });

  test('returns null for empty messages array', () => {
    expect(extractReasoningContent([])).toBeNull();
  });

  test('scans from the end — picks last assistant with reasoning', () => {
    const messages = [
      userMsg('hello'),
      asstMsg('first response', [toolCall('call_1')], 'reasoning 1'),
      asstMsg('second response', [toolCall('call_2')], 'reasoning 2'),
    ];
    const result = extractReasoningContent(messages);
    expect(result).not.toBeNull();
    expect(result!.firstToolCallId).toBe('call_2');
    expect(result!.reasoningContent).toBe('reasoning 2');
  });

  test('skips assistant messages without tool_calls', () => {
    const messages = [
      userMsg('hello'),
      asstMsg('plain response without tools', null, 'some reasoning'),
      asstMsg('response with tools', [toolCall('call_3')], 'valid reasoning'),
    ];
    const result = extractReasoningContent(messages);
    expect(result).not.toBeNull();
    expect(result!.firstToolCallId).toBe('call_3');
  });

  test('works with Anthropic-format content arrays for user messages', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'hello from blocks' }] },
      asstMsg('response', [toolCall('call_4')], 'reasoning text'),
    ];
    const result = extractReasoningContent(messages);
    expect(result).not.toBeNull();
    expect(result!.firstToolCallId).toBe('call_4');
    expect(result!.reasoningContent).toBe('reasoning text');
  });
});

describe('store and retrieve (via reinjectReasoningContent)', () => {
  test('store and reinject round-trip', () => {
    const messages = [
      userMsg('round-trip test'),
      asstMsg('response', [toolCall('call_roundtrip')]),
    ];
    const sk = sessionKey(generateBody(messages))!;
    store(sk, 'call_roundtrip', 'some reasoning content');

    const result = reinjectReasoningContent(messages);
    expect(result.modified).toBe(true);
    expect(result.messages[1].reasoning_content).toBe('some reasoning content');
  });

  test('cache works regardless of conversation context (no fingerprint)', () => {
    const messages = [userMsg('cache no fp test'), asstMsg('response', [toolCall('call_nofp')])];
    const sk = sessionKey(generateBody(messages))!;
    // Cache keys on sessionKey + firstToolCallId only (UUID is unique).
    // No fingerprint needed — the old fingerprint-based cache had a bug
    // where extraction and injection computed different fps across turns.
    store(sk, 'call_nofp', 'reasoning');

    const result = reinjectReasoningContent(messages);
    expect(result.modified).toBe(true);
    expect(result.messages[1].reasoning_content).toBe('reasoning');
  });

  test('store with null params does nothing', () => {
    store(null, 'call_1', 'content');
    store('sk', null, 'content');
    store('sk', 'call_1', null);
    const result = reinjectReasoningContent([userMsg('test'), asstMsg('r', [toolCall('call_1')])]);
    expect(result.modified).toBe(false);
  });

  test('different session keys store independently', () => {
    const messagesA = [userMsg('user a'), asstMsg('r', [toolCall('call_1')])];
    const messagesB = [userMsg('user b'), asstMsg('r', [toolCall('call_1')])];
    const skA = sessionKey(generateBody(messagesA))!;
    const skB = sessionKey(generateBody(messagesB))!;

    store(skA, 'call_1', 'content a');
    store(skB, 'call_1', 'content b');

    const resultA = reinjectReasoningContent(messagesA);
    expect(resultA.modified).toBe(true);
    expect(resultA.messages[1].reasoning_content).toBe('content a');

    const resultB = reinjectReasoningContent(messagesB);
    expect(resultB.modified).toBe(true);
    expect(resultB.messages[1].reasoning_content).toBe('content b');
  });
});

describe('reinjectReasoningContent', () => {
  test('adds missing reasoning_content from cache', () => {
    const messages = [userMsg('inject test')];
    const sk = sessionKey(generateBody(messages))!;

    const requestMessages = [
      userMsg('inject test'),
      asstMsg('tool response', [toolCall('call_inject')]),
    ];
    store(sk, 'call_inject', 'cached reasoning');

    const result = reinjectReasoningContent(requestMessages);
    expect(result.modified).toBe(true);
    expect(result.messages[1].reasoning_content).toBe('cached reasoning');
  });

  test('returns modified: false when reasoning_content already present', () => {
    const messages = [
      userMsg('already has it'),
      asstMsg('has reasoning', [toolCall('call_present')], 'already here'),
    ];
    const result = reinjectReasoningContent(messages);
    expect(result.modified).toBe(false);
    expect(result.messages[1].reasoning_content).toBe('already here');
  });

  test('returns modified: false for empty messages array', () => {
    const result = reinjectReasoningContent([]);
    expect(result.modified).toBe(false);
    expect(result.messages).toEqual([]);
  });

  test('returns modified: false for null messages', () => {
    const result = reinjectReasoningContent(null);
    expect(result.modified).toBe(false);
    expect(result.messages).toBeNull();
  });

  test('does not inject for non-assistant messages', () => {
    const messages = [userMsg('non-asst')];
    const sk = sessionKey(generateBody(messages))!;

    const testMessages: Message[] = [
      userMsg('non-asst'),
      { role: 'user', content: 'user tool result', tool_calls: [toolCall('call_user')] },
    ];
    store(sk, 'call_user', 'should not appear');

    const result = reinjectReasoningContent(testMessages);
    expect(result.modified).toBe(false);
  });

  test('does not inject when cache miss', () => {
    const messages = [userMsg('cache miss'), asstMsg('no cache', [toolCall('call_miss')])];
    const result = reinjectReasoningContent(messages);
    expect(result.modified).toBe(false);
  });

  test('multiple assistant turns — injects only cached ones', () => {
    const messages = [userMsg('multi-turn')];
    const sk = sessionKey(generateBody(messages))!;

    const requestMessages = [
      userMsg('multi-turn'),
      asstMsg('first turn', [toolCall('call_first')]),
      asstMsg('second turn', [toolCall('call_second')]),
    ];
    store(sk, 'call_first', 'first reasoning');

    const result = reinjectReasoningContent(requestMessages);
    expect(result.modified).toBe(true);
    expect(result.messages[1].reasoning_content).toBe('first reasoning');
    expect(result.messages[2].reasoning_content).toBeUndefined();
  });

  test('all messages processed regardless of position', () => {
    const messages = [userMsg('all-positions')];
    const sk = sessionKey(generateBody(messages))!;

    const requestMessages = [
      userMsg('all-positions'),
      asstMsg('first tool', [toolCall('call_pos_1')]),
      asstMsg('second tool', [toolCall('call_pos_2')]),
    ];
    store(sk, 'call_pos_1', 'pos 1');
    store(sk, 'call_pos_2', 'pos 2');

    const result = reinjectReasoningContent(requestMessages);
    expect(result.modified).toBe(true);
    expect(result.messages[1].reasoning_content).toBe('pos 1');
    expect(result.messages[2].reasoning_content).toBe('pos 2');
  });

  test('injects regardless of message count (messageCount guard was removed as dead code)', () => {
    const messages = [userMsg('msgcount guard')];
    const sk = sessionKey(generateBody(messages))!;

    const requestMessages = [
      userMsg('msgcount guard'),
      asstMsg('tool response', [toolCall('call_guard')]),
    ];
    store(sk, 'call_guard', 'guarded reasoning');

    const result = reinjectReasoningContent(requestMessages);
    expect(result.modified).toBe(true);
    expect(result.messages[1].reasoning_content).toBe('guarded reasoning');
  });
});

describe('integration: extract → store → reinject round-trip', () => {
  test('full flow: extract reasoning from response, reinject on next request', () => {
    const responseMessages = [
      userMsg('what is the capital of France'),
      asstMsg(
        'The capital is Paris',
        [toolCall('call_france')],
        'I need to recall geographic knowledge.',
      ),
    ];

    const extracted = extractReasoningContent(responseMessages);
    expect(extracted).not.toBeNull();
    expect(extracted!.firstToolCallId).toBe('call_france');
    expect(extracted!.reasoningContent).toBe('I need to recall geographic knowledge.');

    const nextRequestMessages = [
      userMsg('what is the capital of France'),
      asstMsg('The capital is Paris', [toolCall('call_france')]),
    ];

    // Store reasoning content keyed on sessionKey + firstToolCallId
    store(extracted!.sk, extracted!.firstToolCallId, extracted!.reasoningContent);

    const reinjected = reinjectReasoningContent(nextRequestMessages);
    expect(reinjected.modified).toBe(true);
    expect(reinjected.messages[1].reasoning_content).toBe('I need to recall geographic knowledge.');
  });

  test('regression: cache hit even when message window shifts between extract and inject', () => {
    // Same bug as thinking-cache: the old fingerprint key would miss
    // when the last-3-messages window differs between extract and inject.
    const extractMessages = [
      userMsg('what is the capital of France'),
      asstMsg('Looking up...', [toolCall('call_shift_regress')], 'Let me look that up.'),
      userMsg('thanks'),
    ];

    const extracted = extractReasoningContent(extractMessages);
    expect(extracted).not.toBeNull();
    store(extracted!.sk, extracted!.firstToolCallId, extracted!.reasoningContent);

    // Different message window for injection
    const injectMessages = [
      userMsg('what is the capital of France'),
      asstMsg('Looking up...', [toolCall('call_shift_regress')]),
      userMsg('now a different follow-up'),
    ];

    const reinjected = reinjectReasoningContent(injectMessages);
    expect(reinjected.modified).toBe(true);
    expect(reinjected.messages[1].reasoning_content).toBe('Let me look that up.');
  });
});

// =========================================================================
// | delimiter safety (Windows filename compatibility)
// =========================================================================

describe('pipe delimiter safety', () => {
  test('cache key uses | not :', () => {
    const msgs = [userMsg('pipe test'), asstMsg('reasoning', [toolCall('call_pipe_test')])];
    // Set reasoning_content on the assistant message
    msgs[1].reasoning_content = 'pipe-delimited reasoning';

    const extracted = extractReasoningContent(msgs);
    expect(extracted).not.toBeNull();
    const { sk, firstToolCallId, reasoningContent } = extracted!;

    store(sk, firstToolCallId, reasoningContent);

    // Retrieve — must find the entry
    const injectMsgs = [userMsg('pipe test'), asstMsg('', [toolCall('call_pipe_test')])];
    const result = reinjectReasoningContent(injectMsgs);
    expect(result.modified).toBe(true);
    expect(result.messages[1].reasoning_content).toBe('pipe-delimited reasoning');
  });

  test('tool_call IDs with underscores coexist with | delimiter', () => {
    const callId = 'call_01AbCdEfGhIjKlMnOpQrStUv';
    const msgs = [userMsg('underscore id test'), asstMsg('underscore', [toolCall(callId)])];
    msgs[1].reasoning_content = 'underscore id reasoning';

    const extracted = extractReasoningContent(msgs);
    expect(extracted).not.toBeNull();

    store(extracted!.sk, extracted!.firstToolCallId, extracted!.reasoningContent);

    const injectMsgs = [userMsg('underscore id test'), asstMsg('', [toolCall(callId)])];
    const result = reinjectReasoningContent(injectMsgs);
    expect(result.modified).toBe(true);
    expect(result.messages[1].reasoning_content).toBe('underscore id reasoning');
  });
});
