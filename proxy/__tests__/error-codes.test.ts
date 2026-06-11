'use strict';

import {
    ERROR_CODES, STATUS_TO_CODE, formatError, formatExhaustedError,
    scrubCredentials, isStreamingClient, getErrorCode,
} from '../error-codes';

describe('scrubCredentials', () => {
    test('strips Anthropic API keys', () => {
        const input = 'Error with sk-ant-api03-abc123def456ghi789jkl012mno345pqr678stu901vwx234yz';
        const out = scrubCredentials(input);
        expect(out).not.toContain('sk-ant-api03');
        expect(out).toContain('[redacted]');
        expect(out).not.toMatch(/sk-ant-\w{20,}/);
    });

    test('strips OpenAI-style API keys', () => {
        const input = 'Invalid key: sk-proj-abc123def456ghi789jkl012mno345pqr';
        const out = scrubCredentials(input);
        expect(out).not.toContain('sk-proj');
        expect(out).toContain('[redacted]');
        expect(out).not.toMatch(/\bsk-\w{20,}\b/);
    });

    test('strips Bearer tokens', () => {
        const input = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9';
        const out = scrubCredentials(input);
        expect(out).not.toContain('eyJhbGci');
        expect(out).toContain('Bearer [redacted]');
    });

    test('strips key= query params', () => {
        const input = 'https://api.example.com?key=sk-secret123&other=val';
        const out = scrubCredentials(input);
        expect(out).not.toContain('sk-secret123');
        expect(out).toContain('key=[redacted]');
    });

    test('strips x-api-key headers', () => {
        const input = 'x-api-key: abc123def456secret789key';
        const out = scrubCredentials(input);
        expect(out).not.toContain('abc123def');
        expect(out).toContain('x-api-key: [redacted]');
    });

    test('passes through clean messages unchanged', () => {
        const input = 'Network error: connection refused on port 443';
        expect(scrubCredentials(input)).toBe(input);
    });

    test('handles non-string input', () => {
        expect(scrubCredentials(null)).toBe('null');
        expect(scrubCredentials(undefined)).toBe('undefined');
        expect(scrubCredentials(42)).toBe('42');
    });
});

describe('formatError', () => {
    test('returns structured error for known HTTP status', () => {
        const err = formatError(429);
        expect(err.type).toBe('api_error');
        expect(err.message).toContain('Too many requests');
    });

    test('returns generic error for unknown status', () => {
        const err = formatError(418);
        expect(err.type).toBe('api_error');
        expect(err.message).toContain('418');
    });

    test('includes error code in dev mode', () => {
        const err = formatError(401, null, true);
        expect(err.code).toBe('AUTH_FAILED');
        expect(err.upstream_status).toBe(401);
        expect(err.error_code).toBe('E001');
    });

    test('includes machine-readable error_code in production mode', () => {
        const err = formatError(401, null, false);
        expect(err.code).toBeUndefined();
        expect(err.error_code).toBe('E001');
    });

    test('includes machine-readable error_code for unknown status', () => {
        const err = formatError(418);
        expect(err.error_code).toBe('E006');
    });

    test('omits symbolic error code in production mode', () => {
        const err = formatError(401, null, false);
        expect(err.code).toBeUndefined();
    });

    test('interpolates template vars', () => {
        const err = formatError(502, { status: '500' }, false);
        expect(err.message).toContain('500');
    });
});

describe('formatExhaustedError', () => {
    test('includes last status in message', () => {
        const err = formatExhaustedError(429, null, false);
        expect(err.message).toContain('429');
    });

    test('includes machine-readable error_code E012', () => {
        const err = formatExhaustedError(429, null, false);
        expect(err.error_code).toBe('E012');
    });

    test('machine-readable error_code overrides underlying status code', () => {
        const err = formatExhaustedError(401, null, false);
        expect(err.error_code).toBe('E012');
        expect(err.error_code).not.toBe('E001');
    });

    test('includes sanitized last body in dev mode', () => {
        const err = formatExhaustedError(500, 'Internal error with sk-ant-api03-abc123def456ghi789jkl012mno345', true);
        expect(err.last_error_body).not.toContain('abc123def456');
        expect(err.last_error_body).toContain('Internal error');
    });

    test('omits last body in production mode', () => {
        const err = formatExhaustedError(500, 'secret body', false);
        expect(err.last_error_body).toBeUndefined();
    });
});

describe('isStreamingClient', () => {
    test('detects streaming from body.stream', () => {
        expect(isStreamingClient({}, { stream: true })).toBe(true);
    });

    test('detects streaming from Accept header', () => {
        expect(isStreamingClient({ accept: 'text/event-stream' }, null)).toBe(true);
    });

    test('returns false for non-streaming tools', () => {
        expect(isStreamingClient({ accept: 'application/json' }, { stream: false })).toBe(false);
    });

    test('returns false for empty input', () => {
        expect(isStreamingClient({}, null)).toBe(false);
    });
});

describe('ERROR_CODES', () => {
    test('every code has a unique code string', () => {
        const codes = Object.values(ERROR_CODES).map(e => e.code);
        expect(new Set(codes).size).toBe(codes.length);
    });

    test('every code has a unique machine-readable ecode', () => {
        const ecodes = Object.values(ERROR_CODES).map(e => e.ecode);
        expect(new Set(ecodes).size).toBe(ecodes.length);
    });

    test('all 14 entries have distinct E001-E014 codes', () => {
        const ecodes = Object.values(ERROR_CODES).map(e => e.ecode).sort();
        expect(ecodes).toEqual(['E001','E002','E003','E004','E005','E006','E007','E008','E009','E010','E011','E012','E013','E014']);
    });
});

describe('STATUS_TO_CODE', () => {
    test('maps common status codes', () => {
        expect(STATUS_TO_CODE[401].code).toBe('AUTH_FAILED');
        expect(STATUS_TO_CODE[429].code).toBe('RATE_LIMITED');
        expect(STATUS_TO_CODE[503].code).toBe('UPSTREAM_UNAVAILABLE');
    });
});

describe('getErrorCode', () => {
    test('returns machine-readable code for known status', () => {
        expect(getErrorCode(401)).toBe('E001');
        expect(getErrorCode(429)).toBe('E005');
        expect(getErrorCode(504)).toBe('E008');
    });

    test('returns undefined for unknown status', () => {
        expect(getErrorCode(418)).toBeUndefined();
        expect(getErrorCode(999)).toBeUndefined();
    });

    test('returns undefined for falsy status', () => {
        expect(getErrorCode(null)).toBeUndefined();
        expect(getErrorCode(undefined)).toBeUndefined();
    });
});
