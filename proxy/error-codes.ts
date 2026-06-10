'use strict';

// Structured error codes for upstream provider errors.
// Each entry maps a symbolic code to an HTTP status and a human-readable
// message template. Template variables use {placeholder} syntax.

interface ErrorCodeEntry {
    code: string;
    status: number;
    message: string;
    ecode: string;
    suggestion: string;
    fixUrl?: string;
}
interface ApiError {
    type: string;
    message: string;
    error_code: string;
    code?: string;
    upstream_status?: number;
    last_error_body?: string;
    suggestion?: string;
    fixUrl?: string;
}
export const ERROR_CODES: Record<string, ErrorCodeEntry> = {
    AUTH_FAILED:         { code: 'AUTH_FAILED',         status: 401, message: 'Upstream provider rejected credentials',           ecode: 'E001', suggestion: "Check that your API key is set correctly in your environment variables. For DeepSeek, set DEEPSEEK_API_KEY. Get a key at the provider's API key page." },
    FORBIDDEN:           { code: 'FORBIDDEN',           status: 403, message: 'Access denied by upstream provider',                ecode: 'E002', suggestion: 'Your API key does not have access to this resource. Verify the key has the correct permissions at your provider\'s dashboard.' },
    NOT_FOUND:           { code: 'NOT_FOUND',           status: 404, message: 'Resource not found on upstream provider',           ecode: 'E003', suggestion: 'The requested model or endpoint was not found. Verify the model name is correct and available on this provider.' },
    UPSTREAM_TIMEOUT:    { code: 'UPSTREAM_TIMEOUT',    status: 408, message: 'Request to upstream provider exceeded time limit',  ecode: 'E004', suggestion: 'The upstream provider took too long to respond. The proxy retries with fallback providers automatically. If this persists, check your network connection.' },
    RATE_LIMITED:        { code: 'RATE_LIMITED',        status: 429, message: 'Too many requests to upstream provider',            ecode: 'E005', suggestion: 'You\'ve hit the provider\'s rate limit. The proxy will retry with a fallback provider. To avoid this, consider adding additional providers or API keys.' },
    UPSTREAM_ERROR:      { code: 'UPSTREAM_ERROR',      status: 502, message: 'Upstream provider replied with HTTP {status}',      ecode: 'E006', suggestion: 'The upstream provider returned an error (HTTP {status}). Check your provider\'s status page. The proxy will try fallback providers automatically.' },
    UPSTREAM_UNAVAILABLE:{ code: 'UPSTREAM_UNAVAILABLE',status: 503, message: 'Upstream provider is not reachable right now',     ecode: 'E007', suggestion: 'The upstream provider is not reachable. This may be a temporary outage. The proxy will try fallback providers automatically.' },
    GATEWAY_TIMEOUT:     { code: 'GATEWAY_TIMEOUT',     status: 504, message: 'Upstream provider did not respond in time',         ecode: 'E008', suggestion: 'The upstream provider did not respond in time. This is usually temporary. The proxy retries with fallback providers.' },
    STREAM_DEAD:         { code: 'STREAM_DEAD',         status: 502, message: 'Provider returned 200 but stream produced no data',  ecode: 'E009', suggestion: 'The provider accepted the request but produced no response data. This often happens with overloaded providers. The proxy will retry with a fallback.' },
    BODY_TOO_LARGE:      { code: 'BODY_TOO_LARGE',      status: 413, message: 'Request body exceeds 10MB limit',                  ecode: 'E010', suggestion: 'Your request body is too large. Reduce the context size or split your request into smaller parts.' },
    UNKNOWN_PROVIDER:    { code: 'UNKNOWN_PROVIDER',    status: 502, message: 'Unknown provider: {provider}',                     ecode: 'E011', suggestion: 'The provider \'{provider}\' is not configured. Check your config with \'deepclaude --status\' or switch to a known config with \'deepclaude --switch\'.' },
    ALL_PROVIDERS_FAILED:{ code: 'ALL_PROVIDERS_FAILED',status: 502, message: 'All configured providers failed',                  ecode: 'E012', suggestion: 'All configured providers failed. Check your API keys with \'deepclaude --doctor\' and verify your network connection.' },
    NO_DEFAULT_PROVIDER: { code: 'NO_DEFAULT_PROVIDER', status: 502, message: 'No default provider configured',                   ecode: 'E013', suggestion: 'No default provider is configured. Set up a provider with \'deepclaude --switch <config>\' or set DEEPCLAUDE_DEFAULT_BACKEND.' },
};

// Maps HTTP status codes to error codes for quick lookup.
export const STATUS_TO_CODE: Record<number, ErrorCodeEntry> = {
    401: ERROR_CODES.AUTH_FAILED,
    403: ERROR_CODES.FORBIDDEN,
    404: ERROR_CODES.NOT_FOUND,
    408: ERROR_CODES.UPSTREAM_TIMEOUT,
    413: ERROR_CODES.BODY_TOO_LARGE,
    429: ERROR_CODES.RATE_LIMITED,
    502: ERROR_CODES.UPSTREAM_ERROR,
    503: ERROR_CODES.UPSTREAM_UNAVAILABLE,
    504: ERROR_CODES.GATEWAY_TIMEOUT,
};

// Build a structured error object for an HTTP status code.
// Optionally pass the raw upstream body for dev-mode detail extraction.
export function formatError(status: number, templateVars?: Record<string, string> | null, isDev?: boolean): ApiError {
    const entry = STATUS_TO_CODE[status] || {
        code: 'UPSTREAM_ERROR',
        status: status >= 500 ? 502 : status,
        message: 'Upstream provider replied with HTTP ' + status,
        ecode: 'E006',
        suggestion: 'The upstream provider returned an error (HTTP ' + status + '). Check your provider\'s status page. The proxy will try fallback providers automatically.',
    };

    let message = entry.message;
    let suggestion = entry.suggestion;
    if (templateVars) {
        for (const [k, v] of Object.entries(templateVars)) {
            message = message.replace('{' + k + '}', String(v));
            suggestion = suggestion.replace('{' + k + '}', String(v));
        }
    }
    const error: ApiError = { type: 'api_error', message, error_code: entry.ecode };
    if (isDev) {
        error.code = entry.code;
        error.upstream_status = status;
    }
    error.suggestion = suggestion;
    error.fixUrl = entry.fixUrl;
    return error;
}
// Build the final JSON body for exhausted-fallback responses.
// In dev mode, includes the original error detail so developers can debug.
export function formatExhaustedError(lastStatus: number | null | undefined, lastBody: string | null | undefined, isDev?: boolean, qualityReason?: string | null): ApiError {
    const status = lastStatus || 502;
    const base = formatError(status, { status: String(status) }, isDev);
    if (qualityReason) {
        base.message = 'All configured providers failed (last error: ' + qualityReason + ')';
    } else {
        base.message = 'All configured providers failed' + (lastStatus ? ' (last error: ' + lastStatus + ')' : '');
    }
    base.error_code = 'E012';
    base.suggestion = 'All configured providers failed. Check your API keys with \'deepclaude --doctor\' and verify your network connection.';
    if (isDev && lastBody) {
        base.last_error_body = scrubCredentials(String(lastBody).slice(0, 500));
    }
    return base;
}
// --- Credential scrubbing ---
// Redacts API keys, auth tokens, and key-like query parameters from error
// text before logging or returning it to callers.

type CredentialPattern = [RegExp, string];

const CREDENTIAL_PATTERNS: CredentialPattern[] = [
    // Anthropic API keys: sk-ant-..., sk-...
    [/(?:sk-(?:ant-)?)[a-zA-Z0-9_-]{20,}/g, '[redacted]'],
    // OpenAI / generic keys: sk-...
    [/\bsk-[a-zA-Z0-9_-]{20,}\b/g, '[redacted]'],
    // Bearer tokens in headers or logs
    [/\bBearer\s+\S+/gi, 'Bearer [redacted]'],
    // Query-param keys (key=... in URLs or error text)
    [/\bkey=[^&\s"',;]+/gi, 'key=[redacted]'],
    // x-api-key headers
    [/\bx-api-key:\s*\S+/gi, 'x-api-key: [redacted]'],
    // Google API keys (AIza prefix, 25+ chars)
    [/\bAIza[0-9A-Za-z_-]{25,}\b/g, '[redacted]'],
    // xAI / Grok keys (xai- prefix)
    [/\bxai-[a-zA-Z0-9_-]{20,}\b/g, '[redacted]'],
    // OpenAI project keys (sk-proj- prefix)
    [/\bsk-proj-[a-zA-Z0-9_-]{20,}\b/g, '[redacted]'],
    // OpenRouter keys (sk-or- prefix)
    [/\bsk-or-[a-zA-Z0-9_-]{20,}\b/g, '[redacted]'],
    // Hugging Face tokens (hf_ prefix)
    [/\bhf_[a-zA-Z0-9_-]{20,}\b/g, '[redacted]'],
    // Keys embedded in JSON string values (api_key, apiKey, secret, token, apikey)
    [/"(api_key|apiKey|apikey|secret|token)"\s*:\s*"[a-zA-Z0-9_-]{20,}"/gi, '"$1": "[redacted]"'],
    // Authorization headers with non-Bearer schemes (Basic, ApiKey, Token)
    [/\b(Authorization|Proxy-Authorization):\s*(Basic|ApiKey|Token)\s+\S+/gi, '$1: $2 [redacted]'],
    // URL-encoded secrets in query strings (secret=, token=, api_key=, apikey=, api-key=)
    [/\b(secret|token|api_key|apikey|api-key)=[^&\s"',;]{8,}/gi, '$1=[redacted]'],
    // GitHub tokens (ghp_, ghs_, gho_)
    [/\bgh[pso]_[a-zA-Z0-9_]{36,}\b/g, '[redacted]'],
    // GitHub PAT (github_pat_)
    [/\bgithub_pat_[a-zA-Z0-9_]{82,}\b/g, '[redacted]'],
    // AWS access keys (AKIA prefix)
    [/\bAKIA[0-9A-Z]{16}\b/g, '[redacted]'],
    // JWT tokens
    [/\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/g, '[redacted]'],
    // Password fields in JSON
    [/"(password|passwd|pass|pwd)"\s*:\s*"[^"]{3,}"/gi, '"$1": "[redacted]"'],
];

export function scrubCredentials(msg: unknown): string {
    let cleaned = String(msg);
    for (const [pattern, replacement] of CREDENTIAL_PATTERNS) {
        cleaned = cleaned.replace(pattern, replacement);
    }
    return cleaned;
}
// Check whether a client is a chat/streaming client (should get friendly
// SSE errors) vs a tool/SDK (should get real HTTP status codes).
export function isStreamingClient(headers: Record<string, string | string[] | undefined>, parsedBody: Record<string, unknown> | null | undefined): boolean {
    if (parsedBody && parsedBody.stream === true) return true;
    const accept = headers['accept'] || '';
    return accept.includes('text/event-stream');
}
// Return just the machine-readable error code for a given HTTP status.
// Returns undefined if no entry matches the status.
export function getErrorCode(status: number | null | undefined): string | undefined {
    const entry = STATUS_TO_CODE[status as number];
    return entry ? entry.ecode : undefined;
};
