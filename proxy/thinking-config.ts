'use strict';

// Thinking configuration application — strips or injects thinking and
// tool_choice based on provider constraints and whether web search/fetch
// tools are present in the request.
//
// Extracted from start-proxy.ts so the logic is independently testable.

import type { ProviderConstraints } from './protocol-types';

export interface ThinkingConfigEntry {
  type: string;
  budget_tokens: number;
}

/**
 * Match an upstream model name against a thinking config dictionary.
 * Tries exact match first, then falls back to the last path segment.
 */
export function matchThinkingModel(
  upstreamModel: string,
  config: Record<string, ThinkingConfigEntry>,
): ThinkingConfigEntry | null {
  const exact = config[upstreamModel];
  if (exact) return exact;
  const lastSegment = upstreamModel.split('/').pop();
  if (lastSegment && lastSegment !== upstreamModel) {
    const segment = config[lastSegment];
    if (segment) return segment;
  }
  return null;
}

/**
 * Apply thinking configuration to an Anthropic-format request body.
 *
 * Rules (in order):
 * 1. If web tools are present and the provider forbids tool_choice with
 *    thinking → strip thinking, keep tool_choice (needed to force tool use).
 * 2. If the provider forbids tool_choice with thinking but no web tools
 *    are present → strip tool_choice, keep thinking.
 * 3. If the provider supports thinking and no thinking is present and no
 *    web tools are forcing tool_choice → inject thinking from config.
 *
 * Returns true if the body was modified.
 */
export function applyThinkingConfig(
  body: Record<string, unknown>,
  hasWebTools: boolean,
  constraints: ProviderConstraints,
  thinkingCfg: ThinkingConfigEntry | null,
  upstreamModel?: string,
  tier?: string,
): boolean {
  let modified = false;

  // Rule 1: Web tools present → strip thinking AND tool_choice for
  // providers that reject the combination (DeepSeek). DeepSeek's /anthropic
  // endpoint rejects tool_choice when any thinking-related feature is
  // detected. stripEffortBetaHeader handles beta values — we strip both
  // from the body so DeepSeek invokes the tool from system prompt alone.
  if (hasWebTools && constraints.forbidsToolChoiceWithThinking) {
    if (body.thinking) {
      delete body.thinking;
      modified = true;
    }
    if (body.tool_choice !== undefined) {
      delete body.tool_choice;
      modified = true;
    }
  }
  // Rule 2: No web tools, but provider forbids the combo → strip tool_choice
  else if (constraints.forbidsToolChoiceWithThinking && body.tool_choice !== undefined) {
    delete body.tool_choice;
    modified = true;
  }

  // Rule 3: Haiku models on Anthropic don't support thinking/effort.
  // Strip thinking from the body (CC sends it from the user's effort level).
  if (
    constraints.nativeServerTools &&
    upstreamModel &&
    upstreamModel.includes('haiku') &&
    body.thinking
  ) {
    delete body.thinking;
    modified = true;
  }

  // Rule 4: Inject thinking from config (only when provider supports it,
  // no thinking exists yet, and no web tools are present).
  // For TRIVIAL requests (<50 char single messages like greetings), skip
  // thinking entirely — it's wasted output tokens at $0.87/M.
  if (thinkingCfg && constraints.thinkingFormat === 'anthropic' && !body.thinking && !hasWebTools) {
    if (tier === 'TRIVIAL') {
      // TRIVIAL requests don't need reasoning. Skip thinking to save output cost.
      modified = false; // nothing to inject
    } else {
      const budget =
        tier === 'CHAT'
          ? Math.min(thinkingCfg.budget_tokens, 4096) // CHAT gets minimal thinking
          : thinkingCfg.budget_tokens; // CODE/TOOL/HEAVY get full budget
      body.thinking = { type: thinkingCfg.type, budget_tokens: budget };
      modified = true;
    }
  }

  return modified;
}
