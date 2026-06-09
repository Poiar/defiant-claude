'use strict';

import crypto from 'node:crypto';

// Session key -- same algorithm used across thinking-cache, reasoning-cache,
// and momentum modules. Hashes the first user message content plus a truncated
// system prompt hint via SHA-256.
export function sessionKey(reqBody: Record<string, unknown> | null | undefined): string | null {
    if (!reqBody || !reqBody.messages) return null;
    const messages = reqBody.messages as Array<Record<string, unknown>>;
    const firstUserMsg = messages.find(m => m.role === 'user');
    if (!firstUserMsg) return null;
    const content = typeof firstUserMsg.content === 'string'
        ? firstUserMsg.content
        : Array.isArray(firstUserMsg.content)
            ? (firstUserMsg.content as Array<Record<string, unknown>>).map(b => String(b.text || '')).join('')
            : '';
    const systemHint = reqBody.system
        ? (typeof reqBody.system === 'string'
            ? reqBody.system
            : Array.isArray(reqBody.system)
                ? (reqBody.system as Array<Record<string, unknown>>).map(b => String(b.text || '')).join('')
                : ''
          ).slice(0, 100)
        : '';
    return crypto.createHash('sha256')
        .update(content)
        .update('\x00')
        .update(systemHint)
        .digest('hex')
        .slice(0, 32);
}
