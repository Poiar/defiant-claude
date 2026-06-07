'use strict';

interface SanitizeResult {
    headers: Record<string, string>;
    dropped: number;
}

export const MAX_HEADERS = 50;
export const MAX_VALUE_LEN = 1024;
export const MAX_TOTAL_BYTES = 8192;

export const SENSITIVE_HEADERS: ReadonlySet<string> = new Set([
    'authorization', 'x-api-key', 'cookie', 'set-cookie',
    'proxy-authorization', 'proxy-authenticate',
]);

export const NOISE_HEADERS: ReadonlySet<string> = new Set([
    'host', 'connection', 'x-forwarded-for', 'x-forwarded-proto',
    'x-forwarded-host', 'x-forwarded-port', 'x-real-ip',
    'transfer-encoding', 'te', 'trailer', 'upgrade',
    'keep-alive', 'content-length', 'accept-encoding',
]);

export function sanitizeHeaders(headers: Record<string, string | string[]> | null | undefined): SanitizeResult {
    if (!headers) return { headers: {}, dropped: 0 };

    const clean: Record<string, string> = {};
    let dropped = 0;
    let totalBytes = 0;
    let count = 0;

    const entries = Object.entries(headers);
    for (let i = 0; i < entries.length; i++) {
        const [name, rawValue] = entries[i];
        const lower = name.toLowerCase();

        if (SENSITIVE_HEADERS.has(lower)) {
            dropped++;
            continue;
        }

        if (NOISE_HEADERS.has(lower)) {
            dropped++;
            continue;
        }

        if (count >= MAX_HEADERS) {
            dropped++;
            continue;
        }

        let strValue: string = Array.isArray(rawValue) ? rawValue.join(', ') : String(rawValue);
        strValue = strValue.replace(/[\x00-\x1f\x7f]/g, '');

        if (strValue.length > MAX_VALUE_LEN) {
            strValue = strValue.substring(0, MAX_VALUE_LEN);
            dropped++;
        }

        const bytes = Buffer.byteLength(strValue, 'utf8');
        if (totalBytes + bytes > MAX_TOTAL_BYTES) {
            dropped += (entries.length - i);
            break;
        }

        totalBytes += bytes;
        clean[lower] = strValue;
        count++;
    }

    return { headers: clean, dropped };
}

