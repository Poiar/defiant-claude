'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildFriendlyResponse = buildFriendlyResponse;
exports.buildFriendlyStreamEvents = buildFriendlyStreamEvents;
function buildFriendlyResponse(lastStatus, model, attemptedProviders, qualityReason) {
    const triedList = (attemptedProviders || [])
        .map(p => p.providerKey || 'unknown')
        .join(', ') || 'all configured providers';
    let errorMsg;
    if (qualityReason) {
        errorMsg = 'All AI providers are currently unavailable (tried: ' + triedList +
            '). Last error: ' + qualityReason +
            '. The proxy will try other providers automatically.';
    }
    else {
        errorMsg = 'All AI providers are currently unavailable (tried: ' + triedList +
            '). Last error: HTTP ' + (lastStatus || 'connection failure') +
            '. Please check provider status or API key configuration.';
    }
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
function buildFriendlyStreamEvents(lastStatus, model, attemptedProviders, qualityReason) {
    const triedList = (attemptedProviders || [])
        .map(p => p.providerKey || 'unknown')
        .join(', ');
    let errorMsg;
    if (qualityReason) {
        errorMsg = 'All AI providers are currently unavailable (tried: ' + triedList +
            '). Last error: ' + qualityReason + '.';
    }
    else {
        errorMsg = 'All AI providers are currently unavailable (tried: ' + triedList +
            '). Last error: HTTP ' + (lastStatus || 'connection failure') + '.';
    }
    const errorEvent = {
        error_code: 'E012',
        message: errorMsg,
        type: 'exhausted',
    };
    const stopEvent = { type: 'message_stop' };
    return 'event: error\ndata: ' + JSON.stringify(errorEvent) + '\n\n' +
        'event: message_stop\ndata: ' + JSON.stringify(stopEvent) + '\n\n' +
        'data: [DONE]\n\n';
}
;
