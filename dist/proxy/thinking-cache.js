'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
exports.store = store;
exports.injectThinkingBlocks = injectThinkingBlocks;
exports.extractThinkingBlocks = extractThinkingBlocks;
const lru_cache_1 = require("./lru-cache");
const session_key_1 = require("./session-key");
// 30-minute TTL, bounded to 1000 entries. LruCache handles expiry and
// eviction automatically via its shared cleanup timer.
const TTL_MS = 30 * 60 * 1000;
const MAX_ENTRIES = 1000;
const cache = new lru_cache_1.LruCache({ ttlMs: TTL_MS, maxEntries: MAX_ENTRIES });
// Simple DJB2 hash -- fast, deterministic, no dependency needed.
function hash(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++)
        h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return h.toString(36);
}
// Produce a fingerprint of the last N messages so different conversation
// branches with the same first-user-message don't poison each other's cache.
function computeFingerprint(messages) {
    if (!messages || !Array.isArray(messages) || messages.length === 0)
        return '';
    const recent = messages.slice(-3);
    const text = recent.map(m => {
        const c = m.content;
        return typeof c === 'string' ? c : JSON.stringify(c);
    }).join('|');
    return hash(text);
}
function store(sessionKeyParam, firstToolUseId, blocks, messageCount = 0, fp = '') {
    if (!blocks || blocks.length === 0 || !firstToolUseId)
        return;
    cache.set(`${sessionKeyParam}:${fp}:${firstToolUseId}`, {
        blocks: blocks.map(b => ({ type: b.type, thinking: b.thinking, signature: b.signature || '' })),
        messageCount,
    });
}
function retrieve(sessionKeyParam, firstToolUseId, currentMsgCount = -1, fp = '') {
    const entry = cache.get(`${sessionKeyParam}:${fp}:${firstToolUseId}`);
    if (!entry)
        return null;
    if (entry.messageCount > 0 && currentMsgCount >= 0 && entry.messageCount !== currentMsgCount)
        return null;
    return entry.blocks;
}
function injectThinkingBlocks(messages) {
    if (!messages || !Array.isArray(messages))
        return 0;
    const sk = (0, session_key_1.sessionKey)({ messages });
    if (!sk)
        return 0;
    const fp = computeFingerprint(messages);
    let injected = 0;
    for (const msg of messages) {
        if (msg.role !== 'assistant')
            continue;
        if (typeof msg.content === 'string')
            continue;
        if (!Array.isArray(msg.content))
            continue;
        const hasThinking = msg.content.some(b => b.type === 'thinking');
        if (hasThinking)
            continue;
        const toolUses = msg.content.filter(b => b.type === 'tool_use');
        if (toolUses.length === 0)
            continue;
        const firstId = toolUses[0].id;
        const cached = retrieve(sk, firstId, messages.length, fp);
        if (cached) {
            msg.content = [...cached, ...msg.content];
            injected++;
        }
    }
    return injected;
}
function extractThinkingBlocks(messages) {
    if (!messages || !Array.isArray(messages))
        return null;
    const sk = (0, session_key_1.sessionKey)({ messages });
    if (!sk)
        return null;
    // Exclude the last message (the current response) so the fingerprint
    // matches what injectThinkingBlocks computes from the request messages.
    const fp = computeFingerprint(messages.slice(0, -1));
    for (const msg of messages) {
        if (msg.role !== 'assistant')
            continue;
        if (typeof msg.content === 'string')
            continue;
        if (!Array.isArray(msg.content))
            continue;
        const blocks = msg.content;
        const thinking = blocks.filter(b => b.type === 'thinking');
        const toolUses = blocks.filter(b => b.type === 'tool_use');
        if (thinking.length > 0 && toolUses.length > 0) {
            return { sk, fp, firstToolUseId: toolUses[0].id, blocks: thinking };
        }
    }
    return null;
}
