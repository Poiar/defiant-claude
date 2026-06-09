'use strict';

import fs from 'fs';
import { runStartupChecks, type StartUpCheckSummary } from '../startup-check';

// --- Shared mock state (must be named `mock*` for jest.mock factory access) ---

// eslint-disable-next-line @typescript-eslint/naming-convention
let mockResponseBody = '{}';
// eslint-disable-next-line @typescript-eslint/naming-convention
let mockStatusCode = 200;
// eslint-disable-next-line @typescript-eslint/naming-convention
let mockTimeout = false;
// eslint-disable-next-line @typescript-eslint/naming-convention
let mockPathBasedFailure: string | null = null;
// eslint-disable-next-line @typescript-eslint/naming-convention
let mockSseResponseBody = 'data: {"ok":true}\n\n';

// --- HTTP/HTTPS mock factories ---
// These jest.mock calls are hoisted above imports. They reference the shared
// mutable state variables (prefixed with `mock`), which Jest allows.

jest.mock('https', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Readable } = require('stream');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { EventEmitter } = require('events');
    return {
        request: jest.fn((_options: unknown, callback: Function) => {
            if (mockTimeout) {
                const mockReq = new EventEmitter();
                mockReq.write = jest.fn();
                mockReq.end = jest.fn();
                mockReq.destroy = jest.fn();
                process.nextTick(() => { mockReq.emit('timeout'); });
                return mockReq;
            }

            if (mockPathBasedFailure) {
                const opts = _options as Record<string, string>;
                const path = opts.path || '';
                const host = opts.hostname || '';
                if (path.includes(mockPathBasedFailure) || host.includes(mockPathBasedFailure)) {
                    const mockRes = new Readable({
                        read() {
                            this.push(Buffer.from('{"error":"forbidden"}'));
                            this.push(null);
                        },
                    });
                    (mockRes as Record<string, unknown>).statusCode = 403;
                    (mockRes as Record<string, unknown>).headers = { 'content-type': 'application/json' };
                    setImmediate(() => { callback(mockRes); });
                    const mockReq = new EventEmitter();
                    mockReq.write = jest.fn();
                    mockReq.end = jest.fn();
                    mockReq.destroy = jest.fn();
                    return mockReq;
                }
            }

            const opts = _options as Record<string, string>;
            const acceptHeader = ((opts as any).headers?.accept as string) || '';
            const isStream = acceptHeader === 'text/event-stream';
            const body = isStream ? mockSseResponseBody : mockResponseBody;

            const mockRes = new Readable({
                read() {
                    this.push(Buffer.from(body));
                    this.push(null);
                },
            });
            (mockRes as Record<string, unknown>).statusCode = mockStatusCode;
            (mockRes as Record<string, unknown>).headers = { 'content-type': isStream ? 'text/event-stream' : 'application/json' };
            setImmediate(() => { callback(mockRes); });
            const mockReq = new EventEmitter();
            mockReq.write = jest.fn();
            mockReq.end = jest.fn();
            mockReq.destroy = jest.fn();
            return mockReq;
        }),
    };
});

jest.mock('http', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Readable } = require('stream');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { EventEmitter } = require('events');
    return {
        request: jest.fn((_options: unknown, callback: Function) => {
            if (mockTimeout) {
                const mockReq = new EventEmitter();
                mockReq.write = jest.fn();
                mockReq.end = jest.fn();
                mockReq.destroy = jest.fn();
                process.nextTick(() => { mockReq.emit('timeout'); });
                return mockReq;
            }

            if (mockPathBasedFailure) {
                const opts = _options as Record<string, string>;
                const path = opts.path || '';
                const host = opts.hostname || '';
                if (path.includes(mockPathBasedFailure) || host.includes(mockPathBasedFailure)) {
                    const mockRes = new Readable({
                        read() {
                            this.push(Buffer.from('{"error":"forbidden"}'));
                            this.push(null);
                        },
                    });
                    (mockRes as Record<string, unknown>).statusCode = 403;
                    (mockRes as Record<string, unknown>).headers = { 'content-type': 'application/json' };
                    setImmediate(() => { callback(mockRes); });
                    const mockReq = new EventEmitter();
                    mockReq.write = jest.fn();
                    mockReq.end = jest.fn();
                    mockReq.destroy = jest.fn();
                    return mockReq;
                }
            }

            const opts = _options as Record<string, string>;
            const acceptHeader = ((opts as any).headers?.accept as string) || '';
            const isStream = acceptHeader === 'text/event-stream';
            const body = isStream ? mockSseResponseBody : mockResponseBody;

            const mockRes = new Readable({
                read() {
                    this.push(Buffer.from(body));
                    this.push(null);
                },
            });
            (mockRes as Record<string, unknown>).statusCode = mockStatusCode;
            (mockRes as Record<string, unknown>).headers = { 'content-type': isStream ? 'text/event-stream' : 'application/json' };
            setImmediate(() => { callback(mockRes); });
            const mockReq = new EventEmitter();
            mockReq.write = jest.fn();
            mockReq.end = jest.fn();
            mockReq.destroy = jest.fn();
            return mockReq;
        }),
    };
});

// --- Mock providers JSON data ---

const MOCK_PROVIDERS = {
    providers: {
        ds: {
            displayName: 'DeepSeek (direct)',
            endpoint: 'https://api.deepseek.com/anthropic',
            keyEnv: 'DEEPSEEK_API_KEY',
            authHeader: 'x-api-key',
            wireFormat: 'anthropic',
        },
        or: {
            displayName: 'OpenRouter',
            endpoint: 'https://openrouter.ai/api',
            keyEnv: 'OPENROUTER_API_KEY',
            authHeader: 'bearer',
            wireFormat: 'anthropic',
        },
        gr: {
            displayName: 'Groq',
            endpoint: 'https://api.groq.com/openai/v1',
            keyEnv: 'GROQ_API_KEY',
            authHeader: 'bearer',
            wireFormat: 'openai',
        },
    },
    aliases: {},
    pricing: {},
};

// --- Actual tests ---

describe('runStartupChecks', () => {
    const origEnv: Record<string, string | undefined> = {};
    let fsReadFileSyncSpy: jest.SpyInstance;

    beforeAll(() => {
        origEnv.DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
        origEnv.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
        origEnv.GROQ_API_KEY = process.env.GROQ_API_KEY;
        origEnv.DEEPCLAUDE_SKIP_STARTUP_CHECK = process.env.DEEPCLAUDE_SKIP_STARTUP_CHECK;

        process.env.DEEPSEEK_API_KEY = 'sk-ds-test';
        process.env.OPENROUTER_API_KEY = 'sk-or-test';
        process.env.GROQ_API_KEY = 'sk-gr-test';
    });

    afterAll(() => {
        if (origEnv.DEEPSEEK_API_KEY !== undefined) process.env.DEEPSEEK_API_KEY = origEnv.DEEPSEEK_API_KEY;
        else delete process.env.DEEPSEEK_API_KEY;
        if (origEnv.OPENROUTER_API_KEY !== undefined) process.env.OPENROUTER_API_KEY = origEnv.OPENROUTER_API_KEY;
        else delete process.env.OPENROUTER_API_KEY;
        if (origEnv.GROQ_API_KEY !== undefined) process.env.GROQ_API_KEY = origEnv.GROQ_API_KEY;
        else delete process.env.GROQ_API_KEY;
        if (origEnv.DEEPCLAUDE_SKIP_STARTUP_CHECK !== undefined) process.env.DEEPCLAUDE_SKIP_STARTUP_CHECK = origEnv.DEEPCLAUDE_SKIP_STARTUP_CHECK;
        else delete process.env.DEEPCLAUDE_SKIP_STARTUP_CHECK;
    });

    beforeEach(() => {
        // Reset shared mock state
        mockResponseBody = '{}';
        mockSseResponseBody = 'data: {"ok":true}\n\n';
        mockStatusCode = 200;
        mockTimeout = false;
        mockPathBasedFailure = null;
        delete process.env.DEEPCLAUDE_SKIP_STARTUP_CHECK;

        // Mock fs.readFileSync to return controlled providers.json data
        fsReadFileSyncSpy = jest.spyOn(fs, 'readFileSync').mockImplementation(
            (filepath: fs.PathOrFileDescriptor, ..._args: unknown[]) => {
                const fp = typeof filepath === 'string' ? filepath : filepath.toString();
                if (fp.includes('providers.json')) {
                    return JSON.stringify(MOCK_PROVIDERS);
                }
                return jest.requireActual('fs').readFileSync(filepath, ...(_args as [BufferEncoding?]));
            },
        );
    });

    afterEach(() => {
        fsReadFileSyncSpy.mockRestore();
    });

    test('returns results for each configured provider', async () => {
        mockResponseBody = '{"id":"test"}';
        mockStatusCode = 200;

        const result: StartUpCheckSummary = await runStartupChecks();

        expect(result.results).toHaveLength(3);
        expect(result.results.map(r => r.providerKey).sort()).toEqual(['ds', 'gr', 'or']);
    });

    test('successful provider returns success true with latencyMs', async () => {
        mockResponseBody = '{"id":"test"}';
        mockStatusCode = 200;

        const result: StartUpCheckSummary = await runStartupChecks();

        for (const r of result.results) {
            if (r.success) {
                expect(typeof r.latencyMs).toBe('number');
                expect(r.latencyMs).toBeGreaterThanOrEqual(0);
            }
        }
        expect(result.healthyCount).toBeGreaterThan(0);
    });

    test('failed provider returns success false with errorSummary', async () => {
        mockResponseBody = '{"error":"unauthorized"}';
        mockStatusCode = 401;

        const result: StartUpCheckSummary = await runStartupChecks();

        for (const r of result.results) {
            expect(r.success).toBe(false);
            expect(r.errorSummary).toBeDefined();
            expect(typeof r.errorSummary).toBe('string');
        }
        expect(result.allDown).toBe(true);
    });

    test('timeout at 5 seconds per provider', async () => {
        mockTimeout = true;

        const result: StartUpCheckSummary = await runStartupChecks();

        for (const r of result.results) {
            expect(r.success).toBe(false);
            expect(r.errorSummary).toMatch(/timeout/);
        }
        expect(result.allDown).toBe(true);
    }, 10000);

    test('DEEPCLAUDE_SKIP_STARTUP_CHECK env var bypasses the check', async () => {
        process.env.DEEPCLAUDE_SKIP_STARTUP_CHECK = 'true';
        mockResponseBody = '{"error":"fail"}';
        mockStatusCode = 500;

        const result: StartUpCheckSummary = await runStartupChecks();

        expect(result.results).toHaveLength(0);
        expect(result.allHealthy).toBe(true);
        expect(result.allDown).toBe(false);
    });

    test('all providers down returns allDown true', async () => {
        mockResponseBody = '{"error":"server_error"}';
        mockStatusCode = 502;

        const result: StartUpCheckSummary = await runStartupChecks();

        expect(result.allDown).toBe(true);
        expect(result.healthyCount).toBe(0);
        expect(result.degradedCount).toBe(0);
        expect(result.downCount).toBe(3);
    });

    test('some providers down returns someDown true but not allDown', async () => {
        mockResponseBody = '{"id":"ok"}';
        mockStatusCode = 200;
        mockPathBasedFailure = 'openrouter';

        const result: StartUpCheckSummary = await runStartupChecks();

        expect(result.allDown).toBe(false);
        expect(result.allHealthy).toBe(false);
        expect(result.someDown).toBe(true);
        expect(result.healthyCount).toBeGreaterThan(0);
        expect(result.downCount).toBeGreaterThan(0);
        expect(result.healthyCount + result.downCount).toBe(3);
    });

    test('empty config (no providers) returns appropriate result', async () => {
        fsReadFileSyncSpy.mockRestore();
        fsReadFileSyncSpy = jest.spyOn(fs, 'readFileSync').mockImplementation(
            (filepath: fs.PathOrFileDescriptor, ..._args: unknown[]) => {
                const fp = typeof filepath === 'string' ? filepath : filepath.toString();
                if (fp.includes('providers.json')) {
                    return JSON.stringify({ providers: {}, aliases: {}, pricing: {} });
                }
                return jest.requireActual('fs').readFileSync(filepath, ...(_args as [BufferEncoding?]));
            },
        );

        const result: StartUpCheckSummary = await runStartupChecks();

        expect(result.results).toHaveLength(0);
        expect(result.allHealthy).toBe(true);
        expect(result.allDown).toBe(false);
    });

    test('provider without API key reports NO KEY', async () => {
        delete process.env.GROQ_API_KEY;
        mockResponseBody = '{"id":"test"}';
        mockStatusCode = 200;

        const result: StartUpCheckSummary = await runStartupChecks();

        const noKeyResults = result.results.filter(r => r.errorSummary === 'NO KEY');
        expect(noKeyResults.length).toBeGreaterThan(0);

        const grResult = result.results.find(r => r.providerKey === 'gr');
        expect(grResult).toBeDefined();
        expect(grResult!.errorSummary).toBe('NO KEY');

        // Restore for other tests
        process.env.GROQ_API_KEY = 'sk-gr-test';
    });

    test('auth failure returns AUTH FAIL summary', async () => {
        mockResponseBody = '{"error":"unauthorized"}';
        mockStatusCode = 401;

        const result: StartUpCheckSummary = await runStartupChecks();

        for (const r of result.results) {
            expect(r.success).toBe(false);
            expect(r.errorSummary).toBe('AUTH FAIL');
        }
    });
});
