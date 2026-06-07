'use strict';

// Conversational error messages for when all providers fail.
// Returns Anthropic Messages API-compatible responses so that AI agents
// (Claude Code, etc.) surface errors gracefully instead of crashing on
// raw HTTP 502 errors.

interface FriendlyResponse {
    status: number;
    headers: Record<string, string>;
    body: string;
}
interface AttemptedProvider {
    providerKey?: string;
}
export function buildFriendlyResponse(lastStatus: number | null | undefined, _lastRawBody: string | null | undefined, model: string | null | undefined, attemptedProviders: AttemptedProvider[] | null | undefined): FriendlyResponse {
    const triedList = (attemptedProviders || [])
        .map(p => p.providerKey || 'unknown')
        .join(', ') || 'all configured providers';
    const errorMsg = 'All AI providers are currently unavailable (tried: ' + triedList +
        '). Last error: HTTP ' + (lastStatus || 'connection failure') +
        '. Please check provider status or API key configuration.';

    const messageId = 'msg_fallback_' + Date.now().toString(36);
    const modelName = model || 'unknown';

    return {
        status: 200,
        headers: {
            'content-type': 'application/json',
            'x-fallback-exhausted': 'true',
            'x-attempted-providers': triedList,
        },
        body: JSON.stringify({
            id: messageId,
            type: 'message',
            role: 'assistant',
            model: modelName,
            content: [{ type: 'text', text: errorMsg }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 0, output_tokens: 0 },
        }),
    };
}
export function buildFriendlyStreamEvents(lastStatus: number | null | undefined, _lastRawBody: string | null | undefined, model: string | null | undefined, attemptedProviders: AttemptedProvider[] | null | undefined): string {
    const triedList = (attemptedProviders || [])
        .map(p => p.providerKey || 'unknown')
        .join(', ');
    const errorMsg = 'All AI providers are currently unavailable (tried: ' + triedList +
        '). Last error: HTTP ' + (lastStatus || 'connection failure') + '.';

    const errorEvent = {
        error_code: 'E012',
        message: errorMsg,
        type: 'exhausted',
    };

    const stopEvent = { type: 'message_stop' };

    return 'event: error\ndata: ' + JSON.stringify(errorEvent) + '\n\n' +
        'event: message_stop\ndata: ' + JSON.stringify(stopEvent) + '\n\n' +
        'data: [DONE]\n\n';
};
