'use strict';

import { deduplicatePath, buildSafeHeaders } from '../util';

describe('deduplicatePath', () => {
    test('removes overlapping suffix/prefix', () => {
        expect(deduplicatePath('/v1', '/v1/messages')).toBe('/v1/messages');
    });

    test('strips query string from request URL', () => {
        expect(deduplicatePath('/v1', '/v1/messages?foo=bar&baz=1')).toBe('/v1/messages');
    });

    test('returns base + url when no overlap', () => {
        expect(deduplicatePath('/api', '/other/path')).toBe('/api/other/path');
    });

    test('handles trailing slash in base', () => {
        expect(deduplicatePath('/v1/', '/v1/chat')).toBe('/v1/chat');
    });

    test('handles empty strings', () => {
        expect(deduplicatePath('', '')).toBe('');
        expect(deduplicatePath('/v1', '')).toBe('/v1');
        expect(deduplicatePath('', '/v1/messages')).toBe('/v1/messages');
    });

    test('handles identical paths', () => {
        expect(deduplicatePath('/v1/messages', '/v1/messages')).toBe('/v1/messages');
    });

    test('full overlap: base is prefix of url', () => {
        expect(deduplicatePath('/v1', '/v1/messages/chat')).toBe('/v1/messages/chat');
    });

    test('partial overlap at end of base', () => {
        expect(deduplicatePath('/api/v1', '/v1/chat')).toBe('/api/v1/chat');
    });
});

describe('buildSafeHeaders', () => {
    test('passes through safe headers', () => {
        const upstream = {
            'content-type': 'application/json',
            'x-request-id': 'req-123',
            'cache-control': 'no-cache',
            'retry-after': '120',
            date: 'Mon, 08 Jun 2026 12:00:00 GMT',
        };
        const result = buildSafeHeaders(upstream);
        expect(result['content-type']).toBe('application/json');
        expect(result['x-request-id']).toBe('req-123');
        expect(result['cache-control']).toBe('no-cache');
        expect(result['retry-after']).toBe('120');
        expect(result['date']).toBe('Mon, 08 Jun 2026 12:00:00 GMT');
    });

    test('filters out unsafe headers (authorization, host, etc.)', () => {
        const upstream = {
            authorization: 'Bearer secret',
            host: 'api.example.com',
            'x-api-key': 'key-123',
            'content-type': 'application/json',
        };
        const result = buildSafeHeaders(upstream);
        expect(result['authorization']).toBeUndefined();
        expect(result['host']).toBeUndefined();
        expect(result['x-api-key']).toBeUndefined();
        expect(result['content-type']).toBe('application/json');
    });

    test('allows x-ratelimit-* headers', () => {
        const upstream = {
            'x-ratelimit-limit': '100',
            'x-ratelimit-remaining': '99',
            'x-ratelimit-reset': '60',
            'x-ratelimit-type': 'standard',
        };
        const result = buildSafeHeaders(upstream);
        expect(result['x-ratelimit-limit']).toBe('100');
        expect(result['x-ratelimit-remaining']).toBe('99');
        expect(result['x-ratelimit-reset']).toBe('60');
        expect(result['x-ratelimit-type']).toBe('standard');
    });

    test('allows x-upstream-* headers', () => {
        const upstream = {
            'x-upstream-status': 'ok',
            'x-upstream-latency': '45ms',
            'x-upstream-provider': 'anthropic',
        };
        const result = buildSafeHeaders(upstream);
        expect(result['x-upstream-status']).toBe('ok');
        expect(result['x-upstream-latency']).toBe('45ms');
        expect(result['x-upstream-provider']).toBe('anthropic');
    });

    test('merges extraHeaders', () => {
        const upstream = { 'content-type': 'application/json' };
        const extra = { 'x-custom': 'value', 'x-debug': 'true' };
        const result = buildSafeHeaders(upstream, extra);
        expect(result['content-type']).toBe('application/json');
        expect(result['x-custom']).toBe('value');
        expect(result['x-debug']).toBe('true');
    });

    test('extraHeaders override upstream safe headers', () => {
        const upstream = { 'content-type': 'application/json' };
        const extra = { 'x-custom': 'from-extra' };
        const result = buildSafeHeaders(upstream, extra);
        // extraHeaders are always included (regardless of SAFE filtering)
        expect(result['x-custom']).toBe('from-extra');
        // upstream safe headers still pass through
        expect(result['content-type']).toBe('application/json');
    });

    test('handles empty upstream headers', () => {
        const result = buildSafeHeaders({});
        expect(result).toEqual({});
    });

    test('handles undefined extraHeaders', () => {
        const upstream = { 'content-type': 'application/json' };
        const result = buildSafeHeaders(upstream, undefined);
        expect(result['content-type']).toBe('application/json');
        expect(Object.keys(result)).toHaveLength(1);
    });

    test('handles array-valued header values', () => {
        const upstream = {
            'content-type': 'text/plain',
            'x-ratelimit-limit': ['100', '200'],
        };
        const result = buildSafeHeaders(upstream);
        expect(result['content-type']).toBe('text/plain');
        expect(result['x-ratelimit-limit']).toEqual(['100', '200']);
    });

    test('preserves original casing for safe headers', () => {
        const upstream = {
            'Content-Type': 'application/json',
            'X-Request-Id': 'req-456',
        };
        const result = buildSafeHeaders(upstream);
        expect(result['Content-Type']).toBe('application/json');
        expect(result['X-Request-Id']).toBe('req-456');
    });

    test('extraHeaders with any key bypass SAFE filtering', () => {
        const upstream = { 'content-type': 'text/plain' };
        const extra = { 'authorization': 'bypassed' };
        const result = buildSafeHeaders(upstream, extra);
        // extraHeaders pass through even though 'authorization' is not a safe header
        expect(result['authorization']).toBe('bypassed');
        expect(result['content-type']).toBe('text/plain');
    });
});
