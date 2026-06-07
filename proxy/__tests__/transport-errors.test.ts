'use strict';

import { classify, isNetworkFailure, describe as describeError } from '../transport-errors';

describe('classify', () => {
    test('detects DNS resolution failure', () => {
        const err = { message: 'getaddrinfo ENOTFOUND api.example.com' };
        const result = classify(err);
        expect(result).not.toBeNull();
        expect(result!.label).toContain('DNS');
        expect(result!.httpStatus).toBe(502);
    });

    test('detects EAI_AGAIN', () => {
        const err = { message: 'EAI_AGAIN api.example.com' };
        expect(classify(err)!.label).toContain('DNS');
    });

    test('detects connection refused', () => {
        const err = { code: 'ECONNREFUSED' };
        expect(classify(err)!.label).toContain('Connection refused');
    });

    test('detects connection reset', () => {
        const err = { message: 'read ECONNRESET' };
        expect(classify(err)!.label).toContain('Connection reset');
    });

    test('detects TLS errors', () => {
        const err = { message: 'self signed certificate' };
        expect(classify(err)!.label).toContain('TLS');
    });

    test('detects SSL errors', () => {
        const err = { code: 'EPROTO' };
        expect(classify(err)!.label).toContain('TLS');
    });

    test('detects timeouts', () => {
        const err = { message: 'ETIMEDOUT' };
        expect(classify(err)!.label).toContain('timed out');
    });

    test('detects timeout in message text', () => {
        const err = { name: 'Error', message: 'request timed out after 30s' };
        expect(classify(err)!.label).toContain('timed out');
    });

    test('detects aborted requests', () => {
        const err = { name: 'AbortError' };
        const result = classify(err);
        expect(result!.label).toContain('aborted');
        expect(result!.httpStatus).toBe(499);
    });

    test('detects socket hang up', () => {
        const err = { message: 'socket hang up' };
        expect(classify(err)!.label).toContain('Upstream connection lost');
    });

    test('detects EPIPE', () => {
        const err = { code: 'EPIPE' };
        expect(classify(err)!.label).toContain('Upstream connection lost');
    });

    test('detects generic network failure', () => {
        const err = { message: 'fetch failed' };
        expect(classify(err)!.label).toContain('Network unreachable');
    });

    test('detects ENETUNREACH', () => {
        const err = { code: 'ENETUNREACH' };
        expect(classify(err)!.label).toContain('Network unreachable');
    });

    test('walks cause chain for classification', () => {
        const err = {
            name: 'RequestError',
            message: 'request to https://api.example.com failed',
            cause: {
                name: 'Error',
                code: 'ECONNREFUSED',
                message: 'connect ECONNREFUSED 127.0.0.1:443',
            },
        };
        expect(classify(err)!.label).toContain('Connection refused');
    });

    test('returns null for unclassifiable errors', () => {
        expect(classify(null)).toBeNull();
        expect(classify({})).toBeNull();
        expect(classify({ message: 'some business logic error' })).toBeNull();
    });

    test('returns null for empty error', () => {
        expect(classify(null)).toBeNull();
        expect(classify({})).toBeNull();
    });
});

describe('isNetworkFailure', () => {
    test('returns true for transport errors', () => {
        expect(isNetworkFailure({ code: 'ECONNREFUSED' })).toBe(true);
    });

    test('returns false for application errors', () => {
        expect(isNetworkFailure({ message: 'invalid api key' })).toBe(false);
    });
});

describe('describe', () => {
    test('returns label with detail', () => {
        const err = { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 1.2.3.4:443' };
        const desc = describeError(err);
        expect(desc).toContain('Connection refused');
        expect(desc).toContain('ECONNREFUSED');
    });

    test('falls back to raw message for unknown errors', () => {
        expect(describeError({ message: 'something weird' })).toBe('something weird');
    });

    test('truncates long messages', () => {
        const long = 'x'.repeat(300);
        expect(describeError({ message: long }).length).toBeLessThanOrEqual(210);
    });
});
