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
export function buildFriendlyResponse(
  lastStatus: number | null | undefined,
  model: string | null | undefined,
  attemptedProviders: AttemptedProvider[] | null | undefined,
  qualityReason?: string | null,
): FriendlyResponse {
  const triedList =
    (attemptedProviders || []).map((p) => p.providerKey || 'unknown').join(', ') ||
    'all configured providers';
  let errorMsg: string;
  if (qualityReason) {
    errorMsg =
      'All AI providers are currently unavailable (tried: ' +
      triedList +
      '). Last error: ' +
      qualityReason +
      '. The proxy will try other providers automatically.';
  } else {
    errorMsg =
      'All AI providers are currently unavailable (tried: ' +
      triedList +
      '). Last error: HTTP ' +
      (lastStatus || 'connection failure') +
      '. Please check provider status or API key configuration.';
  }

  const messageId = 'msg_fallback_' + Date.now().toString(36);
  const modelName = model || 'unknown';

  return {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'x-fallback-exhausted': 'true',
      'x-defiant-error': 'E012',
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
export function buildFriendlyStreamEvents(
  lastStatus: number | null | undefined,
  model: string | null | undefined,
  attemptedProviders: AttemptedProvider[] | null | undefined,
  qualityReason?: string | null,
): string {
  const triedList = (attemptedProviders || []).map((p) => p.providerKey || 'unknown').join(', ');
  let errorMsg: string;
  if (qualityReason) {
    errorMsg =
      'All AI providers are currently unavailable (tried: ' +
      triedList +
      '). Last error: ' +
      qualityReason +
      '.';
  } else {
    errorMsg =
      'All AI providers are currently unavailable (tried: ' +
      triedList +
      '). Last error: HTTP ' +
      (lastStatus || 'connection failure') +
      '.';
  }

  const errorEvent = {
    type: 'error',
    error: {
      type: 'api_error',
      message: errorMsg,
    },
    _defiant: {
      error_code: 'E012',
      attempted_providers: triedList,
    },
  };

  const stopEvent = { type: 'message_stop' };

  const msgId = 'msg_exhausted_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  const messageStart = {
    type: 'message_start',
    message: {
      id: msgId,
      type: 'message',
      role: 'assistant',
      model: model || 'unknown',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  };

  return (
    'event: message_start\ndata: ' +
    JSON.stringify(messageStart) +
    '\n\n' +
    'event: error\ndata: ' +
    JSON.stringify(errorEvent) +
    '\n\n' +
    'event: message_stop\ndata: ' +
    JSON.stringify(stopEvent) +
    '\n\n' +
    'data: [DONE]\n\n'
  );
}
