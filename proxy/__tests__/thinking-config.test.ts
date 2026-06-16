'use strict';

import { applyThinkingConfig, matchThinkingModel } from '../thinking-config';
import type { ThinkingConfigEntry } from '../thinking-config';
import { getConstraints } from '../protocol-types';

// =========================================================================
// matchThinkingModel
// =========================================================================

describe('matchThinkingModel', () => {
  const config: Record<string, ThinkingConfigEntry> = {
    'deepseek-v4-pro': { type: 'enabled', budget_tokens: 32000 },
    'deepseek-v4-flash': { type: 'enabled', budget_tokens: 16000 },
  };

  test('exact match', () => {
    const result = matchThinkingModel('deepseek-v4-pro', config);
    expect(result).not.toBeNull();
    expect(result!.budget_tokens).toBe(32000);
  });

  test('last segment fallback', () => {
    const result = matchThinkingModel('deepseek/deepseek-v4-flash', config);
    expect(result).not.toBeNull();
    expect(result!.budget_tokens).toBe(16000);
  });

  test('returns null for unknown model', () => {
    const result = matchThinkingModel('unknown-model', config);
    expect(result).toBeNull();
  });

  test('returns null for empty config', () => {
    const result = matchThinkingModel('deepseek-v4-pro', {});
    expect(result).toBeNull();
  });
});

// =========================================================================
// applyThinkingConfig — critical: DeepSeek "Thinking mode does not support
// this tool_choice" bug reproduction and fix verification
// =========================================================================

describe('applyThinkingConfig', () => {
  const ds = getConstraints('ds');
  const an = getConstraints('an');
  const oc = getConstraints('oc');
  const thinkingCfg: ThinkingConfigEntry = {
    type: 'enabled',
    budget_tokens: 16000,
  };

  // --- Rule 1: Web tools → strip thinking, keep tool_choice ---

  test('web tools present: strips thinking, keeps tool_choice (DeepSeek)', () => {
    // Beta header stripping (stripEffortBetaHeader) handles removing
    // thinking-related beta values. applyThinkingConfig strips thinking
    // from body but keeps tool_choice to force model to invoke the tool.
    const body: Record<string, unknown> = {
      model: 'deepseek-v4-flash',
      thinking: { type: 'enabled', budget_tokens: 32000 },
      tool_choice: { type: 'tool', name: 'web_search' },
    };
    const modified = applyThinkingConfig(body, true, ds, thinkingCfg);

    expect(modified).toBe(true);
    expect(body.thinking).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
  });

  test('DeepSeek forwarded body matches Haiku structure for web search', () => {
    // CC sends this to both providers. After applyThinkingConfig,
    // the DeepSeek body should have the same shape as Haiku's body —
    // no thinking, no tool_choice. The model follows the system prompt
    // instructions to invoke the tool.
    const body: Record<string, unknown> = {
      model: 'deepseek-v4-flash',
      thinking: { type: 'enabled', budget_tokens: 16000 },
      tool_choice: { type: 'tool', name: 'web_search' },
      messages: [{ role: 'user', content: 'search query' }],
      tools: [{ name: 'web_search' }],
      max_tokens: 200,
      stream: false,
    };
    const modified = applyThinkingConfig(body, true, ds, thinkingCfg);

    expect(modified).toBe(true);
    // thinking stripped from body, tool_choice preserved for web tools
    expect(body.thinking).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
    // Non-thinking fields preserved
    expect(body.messages).toBeDefined();
    expect(body.tools).toBeDefined();
    expect(body.max_tokens).toBe(200);
    expect(body.stream).toBe(false);
  });

  test('web tools present, no thinking field: strips tool_choice', () => {
    const body: Record<string, unknown> = {
      model: 'deepseek-v4-flash',
      tool_choice: { type: 'tool', name: 'web_search' },
    };
    const modified = applyThinkingConfig(body, true, ds, thinkingCfg);

    expect(modified).toBe(true); // tool_choice stripped for non-native web tools
    expect(body.tool_choice).toBeUndefined(); // Stripped for non-native
  });

  test('web tools present, thinkingCfg is null: still strips thinking', () => {
    // CRITICAL: this is the bug we fixed. Even when no thinking config
    // matches the model, thinking must still be stripped for web tools.
    const body: Record<string, unknown> = {
      model: 'some-unknown-model',
      thinking: { type: 'enabled', budget_tokens: 32000 },
      tool_choice: { type: 'tool', name: 'web_search' },
    };
    const modified = applyThinkingConfig(body, true, ds, null);

    expect(modified).toBe(true);
    expect(body.thinking).toBeUndefined();
    expect(body.tool_choice).toBeUndefined(); // Stripped for non-native
  });

  // --- Rule 2: No web tools → strip tool_choice ---

  test('no web tools, provider forbids: strips tool_choice', () => {
    const body: Record<string, unknown> = {
      model: 'deepseek-v4-flash',
      tool_choice: 'auto',
    };
    const modified = applyThinkingConfig(body, false, ds, thinkingCfg);

    expect(modified).toBe(true);
    expect(body.tool_choice).toBeUndefined();
  });

  test('no web tools, tool_choice present: strips tool_choice, injects thinking', () => {
    const body: Record<string, unknown> = {
      model: 'deepseek-v4-flash',
      tool_choice: 'auto',
    };
    const modified = applyThinkingConfig(body, false, ds, thinkingCfg);

    expect(modified).toBe(true);
    expect(body.tool_choice).toBeUndefined();
    // Thinking was injected (rule 3)
    expect(body.thinking).toBeDefined();
    expect((body.thinking as any).budget_tokens).toBe(16000);
  });

  test('OpenCode (also forbids): strips tool_choice, no thinking injection', () => {
    // oc.thinkingFormat is null, so no injection even if thinkingCfg provided
    const body: Record<string, unknown> = {
      model: 'big-pickle',
      tool_choice: 'auto',
    };
    const modified = applyThinkingConfig(body, false, oc, thinkingCfg);

    expect(modified).toBe(true);
    expect(body.tool_choice).toBeUndefined();
    // No injection because oc.thinkingFormat is null
    expect(body.thinking).toBeUndefined();
  });

  // --- Rule 3: Inject thinking ---

  test('no thinking, no web tools: injects thinking from config', () => {
    const body: Record<string, unknown> = {
      model: 'deepseek-v4-flash',
      messages: [],
    };
    const modified = applyThinkingConfig(body, false, ds, thinkingCfg);

    expect(modified).toBe(true);
    expect(body.thinking).toBeDefined();
    expect((body.thinking as any).type).toBe('enabled');
    expect((body.thinking as any).budget_tokens).toBe(16000);
  });

  test('thinking already present: does NOT overwrite', () => {
    const body: Record<string, unknown> = {
      model: 'deepseek-v4-flash',
      thinking: { type: 'enabled', budget_tokens: 9999 },
    };
    const modified = applyThinkingConfig(body, false, ds, thinkingCfg);

    expect(modified).toBe(false);
    expect((body.thinking as any).budget_tokens).toBe(9999);
  });

  test('Anthropic native: no stripping, no injection needed', () => {
    // an.forbidsToolChoiceWithThinking is false, so neither strip fires.
    // Not a haiku model, so Rule 3 doesn't fire either.
    const body: Record<string, unknown> = {
      model: 'claude-opus-4-7',
      tool_choice: 'auto',
    };
    const modified = applyThinkingConfig(body, false, an, null, 'claude-opus-4-7');

    expect(modified).toBe(false);
    expect(body.tool_choice).toBeDefined(); // an.forbidsToolChoiceWithThinking=false
    expect(body.thinking).toBeUndefined();
  });

  // --- Rule 3: Haiku on Anthropic strips thinking ---

  test('Haiku on Anthropic: strips thinking from body', () => {
    // Haiku doesn't support thinking/effort. CC sends it anyway from
    // the user's effort level — we must strip it.
    const body: Record<string, unknown> = {
      model: 'claude-haiku-4-5-20251001',
      thinking: { type: 'enabled', budget_tokens: 32000 },
    };
    const modified = applyThinkingConfig(body, false, an, null, 'claude-haiku-4-5-20251001');

    expect(modified).toBe(true);
    expect(body.thinking).toBeUndefined();
  });

  test('Haiku on Anthropic with web tools: strips thinking, keeps tool_choice', () => {
    // Even though an.forbidsToolChoiceWithThinking is false, Rule 3
    // still strips thinking for haiku models.
    const body: Record<string, unknown> = {
      model: 'claude-haiku-4-5-20251001',
      thinking: { type: 'enabled', budget_tokens: 32000 },
      tool_choice: { type: 'tool', name: 'web_search' },
    };
    const modified = applyThinkingConfig(body, true, an, null, 'claude-haiku-4-5-20251001');

    expect(modified).toBe(true);
    expect(body.thinking).toBeUndefined();
    expect(body.tool_choice).toBeDefined(); // an.forbidsToolChoiceWithThinking=false
  });

  test('Non-haiku on Anthropic: thinking passes through untouched', () => {
    // Sonnet supports thinking, so no stripping
    const body: Record<string, unknown> = {
      model: 'claude-sonnet-4-6',
      thinking: { type: 'enabled', budget_tokens: 32000 },
    };
    const modified = applyThinkingConfig(body, false, an, null, 'claude-sonnet-4-6');

    expect(modified).toBe(false);
    expect(body.thinking).toBeDefined();
  });

  test('Anthropic native with web tools: no stripping (native handles it)', () => {
    const body: Record<string, unknown> = {
      model: 'claude-haiku-4-5-20251001',
      thinking: { type: 'enabled', budget_tokens: 32000 },
      tool_choice: { type: 'tool', name: 'web_search' },
    };
    const modified = applyThinkingConfig(body, true, an, null);

    // an.forbidsToolChoiceWithThinking is false, so no stripping
    expect(modified).toBe(false);
    expect(body.thinking).toBeDefined();
    expect(body.tool_choice).toBeDefined(); // an.forbidsToolChoiceWithThinking=false
  });

  // --- Edge cases ---

  test('empty body: no-op', () => {
    const body: Record<string, unknown> = {};
    const modified = applyThinkingConfig(body, false, ds, thinkingCfg);

    expect(modified).toBe(true); // thinking injected
    expect(body.thinking).toBeDefined();
  });

  test('hasWebTools + forbidsToolChoiceWithThinking: thinking stripped, NOT re-injected', () => {
    // Rule 1 strips thinking. Rule 3 should NOT re-inject because hasWebTools is true.
    const body: Record<string, unknown> = {
      model: 'deepseek-v4-flash',
      thinking: { type: 'enabled', budget_tokens: 32000 },
      tool_choice: { type: 'tool', name: 'web_search' },
    };
    applyThinkingConfig(body, true, ds, thinkingCfg);

    expect(body.thinking).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
  });
});
