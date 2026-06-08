'use strict';

// Detects and classifies upstream network failures by inspecting error
// properties (name, message, code) and walking the cause chain. Each
// classifier maps a symptom pattern to a human-readable label and the
// appropriate HTTP status code for the proxy response.

interface Classification {
    label: string;
    httpStatus: number;
}

type FailureSignature = [RegExp, string, number];

// Ordered list of [regex, label, httpStatus] tuples. First match wins --
// order matters: put specific patterns before general ones.
const FAILURE_SIGNATURES: FailureSignature[] = [
    // DNS / host resolution failures
    [/ENOTFOUND|EAI_AGAIN|getaddrinfo|DNS|resolution/i, 'DNS resolution failed', 502],
    [/ECONNREFUSED/i, 'Connection refused by upstream', 502],
    [/ECONNRESET/i, 'Connection reset by upstream', 502],

    // TLS / certificate errors
    [/CERT_|UNABLE_TO_VERIFY|self.signed|certificate|EPROTO|SSL|TLS/i, 'TLS connection failed', 502],

    // Timeouts
    [/ETIMEDOUT|timed?[\s_-]?out/i, 'Upstream connection timed out', 504],

    // Stream stalled (connection established, but no data received)
    [/stream read timeout/i, 'Upstream stream stalled (no data received)', 502],

    // Aborts (client disconnect or intentional cancel)
    [/AbortError|aborted|cancelled/i, 'Request aborted', 499],

    // Socket / pipe errors
    [/EPIPE|ESOCKET|socket hang/i, 'Upstream connection lost', 502],

    // Generic network failures
    [/fetch failed|network|ENETUNREACH|EHOSTUNREACH|EAI_FAIL/i, 'Network unreachable', 502],
];

// Walk through an error object's properties and nested causes, collecting
// all text fragments for pattern matching.
function collectFragments(err: Record<string, unknown>): string[] {
    const parts: string[] = [];
    if (!err) return parts;

    if (err.name) parts.push(String(err.name));
    if (err.message) parts.push(String(err.message));
    if (err.code) parts.push(String(err.code));

    // Walk the cause chain (max depth 3 to avoid cycles)
    let cause: Record<string, unknown> | undefined = err.cause as Record<string, unknown> | undefined;
    for (let depth = 0; cause && depth < 3; depth++) {
        if (cause.name) parts.push(String(cause.name));
        if (cause.message) parts.push(String(cause.message));
        if (cause.code) parts.push(String(cause.code));
        cause = cause.cause as Record<string, unknown> | undefined;
    }

    return parts;
}

// Classify a transport error. Returns { label, httpStatus } or null
// if the error doesn't match any known transport pattern.
export function classify(err: Record<string, unknown> | null | undefined): Classification | null {
    if (!err) return null;

    const fragments = collectFragments(err).join(' ');
    if (!fragments) return null;

    for (const [re, label, httpStatus] of FAILURE_SIGNATURES) {
        if (re.test(fragments)) {
            return { label, httpStatus };
        }
    }

    return null;
}

// Check whether an error is a network-level failure (DNS, connection, TLS,
// timeout, abort, etc.) rather than an application-level HTTP response error.
export function isNetworkFailure(err: Record<string, unknown> | null | undefined): boolean {
    return classify(err) !== null;
}

// Build a user-facing error message from a transport error.
// Returns a short string suitable for logs or error responses.
export function describe(err: Error | Record<string, unknown> | null | undefined): string {
    const match = classify(err as Record<string, unknown> | null | undefined);
    if (match) {
        const detail = err && err.message ? ': ' + String(err.message) : '';
        return match.label + detail;
    }
    // Fallback: use the error message directly, truncated
    const raw = (err && err.message) ? String(err.message) : 'Unknown transport error';
    return raw.slice(0, 200);
}

