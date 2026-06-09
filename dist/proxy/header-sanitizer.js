'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
exports.NOISE_HEADERS = exports.SENSITIVE_HEADERS = exports.MAX_TOTAL_BYTES = exports.MAX_VALUE_LEN = exports.MAX_HEADERS = void 0;
exports.sanitizeHeaders = sanitizeHeaders;
exports.MAX_HEADERS = 50;
exports.MAX_VALUE_LEN = 1024;
exports.MAX_TOTAL_BYTES = 8192;
exports.SENSITIVE_HEADERS = new Set([
    'authorization', 'x-api-key', 'cookie', 'set-cookie',
    'proxy-authorization', 'proxy-authenticate',
]);
exports.NOISE_HEADERS = new Set([
    'host', 'connection', 'x-forwarded-for', 'x-forwarded-proto',
    'x-forwarded-host', 'x-forwarded-port', 'x-real-ip',
    'transfer-encoding', 'te', 'trailer', 'upgrade',
    'keep-alive', 'content-length', 'accept-encoding',
]);
function sanitizeHeaders(headers) {
    if (!headers)
        return { headers: {}, dropped: 0 };
    const clean = {};
    let dropped = 0;
    let totalBytes = 0;
    let count = 0;
    const entries = Object.entries(headers);
    for (let i = 0; i < entries.length; i++) {
        const [name, rawValue] = entries[i];
        const lower = name.toLowerCase();
        if (exports.SENSITIVE_HEADERS.has(lower)) {
            dropped++;
            continue;
        }
        if (exports.NOISE_HEADERS.has(lower)) {
            dropped++;
            continue;
        }
        if (count >= exports.MAX_HEADERS) {
            dropped++;
            continue;
        }
        let strValue = Array.isArray(rawValue) ? rawValue.join(', ') : String(rawValue);
        strValue = strValue.replace(/[\x00-\x1f\x7f]/g, '');
        if (strValue.length > exports.MAX_VALUE_LEN) {
            strValue = strValue.substring(0, exports.MAX_VALUE_LEN);
            dropped++;
        }
        const bytes = Buffer.byteLength(strValue, 'utf8');
        if (totalBytes + bytes > exports.MAX_TOTAL_BYTES) {
            dropped += (entries.length - i);
            break;
        }
        totalBytes += bytes;
        clean[lower] = strValue;
        count++;
    }
    return { headers: clean, dropped };
}
