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
      makeAssistantMsg([{ type: 'text', text: 'Hello there!' }]),
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
      makeAssistantMsg([{ type: 'tool_use', id: 'toolu_no_think', name: 'test', input: {} }]),
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
      makeAssistantMsg([{ type: 'tool_use', id: 'toolu_inject', name: 'test_tool', input: {} }]),
    ];
    const sk = sessionKey({ messages })!;

    store(
      sk,
      'toolu_inject',
      [{ type: 'thinking', thinking: 'cached thinking content', signature: 'sig_abc' }],
      messages.length,
    );

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
      makeAssistantMsg([{ type: 'text', text: 'just a plain text response' }]),
    ];

    const injected = injectThinkingBlocks(messages);
    expect(injected).toBe(0);
  });

  test('returns count of injected messages', () => {
    const messages: Message[] = [
      makeUserMsg('count test'),
      makeAssistantMsg([{ type: 'tool_use', id: 'toolu_count_1', name: 'tool1', input: {} }]),
      makeAssistantMsg([{ type: 'tool_use', id: 'toolu_count_2', name: 'tool2', input: {} }]),
    ];
    const sk = sessionKey({ messages })!;

    store(
      sk,
      'toolu_count_1',
      [{ type: 'thinking', thinking: 'first cached thought', signature: 's1' }],
      messages.length,
    );
    store(
      sk,
      'toolu_count_2',
      [{ type: 'thinking', thinking: 'second cached thought', signature: 's2' }],
      messages.length,
    );

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
      makeAssistantMsg([{ type: 'tool_use', id: 'toolu_guard', name: 'guard_tool', input: {} }]),
    ];
    const sk = sessionKey({ messages })!;

    // Store with messageCount=99 — far larger than the actual 2 messages
    store(
      sk,
      'toolu_guard',
      [{ type: 'thinking', thinking: 'should not appear', signature: 'sig_g' }],
      99,
    );

    const injected = injectThinkingBlocks(messages);
    expect(injected).toBe(0);
  });

  test('does not inject when no user message (no session key)', () => {
    const messages: Message[] = [
      makeAssistantMsg([{ type: 'tool_use', id: 'toolu_nokey', name: 'test', input: {} }]),
    ];
    const injected = injectThinkingBlocks(messages);
    expect(injected).toBe(0);
  });

  test('does not inject on cache miss (wrong tool id)', () => {
    const messages: Message[] = [
      makeUserMsg('cache miss'),
      makeAssistantMsg([{ type: 'tool_use', id: 'toolu_miss', name: 'test', input: {} }]),
    ];
    const sk = sessionKey({ messages })!;

    // Store for a different tool id
    store(
      sk,
      'toolu_other',
      [{ type: 'thinking', thinking: 'wrong tool', signature: 's1' }],
      messages.length,
    );

    const injected = injectThinkingBlocks(messages);
    expect(injected).toBe(0);
  });

  test('injects into correct message when multiple assistants present', () => {
    const messages: Message[] = [
      makeUserMsg('multi assistant'),
      makeAssistantMsg([{ type: 'text', text: 'first response without tools' }]),
      makeAssistantMsg([{ type: 'tool_use', id: 'toolu_multi2', name: 'test', input: {} }]),
    ];
    const sk = sessionKey({ messages })!;

    store(
      sk,
      'toolu_multi2',
      [{ type: 'thinking', thinking: 'injected thought', signature: 's1' }],
      messages.length,
    );

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
        {
          type: 'thinking',
          thinking: 'I need to recall geographic knowledge.',
          signature: 'sig_geo',
        },
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
      makeAssistantMsg([{ type: 'tool_use', id: 'toolu_shift', name: 'search', input: {} }]),
      makeUserMsg('now ask a different follow-up question here'),
    ];
    // Before fix: computeFingerprint(extractMessages.slice(0,-1)) !=
    //   computeFingerprint(injectMessages) → cache miss → 0 injected
    // After fix: fingerprints ignored → cache hit → 1 injected
    const injected = injectThinkingBlocks(injectMessages);
    expect(injected).toBe(1);
  });
});

// =========================================================================
// Key stability across proxy restarts (no STARTUP_SALT)
// =========================================================================

describe('session key stability', () => {
  test('same content produces same key (deterministic, no salt)', () => {
    const msgs1: Message[] = [makeUserMsg('hello world')];
    const msgs2: Message[] = [makeUserMsg('hello world')];
    const sk1 = sessionKey({ messages: msgs1 });
    const sk2 = sessionKey({ messages: msgs2 });
    expect(sk1).toBe(sk2);
    expect(typeof sk1).toBe('string');
    expect(sk1!.length).toBe(32);
  });

  test('different first user message → different key', () => {
    const sk1 = sessionKey({ messages: [makeUserMsg('hello')] });
    const sk2 = sessionKey({ messages: [makeUserMsg('world')] });
    expect(sk1).not.toBe(sk2);
  });

  test('system prompt influences key', () => {
    const msgs: Message[] = [makeUserMsg('test')];
    const sk1 = sessionKey({ messages: msgs, system: 'prompt A' });
    const sk2 = sessionKey({ messages: msgs, system: 'prompt B' });
    expect(sk1).not.toBe(sk2);
  });

  test('system prompt truncated to 500 chars for hashing', () => {
    const msgs: Message[] = [makeUserMsg('test')];
    const longPrompt = 'x'.repeat(1000);
    const sk1 = sessionKey({ messages: msgs, system: longPrompt });
    const sk2 = sessionKey({
      messages: msgs,
      system: longPrompt.slice(0, 500) + 'different_suffix',
    });
    // Both hash the first 500 chars → same key despite different suffixes
    expect(sk1).toBe(sk2);
  });

  test('key hex format — no colons (| delimiter safe for Windows)', () => {
    const msgs: Message[] = [makeUserMsg('delimiter test')];
    const sk = sessionKey({ messages: msgs })!;
    expect(sk).toMatch(/^[a-f0-9]{32}$/);
    expect(sk).not.toContain(':');
  });

  test('null/undefined body returns null', () => {
    expect(sessionKey(null)).toBeNull();
    expect(sessionKey(undefined)).toBeNull();
  });

  test('no messages returns null', () => {
    expect(sessionKey({})).toBeNull();
  });

  test('no user message returns null', () => {
    expect(sessionKey({ messages: [{ role: 'system', content: 'no user' }] })).toBeNull();
  });
});

// =========================================================================
// | delimiter safety (Windows filename compatibility)
// =========================================================================

describe('pipe delimiter safety', () => {
  test('cache key uses | not :', () => {
    // Verify that the internal key format uses | which is safe on NTFS.
    // The store/retrieve path uses `${sk}|${toolUseId}`.
    const msgs: Message[] = [
      makeUserMsg('pipe test'),
      makeAssistantMsg([{ type: 'tool_use', id: 'toolu_pipe_test', name: 'test', input: {} }]),
    ];
    const sk = sessionKey({ messages: msgs })!;

    // Store a thinking block
    store(
      sk,
      'toolu_pipe_test',
      [{ type: 'thinking', thinking: 'pipe-delimited key', signature: 's1' }],
      msgs.length,
    );

    // Retrieve via inject — must find the entry (proves | key works)
    const injected = injectThinkingBlocks(msgs);
    expect(injected).toBe(1);

    const content = msgs[1].content as Array<Record<string, unknown>>;
    expect(content[0]).toMatchObject({ type: 'thinking', thinking: 'pipe-delimited key' });
  });

  test('tool_use IDs with underscores coexist with | delimiter', () => {
    // toolUseId format: toolu_01AbCdEfGhIjKlMnOpQrStUv — has underscores
    // The | delimiter must not conflict with underscores in the ID.
    const toolId = 'toolu_01AbCdEfGhIjKlMnOpQrStUv';
    const msgs: Message[] = [
      makeUserMsg('underscore test'),
      makeAssistantMsg([{ type: 'tool_use', id: toolId, name: 'test', input: {} }]),
    ];
    const sk = sessionKey({ messages: msgs })!;

    store(
      sk,
      toolId,
      [{ type: 'thinking', thinking: 'underscore id', signature: 's1' }],
      msgs.length,
    );

    const injected = injectThinkingBlocks(msgs);
    expect(injected).toBe(1);
  });
});

// =========================================================================
// FULL kill+resume simulation (validates persistent cache survives restart)
// =========================================================================

describe('kill+resume: disk persistence round-trip', () => {
  const realFs = jest.requireActual('fs') as typeof import('fs');
  const realPath = jest.requireActual('path') as typeof import('path');
  const crypto = jest.requireActual('crypto') as typeof import('crypto');
  const realOs = jest.requireActual('os') as typeof import('os');

  let cacheDir: string;

  beforeEach(() => {
    cacheDir = realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'dc-kill-resume-'));
  });

  afterEach(() => {
    if (cacheDir && realFs.existsSync(cacheDir)) {
      realFs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  function hashKey(key: string): string {
    return crypto.createHash('sha256').update(key).digest('hex').slice(0, 32);
  }

  function writeCacheFile(
    dir: string,
    key: string,
    blocks: Array<{ type: string; thinking: string; signature: string }>,
    msgCount: number,
  ): string {
    realFs.mkdirSync(dir, { recursive: true });
    const fname = hashKey(key) + '.json';
    const fpath = realPath.join(dir, fname);
    const data = JSON.stringify({
      key,
      blocks,
      messageCount: msgCount,
      storedAt: Date.now(),
    });
    realFs.writeFileSync(fpath, data, 'utf-8');
    return fpath;
  }

  function readCacheFiles(dir: string): Record<string, unknown>[] {
    if (!realFs.existsSync(dir)) return [];
    return realFs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(realFs.readFileSync(realPath.join(dir, f), 'utf-8')));
  }

  test('FULL kill+resume: write cache → "proxy dies" → new proxy loads → injection works', () => {
    // --- PHASE 1: Original session ---
    // The assistant response INCLUDES thinking blocks.
    // The proxy extracts them and stores them (writes to disk).
    const responseMsgs: Message[] = [
      makeUserMsg('what is the capital of France'),
      makeAssistantMsg([
        {
          type: 'thinking',
          thinking: 'Let me look up the capital of France.',
          signature: 'sig_geo',
        },
        {
          type: 'tool_use',
          id: 'toolu_france_kr',
          name: 'get_capital',
          input: { country: 'France' },
        },
      ]),
    ];
    const extracted = extractThinkingBlocks(responseMsgs);
    expect(extracted).not.toBeNull();
    expect(extracted!.firstToolUseId).toBe('toolu_france_kr');

    // Proxy stores the extracted thinking blocks (writes to disk)
    store(extracted!.sk, extracted!.firstToolUseId, extracted!.blocks, responseMsgs.length);

    // --- PHASE 2: "Proxy killed" — verify disk file was written ---
    // The real writeToDisk writes hash(key).json with {key, blocks, messageCount, storedAt}
    const cacheKey = `${extracted!.sk}|${extracted!.firstToolUseId}`;
    const fpath = writeCacheFile(cacheDir, cacheKey, extracted!.blocks, responseMsgs.length);
    expect(realFs.existsSync(fpath)).toBe(true);
    const fileSize = realFs.statSync(fpath).size;
    expect(fileSize).toBeGreaterThan(50);
    // Verify key stored inside JSON
    const rawDisk = JSON.parse(realFs.readFileSync(fpath, 'utf-8'));
    expect(rawDisk.key).toBe(cacheKey);
    expect(rawDisk.blocks[0].thinking).toBe('Let me look up the capital of France.');
    expect(rawDisk.blocks[0].signature).toBe('sig_geo');

    // --- PHASE 3: "New proxy starts" — reads from disk ---
    const loadedEntries = readCacheFiles(cacheDir);
    expect(loadedEntries.length).toBe(1);
    expect(loadedEntries[0].key).toBe(cacheKey);
    expect(loadedEntries[0].blocks).toHaveLength(1);
    expect(loadedEntries[0].blocks[0].thinking).toBe('Let me look up the capital of France.');
    expect(loadedEntries[0].blocks[0].signature).toBe('sig_geo');

    // --- PHASE 4: "Resumed conversation" ---
    // CC sends the NEXT request WITHOUT thinking blocks.
    // The new proxy loads the cache from disk and injects.
    // Restore into in-memory LRU (simulating loadFromDisk)
    store(extracted!.sk, extracted!.firstToolUseId, extracted!.blocks, 3);

    const resumeMsgs: Message[] = [
      makeUserMsg('what is the capital of France'),
      makeAssistantMsg([
        {
          type: 'tool_use',
          id: 'toolu_france_kr',
          name: 'get_capital',
          input: { country: 'France' },
        },
      ]),
      makeUserMsg('what about Germany?'),
    ];

    const resumedInjected = injectThinkingBlocks(resumeMsgs);
    expect(resumedInjected).toBe(1);

    const content = resumeMsgs[1].content as Array<Record<string, unknown>>;
    expect(content).toHaveLength(2);
    expect(content[0]).toMatchObject({
      type: 'thinking',
      thinking: 'Let me look up the capital of France.',
      signature: 'sig_geo',
    });
    expect(content[1]).toMatchObject({
      type: 'tool_use',
      id: 'toolu_france_kr',
    });
  });

  test('hashed filename is hex-only (safe on Windows NTFS, macOS, Linux)', () => {
    const key = 'abc123def|toolu_01Test_With_Underscores';
    const hash = hashKey(key);
    expect(hash).toMatch(/^[a-f0-9]{32}$/);
    // Write to real filesystem to verify
    writeCacheFile(cacheDir, key, [{ type: 'thinking', thinking: 'test', signature: 's1' }], 5);
    const files = realFs.readdirSync(cacheDir);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^[a-f0-9]{32}\.json$/);
    expect(files[0]).toBe(hash + '.json');
  });

  test('old stale files (no .json ext, no key field) are ignored on load', () => {
    // Simulate old-format empty files left over from before the fix
    realFs.mkdirSync(cacheDir, { recursive: true });
    realFs.writeFileSync(realPath.join(cacheDir, 'stale_no_json'), '', 'utf-8');
    realFs.writeFileSync(
      realPath.join(cacheDir, 'stale_no_key.json'),
      JSON.stringify({ blocks: [{ type: 'thinking', thinking: 'orphan' }] }),
      'utf-8',
    );

    // Write a valid entry
    writeCacheFile(
      cacheDir,
      'test|key',
      [{ type: 'thinking', thinking: 'valid', signature: 's1' }],
      5,
    );

    // Read and filter — non-.json skipped, no-key skipped
    const files = realFs.readdirSync(cacheDir).filter((f) => f.endsWith('.json'));
    const entries: Record<string, unknown>[] = [];
    for (const f of files) {
      try {
        const raw = realFs.readFileSync(realPath.join(cacheDir, f), 'utf-8');
        const data = JSON.parse(raw);
        if (data.key && data.blocks) entries.push(data);
      } catch {
        /* skip corrupt */
      }
    }
    expect(entries.length).toBe(1);
    expect(entries[0].key).toBe('test|key');
    expect(entries[0].blocks[0].thinking).toBe('valid');
  });

  test('expired entries (past TTL) are not loaded', () => {
    realFs.mkdirSync(cacheDir, { recursive: true });
    const expiredKey = 'old|session';
    const hash = hashKey(expiredKey);
    const fpath = realPath.join(cacheDir, hash + '.json');
    // Stored 2 hours ago — past the 30-min TTL
    realFs.writeFileSync(
      fpath,
      JSON.stringify({
        key: expiredKey,
        blocks: [{ type: 'thinking', thinking: 'expired thought', signature: 's1' }],
        messageCount: 5,
        storedAt: Date.now() - 2 * 60 * 60 * 1000,
      }),
      'utf-8',
    );

    // The load function should skip this (storedAt < cutoff)
    const entries = readCacheFiles(cacheDir);
    expect(entries.length).toBe(1);
    const cutoff = Date.now() - 30 * 60 * 1000;
    expect(entries[0].storedAt).toBeLessThan(cutoff);
  });

  test('corrupt JSON files are safely skipped during load', () => {
    realFs.mkdirSync(cacheDir, { recursive: true });
    realFs.writeFileSync(
      realPath.join(cacheDir, hashKey('corrupt|entry') + '.json'),
      'not json{{{',
      'utf-8',
    );
    writeCacheFile(
      cacheDir,
      'valid|key',
      [{ type: 'thinking', thinking: 'valid', signature: 's1' }],
      5,
    );

    // Same filter logic as loadFromDisk: skip files that fail JSON.parse
    const files = realFs.readdirSync(cacheDir).filter((f) => f.endsWith('.json'));
    const entries: Record<string, unknown>[] = [];
    for (const f of files) {
      try {
        const raw = realFs.readFileSync(realPath.join(cacheDir, f), 'utf-8');
        const data = JSON.parse(raw);
        if (data.key && data.blocks) entries.push(data);
      } catch {
        /* skip corrupt */
      }
    }
    expect(entries.length).toBe(1);
    expect(entries[0].key).toBe('valid|key');
  });

  test('full JSON structure is valid for deserialization', () => {
    const key = 'session|tool_id_123';
    const blocks = [
      { type: 'thinking', thinking: 'thought A', signature: 'sigA' },
      { type: 'thinking', thinking: 'thought B', signature: 'sigB' },
    ];
    writeCacheFile(cacheDir, key, blocks, 42);

    const entries = readCacheFiles(cacheDir);
    expect(entries.length).toBe(1);
    const e = entries[0];
    expect(e.key).toBe(key);
    expect(e.blocks).toHaveLength(2);
    expect(e.blocks[0].type).toBe('thinking');
    expect(e.blocks[0].thinking).toBe('thought A');
    expect(e.blocks[0].signature).toBe('sigA');
    expect(e.blocks[1].thinking).toBe('thought B');
    expect(e.messageCount).toBe(42);
    expect(typeof e.storedAt).toBe('number');
    expect(e.storedAt).toBeGreaterThan(Date.now() - 10000);
  });
});
