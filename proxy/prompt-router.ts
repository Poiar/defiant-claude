'use strict';

import type { RoutingConfig, Tier } from './routing';

export interface Classification {
    tier: Tier;
}

const HEAVY_TOKEN_THRESHOLD = 32000;
const TRIVIAL_CHAR_LIMIT = 50;

export function classifyRequest(parsedBody: Record<string, unknown> | null): Classification {
    if (!parsedBody) {
        return { tier: 'CHAT' };
    }

    // Tool definitions present → TOOL tier (takes priority over content-based heuristics)
    const tools = parsedBody.tools;
    if (Array.isArray(tools) && tools.length > 0) {
        return { tier: 'TOOL' };
    }

    const messages = parsedBody.messages;
    if (!Array.isArray(messages)) {
        return { tier: 'CHAT' };
    }

    let toolUseCount = 0;
    let codeBlockCount = 0;
    let totalChars = 0;
    let singleShortMessage = false;

    for (const msg of messages) {
        if (!msg || typeof msg !== 'object') continue;
        const content = (msg as Record<string, unknown>).content;

        if (typeof content === 'string') {
            const str = content as string;
            totalChars += str.length;
            if (str.includes('```')) {
                codeBlockCount++;
            }
            if (messages.length === 1 && str.length < TRIVIAL_CHAR_LIMIT) {
                singleShortMessage = true;
            }
        } else if (Array.isArray(content)) {
            for (const block of content) {
                if (!block || typeof block !== 'object') continue;
                const b = block as Record<string, unknown>;
                if (b.type === 'tool_use') {
                    toolUseCount++;
                }
                if (typeof b.text === 'string') {
                    const text = b.text as string;
                    totalChars += text.length;
                    if (text.includes('```')) {
                        codeBlockCount++;
                    }
                }
            }
        }
    }

    // More than 2 tool_use blocks → HEAVY (complex multi-step tool execution)
    if (toolUseCount > 2) {
        return { tier: 'HEAVY' };
    }

    // Estimated token count > 32K (rough heuristic: chars / 4) → HEAVY
    if (totalChars / 4 > HEAVY_TOKEN_THRESHOLD) {
        return { tier: 'HEAVY' };
    }

    // Code blocks found in message content → CODE
    if (codeBlockCount > 0) {
        return { tier: 'CODE' };
    }

    // Single message with < 50 chars → TRIVIAL (greeting / acknowledgment)
    if (singleShortMessage) {
        return { tier: 'TRIVIAL' };
    }

    // Default: general conversation
    return { tier: 'CHAT' };
}

export function resolvePromptRoute(
    slot: string,
    classification: Classification,
    config: { enabled: boolean; routes: Record<string, Array<{ tier: string; provider: string; model: string }>> },
    _routing: RoutingConfig
): { providerKey: string; rewriteModel: string } | null {
    if (!config.enabled) {
        return null;
    }

    const slotRoutes = config.routes[slot];
    if (!slotRoutes || !Array.isArray(slotRoutes)) {
        return null;
    }

    for (const route of slotRoutes) {
        if (route.tier === classification.tier) {
            return { providerKey: route.provider, rewriteModel: route.model };
        }
    }

    return null;
}
