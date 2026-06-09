'use strict';

import { LruCache } from './lru-cache';
import { sessionKey } from './session-key';

// 30-minute TTL, bounded to 1000 entries
const TTL_MS = 30 * 60 * 1000;
const MAX_ENTRIES = 1000;

const cache = new LruCache<string>({ ttlMs: TTL_MS, maxEntries: MAX_ENTRIES });

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

interface ReqBody {
    messages?: Message[];
    system?: string | Array<{ type: string; text?: string }>;
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

// Find the LAST assistant message that has both tool_calls and reasoning_content.
// Returns { sk, firstToolCallId, reasoningContent } or null.
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
export function store(sk: string | null | undefined, firstToolCallId: string | null | undefined, reasoningContent: string | null | undefined): void {
    if (!sk || !firstToolCallId || !reasoningContent) return;
    cache.set(`${sk}:${firstToolCallId}`, reasoningContent);
}

// Retrieve cached reasoning content.
export function get(sk: string | null | undefined, firstToolCallId: string | null | undefined): string | undefined {
    if (!sk || !firstToolCallId) return undefined;
    return cache.get(`${sk}:${firstToolCallId}`);
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
        const cached = get(sk, firstToolCallId);
        if (cached) {
            msg.reasoning_content = cached;
            modified = true;
        }
    }

    return { modified, messages };
}

