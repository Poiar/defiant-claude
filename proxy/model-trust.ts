'use strict';

/**
 * Map a CC model string to a Claude model name that CC trusts for
 * server_tool_use. CC only reads usage.server_tool_use from responses
 * whose model starts with "claude-". Without this, web_search_requests
 * shows "Did 0 searches" even though the proxy populated results.
 */
export function getTrustedModel(originalModel: string | null): string | null {
  if (originalModel === null) return null;

  // If it already contains a claude-* model name, extract it.
  // Matches: "haiku:claude-haiku-4-5-20251001", "claude-sonnet-4-6", etc.
  // Excludes [] to stop at [1m] context-window suffixes.
  // Claude model names: claude-{variant}-{major}[-{minor}][-{date}]
  const claudeMatch = originalModel.match(/\b(claude-[a-z]+-\d[\da-z-]*)/i);
  if (claudeMatch) return claudeMatch[1];

  // Map slot prefix to canonical Claude model name.
  const slotMatch = originalModel.match(/^([a-z]+):/);
  const slot = slotMatch ? slotMatch[1].toLowerCase() : '';

  switch (slot) {
    case 'sonnet':
      return 'claude-sonnet-4-6';
    case 'opus':
    case 'fable':
      return 'claude-opus-4-7';
    case 'haiku':
    case 'subagent':
    case 'sub':
    default:
      return 'claude-haiku-4-5-20251001';
  }
}
