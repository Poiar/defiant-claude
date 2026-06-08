'use strict';

import crypto from 'crypto';
import { LruCache } from './lru-cache';

// 30-minute TTL, bounded to 1000 entries. LruCache handles expiry and
// eviction automatically via its shared cleanup timer.
const TTL_MS = 30 * 60 * 1000;
const MAX_ENTRIES = 1000;

const cache = new LruCache({ ttlMs: TTL_MS, maxEntries: MAX_ENTRIES });

// --- Types ---

interface MessageBlock {
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

interface ReqBody {
    messages?: Message[];
    system?: string | Array<{ type: string; text?: string }>;
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

function sessionKey(reqBody: ReqBody | null | undefined): string | null {
    if (!reqBody || !reqBody.messages) return null;
    const firstUserMsg = reqBody.messages.find(m => m.role === 'user');
    if (!firstUserMsg) return null;
    const content = typeof firstUserMsg.content === 'string'
        ? firstUserMsg.content
        : (Array.isArray(firstUserMsg.content) ? (firstUserMsg.content as MessageBlock[]).map(b => b.text || '').join('') : '');
    const systemHint = reqBody.system
        ? (typeof reqBody.system === 'string' ? reqBody.system : (Array.isArray(reqBody.system) ? (reqBody.system as Array<{ type: string; text?: string }>).map(b => b.text || '').join('') : '')).slice(0, 100)
        : '';
    return crypto.createHash('sha256').update(content + '|' + systemHint).digest('hex').slice(0, 32);
}

export function store(sessionKeyParam: string | null, firstToolUseId: string | null, blocks: StoredBlock[], messageCount: number = 0, fp: string = ''): void {
    if (!blocks || blocks.length === 0 || !firstToolUseId) return;
    cache.set(`${sessionKeyParam}:${fp}:${firstToolUseId}`, {
        blocks: blocks.map(b => ({ type: b.type, thinking: b.thinking, signature: b.signature || '' })),
        messageCount,
    });
}

function retrieve(sessionKeyParam: string | null, firstToolUseId: string | null, currentMsgCount: number = -1, fp: string = ''): StoredBlock[] | null {
    const entry = cache.get(`${sessionKeyParam}:${fp}:${firstToolUseId}`) as CachedEntry | undefined;
    if (!entry) return null;
    if (entry.messageCount > 0 && currentMsgCount >= 0 && entry.messageCount !== currentMsgCount) return null;
    return entry.blocks;
}

export function injectThinkingBlocks(messages: Message[]): number {
    if (!messages || !Array.isArray(messages)) return 0;
    const sk = sessionKey({ messages });
    if (!sk) return 0;
    const fp = computeFingerprint(messages);

    let injected = 0;
    for (const msg of messages) {
        if (msg.role !== 'assistant') continue;
        if (typeof msg.content === 'string') continue;
        if (!Array.isArray(msg.content)) continue;

        const hasThinking = (msg.content as MessageBlock[]).some(b => b.type === 'thinking');
        if (hasThinking) continue;

        const toolUses = (msg.content as MessageBlock[]).filter(b => b.type === 'tool_use');
        if (toolUses.length === 0) continue;

        const firstId = toolUses[0].id;
        const cached = retrieve(sk, firstId!, messages.length, fp);
        if (cached) {
            msg.content = [...cached, ...(msg.content as MessageBlock[])];
            injected++;
        }
    }
    return injected;
}

interface ExtractResult {
    sk: string;
    fp: string;
    firstToolUseId: string;
    blocks: StoredBlock[];
}

export function extractThinkingBlocks(messages: Message[]): ExtractResult | null {
    if (!messages || !Array.isArray(messages)) return null;
    const sk = sessionKey({ messages });
    if (!sk) return null;
    // Exclude the last message (the current response) so the fingerprint
    // matches what injectThinkingBlocks computes from the request messages.
    const fp = computeFingerprint(messages.slice(0, -1));

    for (const msg of messages) {
        if (msg.role !== 'assistant') continue;
        if (typeof msg.content === 'string') continue;
        if (!Array.isArray(msg.content)) continue;

        const blocks = msg.content as MessageBlock[];
        const thinking = blocks.filter(b => b.type === 'thinking');
        const toolUses = blocks.filter(b => b.type === 'tool_use');
        if (thinking.length > 0 && toolUses.length > 0) {
            return { sk, fp, firstToolUseId: toolUses[0].id!, blocks: thinking as StoredBlock[] };
        }
    }

    return null;
}

