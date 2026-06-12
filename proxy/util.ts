'use strict';

function normalizeUrlPath(rawPath: string): string {
    // Resolve . and .. segments to prevent path traversal attacks.
    // Does NOT use path.normalize because that targets filesystem paths
    // and produces platform-specific separators.
    if (!rawPath || rawPath === '/') return rawPath;
    const segments = rawPath.split('/');
    const resolved: string[] = [];
    for (const seg of segments) {
        // Loop decodeURIComponent until stable to defeat double-encoding
        // attacks (e.g. %252e%252e → %2e%2e → ..).
        let decoded = seg;
        let prev = '';
        while (decoded !== prev && /%[0-9a-fA-F]{2}/.test(decoded)) {
            prev = decoded;
            try { decoded = decodeURIComponent(decoded); } catch { break; }
        }
        if (decoded === '' || decoded === '.') continue;
        if (decoded === '..') {
            resolved.pop();
        } else {
            resolved.push(seg); // push original segment, not decoded
        }
    }
    return '/' + resolved.join('/');
}

export function deduplicatePath(basePath: string, requestUrl: string): string {
    const normalizedBase = basePath.replace(/\/+$/, '');
    const rawUrl = requestUrl.split('?')[0];
    const normalizedUrl = normalizeUrlPath(rawUrl);
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
    let extraHeaderCount = 0;
    let extraHeaderBytes = 0;
    const MAX_EXTRA_HEADERS = 20;
    const MAX_EXTRA_BYTES = 8192;
    for (const key of Object.keys(upstreamHeaders)) {
        const lc = key.toLowerCase();
        if (SAFE.has(lc)) {
            headers[key] = upstreamHeaders[key];
        } else if (lc.startsWith('x-ratelimit-') || lc.startsWith('x-upstream-')) {
            extraHeaderCount++;
            extraHeaderBytes += key.length + String(upstreamHeaders[key] || '').length;
            if (extraHeaderCount > MAX_EXTRA_HEADERS || extraHeaderBytes > MAX_EXTRA_BYTES) break;
            headers[key] = upstreamHeaders[key];
        }
    }
    return headers;
}

