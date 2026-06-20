'use strict';

import { classifyRequest, resolvePromptRoute, capMaxTokens } from '../prompt-router';

describe('classifyRequest', () => {
  test('TRIVIAL: single short message, no tools', () => {
    const body = {
      messages: [{ role: 'user', content: 'Hi' }],
    };
    expect(classifyRequest(body).tier).toBe('TRIVIAL');
  });

  test('CHAT: multi-turn conversation, no code', () => {
    const body = {
      messages: [
        { role: 'user', content: 'What is the weather?' },
        { role: 'assistant', content: 'It is sunny.' },
        { role: 'user', content: 'Thanks!' },
      ],
    };
    expect(classifyRequest(body).tier).toBe('CHAT');
  });

  test('CODE: code blocks in messages', () => {
    const body = {
      messages: [{ role: 'user', content: 'Write a function:\n```\nfunction hello() {}\n```' }],
    };
    expect(classifyRequest(body).tier).toBe('CODE');
  });

  test('TOOL: tool definitions present', () => {
    const body = {
      messages: [{ role: 'user', content: 'Do something' }],
      tools: [{ name: 'search', description: 'Search tool' }],
    };
    expect(classifyRequest(body).tier).toBe('TOOL');
  });

  test('HEAVY: more than 2 tool_use blocks in history', () => {
    const body = {
      messages: [
        { role: 'user', content: 'Hello' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: '1', name: 'search' },
            { type: 'tool_use', id: '2', name: 'read' },
            { type: 'tool_use', id: '3', name: 'write' },
          ],
        },
      ],
    };
    expect(classifyRequest(body).tier).toBe('HEAVY');
  });

  test('HEAVY: very long context exceeding 32K token estimate', () => {
    const longContent = 'A'.repeat(130000);
    const body = {
      messages: [{ role: 'user', content: longContent }],
    };
    expect(classifyRequest(body).tier).toBe('HEAVY');
  });

  test('TOOL takes priority over CODE in mixed content', () => {
    const body = {
      messages: [{ role: 'user', content: '```code```' }],
      tools: [{ name: 'search' }],
    };
    expect(classifyRequest(body).tier).toBe('TOOL');
  });

  test('null body returns CHAT', () => {
    expect(classifyRequest(null).tier).toBe('CHAT');
  });

  test('empty messages array returns CHAT', () => {
    expect(classifyRequest({ messages: [] }).tier).toBe('CHAT');
  });

  test('missing messages field returns CHAT', () => {
    expect(classifyRequest({ model: 'test' }).tier).toBe('CHAT');
  });

  test('handles non-array tools gracefully', () => {
    const body = { tools: 'not-an-array', messages: [{ role: 'user', content: 'hello' }] };
    expect(classifyRequest(body).tier).toBe('TRIVIAL');
  });

  test('handles malformed message entries gracefully', () => {
    const body = { messages: [null, undefined, { role: 'user', content: 'hi' }] };
    expect(classifyRequest(body).tier).toBe('CHAT');
  });

  test('CHAT: single long message that is not code', () => {
    const body = {
      messages: [
        {
          role: 'user',
          content:
            'Can you explain the difference between functional programming and object-oriented programming with some practical examples?',
        },
      ],
    };
    expect(classifyRequest(body).tier).toBe('CHAT');
  });
});

describe('resolvePromptRoute', () => {
  const config = {
    enabled: true,
    routes: {
      sonnet: [
        { tier: 'TRIVIAL', provider: 'or', model: 'liquid/lfm-2.5-1.2b-instruct:free' },
        { tier: 'CHAT', provider: 'or', model: 'z-ai/glm-4.5-air:free' },
        { tier: 'CODE', provider: 'ds', model: 'deepseek-v4-pro' },
        { tier: 'TOOL', provider: 'ds', model: 'deepseek-v4-pro' },
        { tier: 'HEAVY', provider: 'ds', model: 'deepseek-v4-pro' },
      ],
    },
  };

  const dummyRouting = { providers: {}, routes: {}, defaultProvider: null };

  test('TRIVIAL tier matches first route entry', () => {
    const result = resolvePromptRoute('sonnet', { tier: 'TRIVIAL' }, config, dummyRouting);
    expect(result).toEqual({
      providerKey: 'or',
      rewriteModel: 'liquid/lfm-2.5-1.2b-instruct:free',
    });
  });

  test('CHAT tier matches correctly', () => {
    const result = resolvePromptRoute('sonnet', { tier: 'CHAT' }, config, dummyRouting);
    expect(result).toEqual({ providerKey: 'or', rewriteModel: 'z-ai/glm-4.5-air:free' });
  });

  test('CODE tier matches correctly', () => {
    const result = resolvePromptRoute('sonnet', { tier: 'CODE' }, config, dummyRouting);
    expect(result).toEqual({ providerKey: 'ds', rewriteModel: 'deepseek-v4-pro' });
  });

  test('disabled config returns null', () => {
    const disabled = { ...config, enabled: false };
    expect(resolvePromptRoute('sonnet', { tier: 'TRIVIAL' }, disabled, dummyRouting)).toBeNull();
  });

  test('unknown slot returns null (falls through to normal routing)', () => {
    expect(resolvePromptRoute('unknown', { tier: 'TRIVIAL' }, config, dummyRouting)).toBeNull();
  });

  test('unconfigured tier returns null', () => {
    const partial = {
      enabled: true,
      routes: {
        sonnet: [{ tier: 'TRIVIAL', provider: 'or', model: 'small' }],
      },
    };
    expect(resolvePromptRoute('sonnet', { tier: 'HEAVY' }, partial, dummyRouting)).toBeNull();
  });

  test('empty routes object returns null', () => {
    const empty = { enabled: true, routes: {} };
    expect(resolvePromptRoute('sonnet', { tier: 'TRIVIAL' }, empty, dummyRouting)).toBeNull();
  });
});

describe('capMaxTokens', () => {
  test('TRIVIAL caps at 1024', () => {
    expect(capMaxTokens(16384, 'TRIVIAL')).toBe(1024);
  });

  test('TRIVIAL below cap passes through', () => {
    expect(capMaxTokens(512, 'TRIVIAL')).toBe(512);
  });

  test('CHAT caps at 4096', () => {
    expect(capMaxTokens(16384, 'CHAT')).toBe(4096);
  });

  test('CHAT below cap passes through', () => {
    expect(capMaxTokens(2048, 'CHAT')).toBe(2048);
  });

  test('TOOL caps at 8192', () => {
    expect(capMaxTokens(16384, 'TOOL')).toBe(8192);
  });

  test('TOOL below cap passes through', () => {
    expect(capMaxTokens(4096, 'TOOL')).toBe(4096);
  });

  test('CODE has no cap', () => {
    expect(capMaxTokens(16384, 'CODE')).toBe(16384);
  });

  test('HEAVY has no cap', () => {
    expect(capMaxTokens(16384, 'HEAVY')).toBe(16384);
  });
});
