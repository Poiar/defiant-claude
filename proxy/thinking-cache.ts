'use strict';

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { LruCache } from './lru-cache';
import { sessionKey } from './session-key';

// 24-hour TTL, bounded to 10000 entries. DeepSeek's disk cache persists
// "hours to days" — a 30-min TTL caused cache misses on idle gaps >30min
// (50× cost: $0.435/M miss vs $0.0036/M hit). LruCache handles expiry and
// eviction automatically via its shared cleanup timer.
const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 10000;

// Persist to ~/.deepclaude/thinking-cache/ so cached thinking blocks survive
// proxy restarts. Without this, kill+resume causes DeepSeek prefix cache misses
// at 120× cost ($0.435/M vs $0.0036/M).
const CACHE_DIR = path.join(
  process.env.DEEPCLAUDE_CONFIG_DIR ||
    path.join(process.env.HOME || process.env.USERPROFILE || '.', '.deepclaude'),
  'thinking-cache',
);

const cache = new LruCache<CachedEntry>({ ttlMs: TTL_MS, maxEntries: MAX_ENTRIES });

// Hash a cache key to a safe filename (hex only, valid on all platforms).
// The cache key contains | and tool_use IDs — not safe for NTFS.
function hashKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 32);
}

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
}

// --- Disk persistence ---

const isTestEnv = process.env.JEST_WORKER_ID !== undefined || process.env.NODE_ENV === 'test';

function writeToDisk(key: string, entry: CachedEntry): void {
  if (isTestEnv) return;
  try {
    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
    }
    const data = JSON.stringify({
      key, // store original key so we can reconstruct on load
      blocks: entry.blocks,
      storedAt: Date.now(),
    });
    const fname = hashKey(key) + '.json';
    fs.writeFileSync(path.join(CACHE_DIR, fname), data, 'utf-8');
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
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const fpath = path.join(CACHE_DIR, file);
      try {
        const raw = fs.readFileSync(fpath, 'utf-8');
        const data = JSON.parse(raw);
        if (!data.key || !data.blocks) {
          // Malformed or old-format file — remove
          try {
            fs.unlinkSync(fpath);
          } catch {
            /* ok */
          }
          continue;
        }
        if (data.storedAt && data.storedAt < cutoff) {
          try {
            fs.unlinkSync(fpath);
          } catch {
            /* ok */
          }
          continue;
        }
        if (cache.get(data.key)) continue;
        cache.set(data.key, {
          blocks: data.blocks,
        });
      } catch {
        try {
          fs.unlinkSync(fpath);
        } catch {
          /* ok */
        }
      }
    }
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
): void {
  if (!blocks || blocks.length === 0 || !firstToolUseId) return;
  const key = `${sessionKeyParam}|${firstToolUseId}`;
  const entry: CachedEntry = {
    blocks: blocks.map((b) => ({
      type: b.type,
      thinking: b.thinking,
      signature: b.signature || '',
    })),
  };
  cache.set(key, entry);
  writeToDisk(key, entry);
}

function retrieve(
  sessionKeyParam: string | null,
  firstToolUseId: string | null,
): StoredBlock[] | null {
  const entry = cache.get(`${sessionKeyParam}|${firstToolUseId}`);
  if (!entry) return null;
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
    const cached = retrieve(sk, firstId!);
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
