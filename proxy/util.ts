'use strict';

export function deduplicatePath(basePath: string, requestUrl: string): string {
    const normalizedBase = basePath.replace(/\/+$/, '');
    const normalizedUrl = requestUrl.split('?')[0];
    let overlap = '';
    for (let i = 1; i <= Math.min(normalizedBase.length, normalizedUrl.length); i++) {
        if (normalizedBase.endsWith(normalizedUrl.substring(0, i))) {
            overlap = normalizedUrl.substring(0, i);
        }
    }
    return overlap
        ? normalizedBase + normalizedUrl.substring(overlap.length)
        : normalizedBase + normalizedUrl;
}

export function buildSafeHeaders(upstreamHeaders: Record<string, string | string[] | undefined>, extraHeaders?: Record<string, string>): Record<string, string | string[] | undefined> {
    const SAFE = new Set(['content-type', 'x-request-id', 'cache-control', 'retry-after', 'date']);
    const headers: Record<string, string | string[] | undefined> = {};
    if (extraHeaders) {
        for (const k in extraHeaders) { headers[k] = extraHeaders[k]; }
    }
    for (const key of Object.keys(upstreamHeaders)) {
        const lc = key.toLowerCase();
        if (SAFE.has(lc) || lc.startsWith('x-ratelimit-') || lc.startsWith('x-upstream-')) {
            headers[key] = upstreamHeaders[key];
        }
    }
    return headers;
}

