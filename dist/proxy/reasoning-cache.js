'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
exports.sessionKey = void 0;
exports.extractReasoningContent = extractReasoningContent;
exports.store = store;
exports.get = get;
exports.reinjectReasoningContent = reinjectReasoningContent;
const lru_cache_1 = require("./lru-cache");
const session_key_1 = require("./session-key");
// 30-minute TTL, bounded to 1000 entries
const TTL_MS = 30 * 60 * 1000;
const MAX_ENTRIES = 1000;
const cache = new lru_cache_1.LruCache({ ttlMs: TTL_MS, maxEntries: MAX_ENTRIES });
var session_key_2 = require("./session-key");
Object.defineProperty(exports, "sessionKey", { enumerable: true, get: function () { return session_key_2.sessionKey; } });
// Find the LAST assistant message that has both tool_calls and reasoning_content.
// Returns { sk, firstToolCallId, reasoningContent } or null.
function extractReasoningContent(messages) {
    if (!messages || !Array.isArray(messages))
        return null;
    const sk = (0, session_key_1.sessionKey)({ messages });
    if (!sk)
        return null;
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.role !== 'assistant')
            continue;
        if (!msg.tool_calls || !Array.isArray(msg.tool_calls) || msg.tool_calls.length === 0)
            continue;
        if (typeof msg.reasoning_content !== 'string' || !msg.reasoning_content)
            continue;
        return {
            sk,
            firstToolCallId: msg.tool_calls[0].id,
            reasoningContent: msg.reasoning_content,
        };
    }
    return null;
}
// Cache reasoning content keyed by session key + first tool call ID.
function store(sk, firstToolCallId, reasoningContent) {
    if (!sk || !firstToolCallId || !reasoningContent)
        return;
    cache.set(`${sk}:${firstToolCallId}`, reasoningContent);
}
// Retrieve cached reasoning content.
function get(sk, firstToolCallId) {
    if (!sk || !firstToolCallId)
        return undefined;
    return cache.get(`${sk}:${firstToolCallId}`);
}
// Scan assistant messages with tool_calls and re-inject reasoning_content
// if it was stripped by the SDK but exists in the cache.
// Modifies messages in place. Returns { modified: boolean, messages }.
function reinjectReasoningContent(messages) {
    if (!messages || !Array.isArray(messages))
        return { modified: false, messages };
    const sk = (0, session_key_1.sessionKey)({ messages });
    if (!sk)
        return { modified: false, messages };
    let modified = false;
    for (const msg of messages) {
        if (msg.role !== 'assistant')
            continue;
        if (!msg.tool_calls || !Array.isArray(msg.tool_calls) || msg.tool_calls.length === 0)
            continue;
        if (msg.reasoning_content)
            continue;
        const firstToolCallId = msg.tool_calls[0].id;
        const cached = get(sk, firstToolCallId);
        if (cached) {
            msg.reasoning_content = cached;
            modified = true;
        }
    }
    return { modified, messages };
}
