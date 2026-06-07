'use strict';

import { scrubCredentials } from './error-codes';

export const MAX_LOG_CHARS = 500;
export const MAX_STORAGE_CHARS = 2000;

export function truncateForLog(body: unknown, maxLen?: number): string {
    return truncate(body, maxLen != null ? maxLen : MAX_LOG_CHARS) || '';
}

export function truncateForStorage(body: unknown, maxLen?: number): string {
    return truncate(body, maxLen != null ? maxLen : MAX_STORAGE_CHARS) || '';
}

function truncate(body: unknown, maxLen: number): string | null | undefined {
    // null/undefined pass through as-is
    if (body === null || body === undefined) return body;

    // Convert to string
    let str: string;
    if (typeof body === 'string') {
        str = body;
    } else if (typeof body === 'object') {
        try {
            str = JSON.stringify(body);
        } catch (_) {
            str = String(body);
        }
    } else {
        str = String(body);
    }

    // Empty string passes through unchanged
    if (str.length === 0) return str;

    // Scrub secrets BEFORE truncation so patterns at the end aren't cut off
    str = scrubCredentials(str);

    if (str.length <= maxLen) return str;

    return str.slice(0, maxLen) + '…';
}

