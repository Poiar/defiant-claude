'use strict';

function deduplicatePath(basePath, requestUrl) {
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

function safeJsonParse(str, fallback) {
    try { return JSON.parse(str); } catch (e) { return fallback; }
}

function buildSafeHeaders(upstreamHeaders, extraHeaders) {
    var SAFE = ['content-type', 'x-request-id', 'cache-control'];
    var headers = {};
    if (extraHeaders) {
        for (var k in extraHeaders) { headers[k] = extraHeaders[k]; }
    }
    for (var i = 0; i < SAFE.length; i++) {
        if (upstreamHeaders[SAFE[i]]) headers[SAFE[i]] = upstreamHeaders[SAFE[i]];
    }
    if (!headers['content-type'] && upstreamHeaders['content-type']) {
        headers['content-type'] = upstreamHeaders['content-type'];
    }
    return headers;
}

module.exports = { deduplicatePath, safeJsonParse, buildSafeHeaders };
