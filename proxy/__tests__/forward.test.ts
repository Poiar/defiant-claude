'use strict';

import { addFallbackHeaders } from '../forward';

describe('addFallbackHeaders', () => {
    test('adds fallback-from header', () => {
        const headers = addFallbackHeaders({ 'content-type': 'application/json' }, {
            fallbackFromModel: 'deepseek-v4-pro',
        });
        expect(headers['x-fallback-from']).toBe('deepseek-v4-pro');
        expect(headers['content-type']).toBe('application/json');
    });

    test('adds fallback-index header', () => {
        const headers = addFallbackHeaders({}, {
            fallbackIndex: 2,
        });
        expect(headers['x-fallback-index']).toBe('2');
    });

    test('adds exhausted header', () => {
        const headers = addFallbackHeaders({}, {
            fallbackExhausted: true,
        });
        expect(headers['x-fallback-exhausted']).toBe('true');
    });

    test('returns headers unchanged when meta is null', () => {
        const original = { foo: 'bar' };
        const result = addFallbackHeaders(original, null);
        expect(result).toEqual(original);
    });

    test('returns headers unchanged when meta is empty', () => {
        const original = { foo: 'bar' };
        const result = addFallbackHeaders(original, {});
        expect(result).toEqual(original);
    });

    test('combines all fallback fields', () => {
        const headers = addFallbackHeaders({}, {
            fallbackFromModel: 'big-pickle',
            fallbackIndex: 1,
            fallbackExhausted: false,
        });
        expect(headers['x-fallback-from']).toBe('big-pickle');
        expect(headers['x-fallback-index']).toBe('1');
        expect(headers['x-fallback-exhausted']).toBeUndefined();
    });
});
