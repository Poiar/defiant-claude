'use strict';
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sessionKey = sessionKey;
const node_crypto_1 = __importDefault(require("node:crypto"));
// Session key -- same algorithm used across thinking-cache, reasoning-cache,
// and momentum modules. Hashes the first user message content plus a truncated
// system prompt hint via SHA-256.
function sessionKey(reqBody) {
    if (!reqBody || !reqBody.messages)
        return null;
    const messages = reqBody.messages;
    const firstUserMsg = messages.find(m => m.role === 'user');
    if (!firstUserMsg)
        return null;
    const content = typeof firstUserMsg.content === 'string'
        ? firstUserMsg.content
        : Array.isArray(firstUserMsg.content)
            ? firstUserMsg.content.map(b => String(b.text || '')).join('')
            : '';
    const systemHint = reqBody.system
        ? (typeof reqBody.system === 'string'
            ? reqBody.system
            : Array.isArray(reqBody.system)
                ? reqBody.system.map(b => String(b.text || '')).join('')
                : '').slice(0, 100)
        : '';
    return node_crypto_1.default.createHash('sha256').update(content + '|' + systemHint).digest('hex').slice(0, 32);
}
