'use strict';

import { LruCache } from './lru-cache';
import { sessionKey } from './session-key';

// 30-minute TTL, bounded to 1000 entries. LruCache handles expiry and
// eviction automatically via its shared cleanup timer.
const TTL_MS = 30 * 60 * 1000;
const MAX_ENTRIES = 1000;

const cache = new LruCache<CachedEntry>({ ttlMs: TTL_MS, maxEntries: MAX_ENTRIES });

// --- Types ---

export interface MessageBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  thinking?: string;
  signature?: string;
}

export interface Message {
  role: string;
  content: string | MessageBlock[];
}

interface StoredBlock {
  type: string;
  thinking: string;
  signature: string;
}

interface CachedEntry {
  blocks: StoredBlock[];
  messageCount: number;
}

export function store(
  sessionKeyParam: string | null,
  firstToolUseId: string | null,
  blocks: StoredBlock[],
  messageCount: number = -1,
): void {
  if (!blocks || blocks.length === 0 || !firstToolUseId) return;
  // Key on sessionKey + firstToolUseId only. The firstToolUseId is a UUID
  // (unique per tool call), so we don't need the conversation fingerprint
  // for disambiguation. Dropping the fingerprint fixes a cache-miss bug
  // where extraction and injection computed different fingerprints because
  // the last-3-messages sliding window had shifted between turns.
  cache.set(`${sessionKeyParam}:${firstToolUseId}`, {
    blocks: blocks.map((b) => ({
      type: b.type,
      thinking: b.thinking,
      signature: b.signature || '',
    })),
    messageCount,
  });
}

function retrieve(
  sessionKeyParam: string | null,
  firstToolUseId: string | null,
  currentMsgCount: number = -1,
): StoredBlock[] | null {
  const entry = cache.get(`${sessionKeyParam}:${firstToolUseId}`);
  if (!entry) return null;
  if (entry.messageCount > 0 && currentMsgCount >= 0 && entry.messageCount !== currentMsgCount)
    return null;
  return entry.blocks;
}

export function injectThinkingBlocks(messages: Message[]): number {
  if (!messages || !Array.isArray(messages)) return 0;
  const sk = sessionKey({ messages });
  if (!sk) return 0;

  let injected = 0;
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    if (typeof msg.content === 'string') continue;
    if (!Array.isArray(msg.content)) continue;

    const hasThinking = (msg.content as MessageBlock[]).some((b) => b.type === 'thinking');
    if (hasThinking) continue;

    const toolUses = (msg.content as MessageBlock[]).filter((b) => b.type === 'tool_use');
    if (toolUses.length === 0) continue;

    const firstId = toolUses[0].id;
    const cached = retrieve(sk, firstId!, messages.length);
    if (cached) {
      msg.content = [...cached, ...(msg.content as MessageBlock[])];
      injected++;
    }
  }
  return injected;
}

interface ExtractResult {
  sk: string;
  firstToolUseId: string;
  blocks: StoredBlock[];
}

export function extractThinkingBlocks(messages: Message[]): ExtractResult | null {
  if (!messages || !Array.isArray(messages)) return null;
  const sk = sessionKey({ messages });
  if (!sk) return null;

  // Scan backward — the LAST assistant message with both thinking and
  // tool_use is the most recent response and the one we need to cache.
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'assistant') continue;
    if (typeof msg.content === 'string') continue;
    if (!Array.isArray(msg.content)) continue;

    const blocks = msg.content as MessageBlock[];
    const thinking = blocks.filter((b) => b.type === 'thinking');
    const toolUses = blocks.filter((b) => b.type === 'tool_use');
    if (thinking.length > 0 && toolUses.length > 0) {
      const firstId = toolUses[0].id;
      if (!firstId) return null;
      return { sk, firstToolUseId: firstId, blocks: thinking as StoredBlock[] };
    }
  }

  return null;
}
