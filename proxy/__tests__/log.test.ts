'use strict'

import { createLogger } from '../log'

const TS_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/

beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
    ;(console.error as jest.Mock).mockRestore()
})

describe('createLogger', () => {
    test('returns an object with info, warn, and error methods', () => {
        const log = createLogger('test')
        expect(log).toBeDefined()
        expect(typeof log.info).toBe('function')
        expect(typeof log.warn).toBe('function')
        expect(typeof log.error).toBe('function')
    })

    test('info output includes module name and [INFO] tag', () => {
        const log = createLogger('my-module')
        log.info(null, 'hello world')
        const output = (console.error as jest.Mock).mock.calls[0][0]
        expect(output).toContain('[my-module]')
        expect(output).toContain('[INFO]')
        expect(output).toContain('hello world')
    })

    test('warn output includes module name and [WARN] tag', () => {
        const log = createLogger('my-module')
        log.warn(null, 'something fishy')
        const output = (console.error as jest.Mock).mock.calls[0][0]
        expect(output).toContain('[my-module]')
        expect(output).toContain('[WARN]')
        expect(output).toContain('something fishy')
    })

    test('error output includes module name and [ERROR] tag', () => {
        const log = createLogger('my-module')
        log.error(null, 'oh no')
        const output = (console.error as jest.Mock).mock.calls[0][0]
        expect(output).toContain('[my-module]')
        expect(output).toContain('[ERROR]')
        expect(output).toContain('oh no')
    })

    test('includes reqId as [#reqId] when provided', () => {
        const log = createLogger('test')
        log.info('abc-123', 'msg')
        const output = (console.error as jest.Mock).mock.calls[0][0]
        expect(output).toContain('[#abc-123]')
    })

    test('omits [#...] segment when reqId is null', () => {
        const log = createLogger('test')
        log.info(null, 'msg')
        const output = (console.error as jest.Mock).mock.calls[0][0]
        expect(output).not.toMatch(/\[#/)
    })

    test('omits [#...] segment when reqId is undefined', () => {
        const log = createLogger('test')
        log.info(undefined, 'msg')
        const output = (console.error as jest.Mock).mock.calls[0][0]
        expect(output).not.toMatch(/\[#/)
    })

    test('timestamp is ISO-like (YYYY-MM-DD HH:MM:SS)', () => {
        const log = createLogger('test')
        log.info(null, 'msg')
        const output = (console.error as jest.Mock).mock.calls[0][0]
        const match = output.match(/^\[([^\]]+)\]/)
        expect(match).not.toBeNull()
        expect(match![1]).toMatch(TS_RE)
    })
})
