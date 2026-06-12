'use strict';

import { LruCache } from './lru-cache';
import { sessionKey } from './session-key';

// 30-minute TTL, bounded to 1000 entries
const TTL_MS = 30 * 60 * 1000;
const MAX_ENTRIES = 1000;

const cache = new LruCache<CachedEntry>({ ttlMs: TTL_MS, maxEntries: MAX_ENTRIES });

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

interface CachedEntry {
    reasoningContent: string;
    messageCount: number;
}

interface ExtractResult {
    sk: string;
    fp: string;
    firstToolCallId: string;
    reasoningContent: string;
}

interface ReinjectResult {
    modified: boolean;
    messages: Message[];
}

export { sessionKey } from './session-key';

// Simple DJB2 hash -- fast, deterministic, no dependency needed.
function hash(str: string): string {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return h.toString(36);
}

// Produce a fingerprint of the last N messages so different conversation
// branches with the same first-user-message don't poison each other's cache.
function computeFingerprint(messages: Message[]): string {
    if (!messages || !Array.isArray(messages) || messages.length === 0) return '';
    const recent = messages.slice(-3);
    const text = recent.map(m => {
        const c = m.content;
        return typeof c === 'string' ? c : JSON.stringify(c);
    }).join('|');
    return hash(text);
}

// Find the LAST assistant message that has both tool_calls and reasoning_content.
// Returns { sk, fp, firstToolCallId, reasoningContent } or null.
export function extractReasoningContent(messages: Message[]): ExtractResult | null {
    if (!messages || !Array.isArray(messages)) return null;
    const sk = sessionKey({ messages });
    if (!sk) return null;
    // Exclude the last message (the current response) so the fingerprint
    // matches what reinjectReasoningContent computes from the request messages.
    const fp = computeFingerprint(messages.slice(0, -1));

    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.role !== 'assistant') continue;
        if (!msg.tool_calls || !Array.isArray(msg.tool_calls) || msg.tool_calls.length === 0) continue;
        if (typeof msg.reasoning_content !== 'string' || !msg.reasoning_content) continue;
        return {
            sk,
            fp,
            firstToolCallId: msg.tool_calls[0].id,
            reasoningContent: msg.reasoning_content,
        };
    }

    return null;
}

// Cache reasoning content keyed by session key + fingerprint + first tool call ID.
export function store(sk: string | null | undefined, firstToolCallId: string | null | undefined, reasoningContent: string | null | undefined, messageCount: number = -1, fp: string = ''): void {
    if (!sk || !firstToolCallId || !reasoningContent) return;
    cache.set(`${sk}:${fp}:${firstToolCallId}`, {
        reasoningContent,
        messageCount,
    });
}

// Retrieve cached reasoning content.
function retrieve(sk: string | null | undefined, firstToolCallId: string | null | undefined, currentMsgCount: number = -1, fp: string = ''): string | undefined {
    if (!sk || !firstToolCallId) return undefined;
    const entry = cache.get(`${sk}:${fp}:${firstToolCallId}`);
    if (!entry) return undefined;
    if (entry.messageCount > 0 && currentMsgCount >= 0 && entry.messageCount !== currentMsgCount) return undefined;
    return entry.reasoningContent;
}

// Scan assistant messages with tool_calls and re-inject reasoning_content
// if it was stripped by the SDK but exists in the cache.
// Modifies messages in place. Returns { modified: boolean, messages }.
export function reinjectReasoningContent(messages: Message[]): ReinjectResult {
    if (!messages || !Array.isArray(messages)) return { modified: false, messages };

    const sk = sessionKey({ messages });
    if (!sk) return { modified: false, messages };

    const fp = computeFingerprint(messages);
    let modified = false;

    for (const msg of messages) {
        if (msg.role !== 'assistant') continue;
        if (!msg.tool_calls || !Array.isArray(msg.tool_calls) || msg.tool_calls.length === 0) continue;
        if (msg.reasoning_content) continue;

        const firstToolCallId = msg.tool_calls[0].id;
        const cached = retrieve(sk, firstToolCallId, messages.length, fp);
        if (cached) {
            msg.reasoning_content = cached;
            modified = true;
        }
    }

    return { modified, messages };
}
