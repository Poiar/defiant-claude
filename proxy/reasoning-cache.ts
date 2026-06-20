'use strict';

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { LruCache } from './lru-cache';
import { sessionKey } from './session-key';

// 24-hour TTL, bounded to 10000 entries. Matches DeepSeek's hours-to-days
// disk cache persistence — a 30-min TTL caused cache misses on idle gaps.
const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 10000;

// Persist to ~/.defiant/reasoning-cache/ so cached reasoning survives proxy
// restarts. Without this, kill+resume causes OpenAI-format providers to lose
// reasoning_content between turns → cache misses.
const CACHE_DIR = path.join(
  process.env.DEFIANT_CONFIG_DIR ||
    path.join(process.env.HOME || process.env.USERPROFILE || '.', '.defiant'),
  'reasoning-cache',
);

const cache = new LruCache<CachedEntry>({ ttlMs: TTL_MS, maxEntries: MAX_ENTRIES });

function hashKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 32);
}

// --- Disk persistence ---

const isTestEnv = process.env.JEST_WORKER_ID !== undefined || process.env.NODE_ENV === 'test';

function writeToDisk(key: string, entry: CachedEntry): void {
  if (isTestEnv) return;
  try {
    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
    }
    const fname = hashKey(key) + '.json';
    fs.writeFileSync(
      path.join(CACHE_DIR, fname),
      JSON.stringify({
        key,
        reasoningContent: entry.reasoningContent,
        storedAt: Date.now(),
      }),
      'utf-8',
    );
  } catch {
    /* non-fatal */
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
        if (!data.key || typeof data.reasoningContent !== 'string') {
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
          reasoningContent: data.reasoningContent,
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

loadFromDisk();

// --- Types ---

interface MessageBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface ToolCall {
  id: string;
  type: string;
  function: { name: string; arguments: string };
}

export interface Message {
  role: string;
  content?: string | MessageBlock[];
  tool_calls?: ToolCall[];
  reasoning_content?: string;
}

interface CachedEntry {
  reasoningContent: string;
}

interface ExtractResult {
  sk: string;
  firstToolCallId: string;
  reasoningContent: string;
}

interface ReinjectResult {
  modified: boolean;
  messages: Message[];
}

export { sessionKey } from './session-key';

export function extractReasoningContent(messages: Message[]): ExtractResult | null {
  if (!messages || !Array.isArray(messages)) return null;
  const sk = sessionKey({ messages });
  if (!sk) return null;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'assistant') continue;
    if (!msg.tool_calls || !Array.isArray(msg.tool_calls) || msg.tool_calls.length === 0) continue;
    if (typeof msg.reasoning_content !== 'string' || !msg.reasoning_content) continue;
    return {
      sk,
      firstToolCallId: msg.tool_calls[0].id,
      reasoningContent: msg.reasoning_content,
    };
  }

  return null;
}

// Cache reasoning content keyed by session key + first tool call ID.
// The first tool call ID is a UUID (unique per call), so the conversation
// fingerprint is redundant. Dropping it fixes the same cache-miss bug
// fixed in thinking-cache.ts: extraction and injection computed different
// fingerprints because the last-3-messages window shifts between turns.
export function store(
  sk: string | null | undefined,
  firstToolCallId: string | null | undefined,
  reasoningContent: string | null | undefined,
): void {
  if (!sk || !firstToolCallId || !reasoningContent) return;
  const key = `${sk}|${firstToolCallId}`;
  const entry: CachedEntry = { reasoningContent };
  cache.set(key, entry);
  writeToDisk(key, entry);
}

// Retrieve cached reasoning content.
function retrieve(
  sk: string | null | undefined,
  firstToolCallId: string | null | undefined,
): string | undefined {
  if (!sk || !firstToolCallId) return undefined;
  const entry = cache.get(`${sk}|${firstToolCallId}`);
  if (!entry) return undefined;
  return entry.reasoningContent;
}

// Scan assistant messages with tool_calls and re-inject reasoning_content
// if it was stripped by the SDK but exists in the cache.
// Modifies messages in place. Returns { modified: boolean, messages }.
export function reinjectReasoningContent(messages: Message[]): ReinjectResult {
  if (!messages || !Array.isArray(messages)) return { modified: false, messages };

  const sk = sessionKey({ messages });
  if (!sk) return { modified: false, messages };

  let modified = false;

  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    if (!msg.tool_calls || !Array.isArray(msg.tool_calls) || msg.tool_calls.length === 0) continue;
    if (msg.reasoning_content) continue;

    const firstToolCallId = msg.tool_calls[0].id;
    const cached = retrieve(sk, firstToolCallId, messages.length);
    if (cached) {
      msg.reasoning_content = cached;
      modified = true;
    }
  }

  return { modified, messages };
}
