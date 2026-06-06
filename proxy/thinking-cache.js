'use strict';

const crypto = require('crypto');

const TTL_MS = 30 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

const cache = new Map();
let lastCleanup = 0;

function cleanExpired() {
    const now = Date.now();
    if (now - lastCleanup < CLEANUP_INTERVAL_MS) return;
    lastCleanup = now;
    for (const [key, entry] of cache) {
        if (now > entry.expiresAt) cache.delete(key);
    }
}

function sessionKey(reqBody) {
    if (!reqBody || !reqBody.messages) return null;
    const firstUserMsg = reqBody.messages.find(m => m.role === 'user');
    if (!firstUserMsg) return null;
    const content = typeof firstUserMsg.content === 'string'
        ? firstUserMsg.content
        : (Array.isArray(firstUserMsg.content) ? firstUserMsg.content.map(b => b.text || '').join('') : '');
    return crypto.createHash('md5').update(content.slice(0, 200)).digest('hex');
}

function store(sessionKey, firstToolUseId, blocks) {
    if (!blocks || blocks.length === 0 || !firstToolUseId) return;
    cleanExpired();
    cache.set(`${sessionKey}:${firstToolUseId}`, {
        blocks: blocks.map(b => ({ type: b.type, thinking: b.thinking, signature: b.signature || '' })),
        expiresAt: Date.now() + TTL_MS,
    });
}

function retrieve(sessionKey, firstToolUseId) {
    cleanExpired();
    const entry = cache.get(`${sessionKey}:${firstToolUseId}`);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) { cache.delete(`${sessionKey}:${firstToolUseId}`); return null; }
    return entry.blocks;
}

function injectThinkingBlocks(messages) {
    if (!messages || !Array.isArray(messages)) return 0;
    const sk = sessionKey({ messages });
    if (!sk) return 0;

    let injected = 0;
    for (const msg of messages) {
        if (msg.role !== 'assistant') continue;
        if (typeof msg.content === 'string') continue;
        if (!Array.isArray(msg.content)) continue;

        const hasThinking = msg.content.some(b => b.type === 'thinking');
        if (hasThinking) continue;

        const toolUses = msg.content.filter(b => b.type === 'tool_use');
        if (toolUses.length === 0) continue;

        const firstId = toolUses[0].id;
        const cached = retrieve(sk, firstId);
        if (cached) {
            msg.content = [...cached, ...msg.content];
            injected++;
        }
    }
    return injected;
}

function extractThinkingBlocks(messages) {
    if (!messages || !Array.isArray(messages)) return null;
    const sk = sessionKey({ messages });
    if (!sk) return null;

    for (const msg of messages) {
        if (msg.role !== 'assistant') continue;
        if (typeof msg.content === 'string') continue;
        if (!Array.isArray(msg.content)) continue;

        const thinking = msg.content.filter(b => b.type === 'thinking');
        const toolUses = msg.content.filter(b => b.type === 'tool_use');
        if (thinking.length > 0 && toolUses.length > 0) {
            return { sk, firstToolUseId: toolUses[0].id, blocks: thinking };
        }
    }

    return null;
}

module.exports = { injectThinkingBlocks, extractThinkingBlocks, store };
