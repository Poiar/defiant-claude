'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_STORAGE_CHARS = exports.MAX_LOG_CHARS = void 0;
exports.truncateForLog = truncateForLog;
exports.truncateForStorage = truncateForStorage;
const error_codes_1 = require("./error-codes");
exports.MAX_LOG_CHARS = 500;
exports.MAX_STORAGE_CHARS = 2000;
function truncateForLog(body, maxLen) {
    return truncate(body, maxLen != null ? maxLen : exports.MAX_LOG_CHARS);
}
function truncateForStorage(body, maxLen) {
    return truncate(body, maxLen != null ? maxLen : exports.MAX_STORAGE_CHARS);
}
function truncate(body, maxLen) {
    // null/undefined pass through as-is
    if (body === null || body === undefined)
        return body;
    // Convert to string
    let str;
    if (typeof body === 'string') {
        str = body;
    }
    else if (typeof body === 'object') {
        try {
            str = JSON.stringify(body);
        }
        catch (_) {
            str = String(body);
        }
    }
    else {
        str = String(body);
    }
    // Empty string passes through unchanged
    if (str.length === 0)
        return str;
    // Scrub secrets BEFORE truncation so patterns at the end aren't cut off
    str = (0, error_codes_1.scrubCredentials)(str);
    if (str.length <= maxLen)
        return str;
    return str.slice(0, maxLen) + '…';
}
