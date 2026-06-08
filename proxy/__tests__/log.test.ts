'use strict';

// Mock fs BEFORE importing log, since log.ts calls fs.openSync at import time.
jest.mock('fs', () => ({
    mkdirSync: jest.fn(),
    openSync: jest.fn(() => 99), // fake file descriptor
    writeSync: jest.fn(),
    fsyncSync: jest.fn(),
}));

import { createLogger } from '../log';

const TS_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

describe('createLogger', () => {
    let consoleSpy: jest.SpyInstance;

    beforeEach(() => {
        consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        consoleSpy.mockRestore();
    });

    test('info writes formatted line to console.error', () => {
        const log = createLogger('mod');
        log.info(null, 'info message');
        const output = consoleSpy.mock.calls[0][0];
        expect(output).toContain('[mod]');
        expect(output).toContain('[INFO]');
        expect(output).toContain('info message');
    });

    test('warn writes formatted line to console.error', () => {
        const log = createLogger('mod');
        log.warn(null, 'warn message');
        const output = consoleSpy.mock.calls[0][0];
        expect(output).toContain('[mod]');
        expect(output).toContain('[WARN]');
        expect(output).toContain('warn message');
    });

    test('error writes formatted line to console.error', () => {
        const log = createLogger('mod');
        log.error(null, 'error message');
        const output = consoleSpy.mock.calls[0][0];
        expect(output).toContain('[mod]');
        expect(output).toContain('[ERROR]');
        expect(output).toContain('error message');
    });

    test('includes module name in output', () => {
        const log = createLogger('my-module');
        log.info(null, 'msg');
        const output = consoleSpy.mock.calls[0][0];
        expect(output).toContain('[my-module]');
    });

    test('includes reqId in output when provided', () => {
        const log = createLogger('test');
        log.info('abc-123', 'msg');
        const output = consoleSpy.mock.calls[0][0];
        expect(output).toContain('[#abc-123]');
    });

    test('omits reqId section when null', () => {
        const log = createLogger('test');
        log.info(null, 'msg');
        const output = consoleSpy.mock.calls[0][0];
        expect(output).not.toMatch(/\[#/);
    });

    test('omits reqId section when undefined', () => {
        const log = createLogger('test');
        log.info(undefined, 'msg');
        const output = consoleSpy.mock.calls[0][0];
        expect(output).not.toMatch(/\[#/);
    });

    test('handles numeric reqId', () => {
        const log = createLogger('test');
        log.info(42, 'msg');
        const output = consoleSpy.mock.calls[0][0];
        expect(output).toContain('[#42]');
    });

    test('timestamp format matches YYYY-MM-DD HH:MM:SS', () => {
        const log = createLogger('test');
        log.info(null, 'msg');
        const output = consoleSpy.mock.calls[0][0];
        const match = output.match(/^\[([^\]]+)\]/);
        expect(match).not.toBeNull();
        expect(match![1]).toMatch(TS_RE);
    });

    test('each logger instance is independent (different names)', () => {
        const logA = createLogger('module-a');
        const logB = createLogger('module-b');
        logA.info(null, 'from a');
        logB.info(null, 'from b');
        expect(consoleSpy.mock.calls[0][0]).toContain('[module-a]');
        expect(consoleSpy.mock.calls[0][0]).toContain('from a');
        expect(consoleSpy.mock.calls[1][0]).toContain('[module-b]');
        expect(consoleSpy.mock.calls[1][0]).toContain('from b');
    });
});
