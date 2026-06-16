'use strict';

import fs from 'node:fs';
import path from 'node:path';

import { LruCache } from './lru-cache';
import { sessionKey } from './session-key';

// 30-minute TTL, bounded to 1000 entries. LruCache handles expiry and
// eviction automatically via its shared cleanup timer.
const TTL_MS = 30 * 60 * 1000;
const MAX_ENTRIES = 1000;

// Persist to ~/.deepclaude/thinking-cache/ so cached thinking blocks survive
// proxy restarts. Without this, kill+resume causes DeepSeek prefix cache misses
// at 120× cost ($0.435/M vs $0.0036/M).
const CACHE_DIR = path.join(
  process.env.DEEPCLAUDE_CONFIG_DIR ||
    path.join(process.env.HOME || process.env.USERPROFILE || '.', '.deepclaude'),
  'thinking-cache',
);

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

// --- Disk persistence ---

function cacheFilePath(key: string): string {
  // Sanitize the key for filesystem use — hex chars only, safe as-is.
  return path.join(CACHE_DIR, `${key}.json`);
}

const isTestEnv = process.env.JEST_WORKER_ID !== undefined || process.env.NODE_ENV === 'test';

function writeToDisk(key: string, entry: CachedEntry): void {
  if (isTestEnv) return;
  try {
    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
    }
    const data = JSON.stringify({
      blocks: entry.blocks,
      messageCount: entry.messageCount,
      storedAt: Date.now(),
    });
    fs.writeFileSync(cacheFilePath(key), data, 'utf-8');
  } catch {
    /* non-fatal — cache is best-effort */
  }
}

function loadFromDisk(): void {
  if (isTestEnv) return;
  try {
    if (!fs.existsSync(CACHE_DIR)) return;
    const files = fs.readdirSync(CACHE_DIR);
    const cutoff = Date.now() - TTL_MS;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    let _loaded = 0;
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const key = file.replace(/\.json$/, '');
      // Skip if already in memory (from this session)
      if (cache.get(key)) continue;
      try {
        const raw = fs.readFileSync(path.join(CACHE_DIR, file), 'utf-8');
        const data = JSON.parse(raw);
        if (data.storedAt && data.storedAt < cutoff) {
          // Expired — clean up
          try {
            fs.unlinkSync(path.join(CACHE_DIR, file));
          } catch {
            /* ok */
          }
          continue;
        }
        if (data.blocks && Array.isArray(data.blocks)) {
          cache.set(key, {
            blocks: data.blocks,
            messageCount: data.messageCount ?? -1,
          });
          _loaded++;
        }
      } catch {
        // Corrupt file — delete it
        try {
          fs.unlinkSync(path.join(CACHE_DIR, file));
        } catch {
          /* ok */
        }
      }
    }
    // Cache entries hydrated from disk silently — no logging to avoid
    // circular dependency with start-proxy.ts
  } catch {
    /* non-fatal */
  }
}

// Hydrate on module load
loadFromDisk();

// --- Public API ---

export function store(
  sessionKeyParam: string | null,
  firstToolUseId: string | null,
  blocks: StoredBlock[],
  messageCount: number = -1,
): void {
  if (!blocks || blocks.length === 0 || !firstToolUseId) return;
  const key = `${sessionKeyParam}:${firstToolUseId}`;
  const entry: CachedEntry = {
    blocks: blocks.map((b) => ({
      type: b.type,
      thinking: b.thinking,
      signature: b.signature || '',
    })),
    messageCount,
  };
  cache.set(key, entry);
  writeToDisk(key, entry);
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
