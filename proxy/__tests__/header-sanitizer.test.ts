'use strict'

import {
    sanitizeHeaders,
    SENSITIVE_HEADERS,
    NOISE_HEADERS,
    MAX_HEADERS,
    MAX_VALUE_LEN,
    MAX_TOTAL_BYTES,
} from '../header-sanitizer'

describe('sanitizeHeaders', () => {
    test('Drops authorization header', () => {
        const headers = {
            authorization: 'Bearer sk-ant-api03-secret',
            'content-type': 'application/json',
        }
        const result = sanitizeHeaders(headers)
        expect(result.headers.authorization).toBeUndefined()
        expect(result.headers['content-type']).toBe('application/json')
        expect(result.dropped).toBe(1)
    })

    test('Drops x-api-key header', () => {
        const headers = {
            'x-api-key': 'sk-secret-key-value',
            accept: '*/*',
        }
        const result = sanitizeHeaders(headers)
        expect(result.headers['x-api-key']).toBeUndefined()
        expect(result.headers.accept).toBe('*/*')
        expect(result.dropped).toBe(1)
    })

    test('Drops cookie header', () => {
        const headers = {
            cookie: 'session=abc123; token=xyz',
            'content-type': 'text/plain',
        }
        const result = sanitizeHeaders(headers)
        expect(result.headers.cookie).toBeUndefined()
        expect(result.dropped).toBe(1)
    })

    test('Drops noise headers (host, connection, x-forwarded-for)', () => {
        const headers = {
            host: 'api.example.com',
            connection: 'keep-alive',
            'x-forwarded-for': '10.0.0.1',
            'content-type': 'application/json',
        }
        const result = sanitizeHeaders(headers)
        expect(result.headers.host).toBeUndefined()
        expect(result.headers.connection).toBeUndefined()
        expect(result.headers['x-forwarded-for']).toBeUndefined()
        expect(result.headers['content-type']).toBe('application/json')
        expect(result.dropped).toBe(3)
    })

    test('Passes through safe headers (content-type, accept)', () => {
        const headers = {
            'content-type': 'application/json',
            accept: 'text/event-stream',
            'cache-control': 'no-cache',
            'user-agent': 'deepclaude/1.0',
        }
        const result = sanitizeHeaders(headers)
        expect(result.headers['content-type']).toBe('application/json')
        expect(result.headers.accept).toBe('text/event-stream')
        expect(result.headers['cache-control']).toBe('no-cache')
        expect(result.headers['user-agent']).toBe('deepclaude/1.0')
        expect(result.dropped).toBe(0)
    })

    test('Truncates header values over MAX_VALUE_LEN', () => {
        const longValue = 'a'.repeat(MAX_VALUE_LEN + 50)
        const headers = {
            'content-type': 'text/plain',
            'x-custom': longValue,
        }
        const result = sanitizeHeaders(headers)
        expect(result.headers['x-custom'].length).toBe(MAX_VALUE_LEN)
        expect(result.headers['x-custom']).toBe('a'.repeat(MAX_VALUE_LEN))
        expect(result.dropped).toBe(1)
    })

    test('Limits total header count to MAX_HEADERS', () => {
        const headers: Record<string, string> = {}
        for (let i = 0; i < MAX_HEADERS + 15; i++) {
            headers['x-hdr-' + i] = 'val'
        }
        const result = sanitizeHeaders(headers)
        expect(Object.keys(result.headers).length).toBe(MAX_HEADERS)
        expect(result.dropped).toBe(15)
    })

    test('Limits total bytes to MAX_TOTAL_BYTES', () => {
        const headers: Record<string, string> = {}
        for (let i = 0; i < 15; i++) {
            headers['x-hdr-' + i] = 'x'.repeat(1000)
        }
        const result = sanitizeHeaders(headers)
        expect(Object.keys(result.headers).length).toBe(8)
        expect(result.dropped).toBe(7)
    })

    test('Strips control characters from header values', () => {
        const headers = {
            'content-type': 'text/\x00plain\x1f',
            'x-custom': 'value\r\ninjected',
        }
        const result = sanitizeHeaders(headers)
        expect(result.headers['content-type']).toBe('text/plain')
        expect(result.headers['x-custom']).toBe('valueinjected')
    })

    test('Returns empty object for null input', () => {
        const result = sanitizeHeaders(null)
        expect(result.headers).toEqual({})
        expect(result.dropped).toBe(0)
    })

    test('Returns empty object for undefined input', () => {
        const result = sanitizeHeaders(undefined)
        expect(result.headers).toEqual({})
        expect(result.dropped).toBe(0)
    })

    test('Returns dropped count', () => {
        const result = sanitizeHeaders({
            authorization: 'Bearer token',
            cookie: 'session=abc',
            accept: 'application/json',
        })
        expect(typeof result.dropped).toBe('number')
        expect(result.dropped).toBe(2)
    })

    test('Preserves case-insensitive matching (X-API-Key and x-api-key both dropped)', () => {
        const headers: Record<string, string> = {
            'X-API-Key': 'secret-value',
            Authorization: 'Bearer token',
            'Content-Type': 'application/json',
            Accept: '*/*',
        }
        const result = sanitizeHeaders(headers)
        expect(result.headers['content-type']).toBe('application/json')
        expect(result.headers.accept).toBe('*/*')
        expect(result.headers['x-api-key']).toBeUndefined()
        expect(result.headers.authorization).toBeUndefined()
        expect(result.dropped).toBe(2)
    })
})
