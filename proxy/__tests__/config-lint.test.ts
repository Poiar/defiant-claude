'use strict';

import { validateConfig, formatLintResults } from '../config-lint';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Helper to create a temporary providers.json for testing
function makeProvidersJson(data: Record<string, unknown>): string {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-lint-test-'));
    const filePath = path.join(tmpDir, 'providers.json');
    fs.writeFileSync(filePath, JSON.stringify(data));
    return filePath;
}

function cleanupJson(filePath: string): void {
    try {
        fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
    } catch {
        // ignore cleanup errors
    }
}

// Save and restore env vars around tests that modify them
const savedEnv: Record<string, string | undefined> = {};
function saveEnv(keys: string[]): void {
    for (const k of keys) {
        savedEnv[k] = process.env[k];
    }
}
function restoreEnv(keys: string[]): void {
    for (const k of keys) {
        if (savedEnv[k] === undefined) {
            delete process.env[k];
        } else {
            process.env[k] = savedEnv[k];
        }
    }
}

// ============================================================
// Test: valid config produces zero issues
// ============================================================
describe('validateConfig', () => {
    test('valid providers.json produces zero errors', () => {
        const data = {
            providers: {
                p1: {
                    displayName: 'Provider One',
                    endpoint: 'https://api.p1.test',
                    keyEnv: 'P1_API_KEY',
                    authHeader: 'bearer',
                    wireFormat: 'anthropic',
                },
            },
            contextLimits: {
                'test-model': 100000,
            },
            configs: {
                test: {
                    name: 'Test Config',
                    opus: 'p1:test-model',
                    sonnet: 'p1:test-model',
                    haiku: 'p1:test-model',
                    sub: 'p1:test-model',
                },
            },
            aliases: {
                tm: 'test-model',
            },
        };
        const filePath = makeProvidersJson(data);
        saveEnv(['P1_API_KEY']);
        process.env.P1_API_KEY = 'sk-test';

        try {
            const issues = validateConfig(filePath);
            expect(issues).toHaveLength(0);
        } finally {
            restoreEnv(['P1_API_KEY']);
            cleanupJson(filePath);
        }
    });

    // ============================================================
    // Test: missing key for provider in config (no fallback) => ERROR
    // ============================================================
    test('missing key for provider in config with no fallback produces ERROR', () => {
        const data = {
            providers: {
                p1: {
                    displayName: 'Provider One',
                    endpoint: 'https://api.p1.test',
                    keyEnv: 'P1_API_KEY',
                    authHeader: 'bearer',
                    wireFormat: 'anthropic',
                },
            },
            contextLimits: {
                'test-model': 100000,
            },
            configs: {
                test: {
                    name: 'Test Config',
                    opus: 'p1:test-model',
                    sonnet: 'p1:test-model',
                    haiku: 'p1:test-model',
                    sub: 'p1:test-model',
                },
            },
        };
        const filePath = makeProvidersJson(data);
        saveEnv(['P1_API_KEY']);
        delete process.env.P1_API_KEY;

        try {
            const issues = validateConfig(filePath);
            const keyErrors = issues.filter(i => i.type === 'ERROR' && i.section === 'keys');
            expect(keyErrors.length).toBeGreaterThanOrEqual(1);
            expect(keyErrors[0].message).toContain('P1_API_KEY');
        } finally {
            restoreEnv(['P1_API_KEY']);
            cleanupJson(filePath);
        }
    });

    // ============================================================
    // Test: missing key for provider with fallback => WARNING
    // ============================================================
    test('missing key with fallback produces WARNING', () => {
        const data = {
            providers: {
                p1: {
                    displayName: 'Provider One',
                    endpoint: 'https://api.p1.test',
                    keyEnv: 'P1_API_KEY',
                    authHeader: 'bearer',
                    wireFormat: 'anthropic',
                    fallback: ['p2'],
                },
                p2: {
                    displayName: 'Provider Two',
                    endpoint: 'https://api.p2.test',
                    keyEnv: 'P2_API_KEY',
                    authHeader: 'bearer',
                    wireFormat: 'anthropic',
                },
            },
            contextLimits: {
                'test-model': 100000,
            },
            configs: {
                test: {
                    name: 'Test Config',
                    opus: 'p2:test-model',
                    sonnet: 'p2:test-model',
                    haiku: 'p2:test-model',
                    sub: 'p2:test-model',
                },
            },
        };
        const filePath = makeProvidersJson(data);
        saveEnv(['P1_API_KEY', 'P2_API_KEY']);
        delete process.env.P1_API_KEY;
        process.env.P2_API_KEY = 'sk-p2';

        try {
            const issues = validateConfig(filePath);
            const warnings = issues.filter(i => i.type === 'WARNING' && i.section === 'keys');
            expect(warnings.length).toBeGreaterThanOrEqual(1);
            expect(warnings[0].message).toContain('P1_API_KEY');
            expect(warnings[0].message).toContain('fallback');
        } finally {
            restoreEnv(['P1_API_KEY', 'P2_API_KEY']);
            cleanupJson(filePath);
        }
    });

    // ============================================================
    // Test: circular fallback detection
    // ============================================================
    test('circular fallback detection', () => {
        const data = {
            providers: {
                a: {
                    displayName: 'Provider A',
                    endpoint: 'https://api.a.test',
                    keyEnv: 'A_API_KEY',
                    authHeader: 'bearer',
                    wireFormat: 'anthropic',
                    fallback: ['b'],
                },
                b: {
                    displayName: 'Provider B',
                    endpoint: 'https://api.b.test',
                    keyEnv: 'B_API_KEY',
                    authHeader: 'bearer',
                    wireFormat: 'anthropic',
                    fallback: ['a'],
                },
            },
            contextLimits: {
                'test-model': 100000,
            },
            configs: {
                test: {
                    name: 'Test Config',
                    opus: 'a:test-model',
                    sonnet: 'a:test-model',
                    haiku: 'a:test-model',
                    sub: 'a:test-model',
                },
            },
        };
        const filePath = makeProvidersJson(data);
        saveEnv(['A_API_KEY', 'B_API_KEY']);
        process.env.A_API_KEY = 'sk-a';
        process.env.B_API_KEY = 'sk-b';

        try {
            const issues = validateConfig(filePath);
            const circular = issues.filter(i => i.section === 'fallbacks' && i.message.indexOf('Circular') >= 0);
            expect(circular.length).toBeGreaterThanOrEqual(1);
        } finally {
            restoreEnv(['A_API_KEY', 'B_API_KEY']);
            cleanupJson(filePath);
        }
    });

    // ============================================================
    // Test: self-referencing fallback
    // ============================================================
    test('self-referencing fallback detection', () => {
        const data = {
            providers: {
                a: {
                    displayName: 'Provider A',
                    endpoint: 'https://api.a.test',
                    keyEnv: 'A_API_KEY',
                    authHeader: 'bearer',
                    wireFormat: 'anthropic',
                    fallback: ['a'],
                },
            },
            contextLimits: {
                'test-model': 100000,
            },
            configs: {
                test: {
                    name: 'Test Config',
                    opus: 'a:test-model',
                    sonnet: 'a:test-model',
                    haiku: 'a:test-model',
                    sub: 'a:test-model',
                },
            },
        };
        const filePath = makeProvidersJson(data);
        saveEnv(['A_API_KEY']);
        process.env.A_API_KEY = 'sk-a';

        try {
            const issues = validateConfig(filePath);
            const selfRef = issues.filter(i => i.section === 'fallbacks' && i.message.indexOf('self-referencing') >= 0);
            expect(selfRef.length).toBeGreaterThanOrEqual(1);
        } finally {
            restoreEnv(['A_API_KEY']);
            cleanupJson(filePath);
        }
    });

    // ============================================================
    // Test: missing fallback target
    // ============================================================
    test('missing fallback target', () => {
        const data = {
            providers: {
                a: {
                    displayName: 'Provider A',
                    endpoint: 'https://api.a.test',
                    keyEnv: 'A_API_KEY',
                    authHeader: 'bearer',
                    wireFormat: 'anthropic',
                    fallback: ['nonexistent'],
                },
            },
            contextLimits: {
                'test-model': 100000,
            },
            configs: {
                test: {
                    name: 'Test Config',
                    opus: 'a:test-model',
                    sonnet: 'a:test-model',
                    haiku: 'a:test-model',
                    sub: 'a:test-model',
                },
            },
        };
        const filePath = makeProvidersJson(data);
        saveEnv(['A_API_KEY']);
        process.env.A_API_KEY = 'sk-a';

        try {
            const issues = validateConfig(filePath);
            const missing = issues.filter(i => i.section === 'fallbacks' && i.message.indexOf('not found') >= 0);
            expect(missing.length).toBeGreaterThanOrEqual(1);
        } finally {
            restoreEnv(['A_API_KEY']);
            cleanupJson(filePath);
        }
    });

    // ============================================================
    // Test: missing context limit for a referenced model
    // ============================================================
    test('missing context limit for referenced model', () => {
        const data = {
            providers: {
                p1: {
                    displayName: 'Provider One',
                    endpoint: 'https://api.p1.test',
                    keyEnv: 'P1_API_KEY',
                    authHeader: 'bearer',
                    wireFormat: 'anthropic',
                },
            },
            contextLimits: {},
            configs: {
                test: {
                    name: 'Test Config',
                    opus: 'p1:unknown-model',
                    sonnet: 'p1:unknown-model',
                    haiku: 'p1:unknown-model',
                    sub: 'p1:unknown-model',
                },
            },
        };
        const filePath = makeProvidersJson(data);
        saveEnv(['P1_API_KEY']);
        process.env.P1_API_KEY = 'sk-p1';

        try {
            const issues = validateConfig(filePath);
            const missingCtx = issues.filter(i => i.section === 'contextLimits');
            expect(missingCtx.length).toBeGreaterThanOrEqual(1);
            expect(missingCtx[0].message).toContain('unknown-model');
        } finally {
            restoreEnv(['P1_API_KEY']);
            cleanupJson(filePath);
        }
    });

    // ============================================================
    // Test: invalid provider key in a config
    // ============================================================
    test('invalid provider key in config', () => {
        const data = {
            providers: {
                p1: {
                    displayName: 'Provider One',
                    endpoint: 'https://api.p1.test',
                    keyEnv: 'P1_API_KEY',
                    authHeader: 'bearer',
                    wireFormat: 'anthropic',
                },
            },
            contextLimits: {
                'test-model': 100000,
            },
            configs: {
                test: {
                    name: 'Test Config',
                    opus: 'nonexistent:test-model',
                    sonnet: 'p1:test-model',
                    haiku: 'p1:test-model',
                    sub: 'p1:test-model',
                },
            },
        };
        const filePath = makeProvidersJson(data);
        saveEnv(['P1_API_KEY']);
        process.env.P1_API_KEY = 'sk-p1';

        try {
            const issues = validateConfig(filePath);
            const provErrors = issues.filter(i => i.section === 'configs' && i.message.indexOf('nonexistent') >= 0);
            expect(provErrors.length).toBeGreaterThanOrEqual(1);
            expect(provErrors[0].message).toContain('unknown provider');
            expect(provErrors[0].message).toContain('nonexistent');
        } finally {
            restoreEnv(['P1_API_KEY']);
            cleanupJson(filePath);
        }
    });

    // ============================================================
    // Test: unknown alias target
    // ============================================================
    test('unknown alias target', () => {
        const data = {
            providers: {
                p1: {
                    displayName: 'Provider One',
                    endpoint: 'https://api.p1.test',
                    keyEnv: 'P1_API_KEY',
                    authHeader: 'bearer',
                    wireFormat: 'anthropic',
                },
            },
            contextLimits: {
                'test-model': 100000,
            },
            configs: {
                test: {
                    name: 'Test Config',
                    opus: 'p1:test-model',
                    sonnet: 'p1:test-model',
                    haiku: 'p1:test-model',
                    sub: 'p1:test-model',
                },
            },
            aliases: {
                'my-alias': 'fake-model-that-does-not-exist',
            },
        };
        const filePath = makeProvidersJson(data);
        saveEnv(['P1_API_KEY']);
        process.env.P1_API_KEY = 'sk-p1';

        try {
            const issues = validateConfig(filePath);
            const aliasWarnings = issues.filter(i => i.section === 'aliases');
            expect(aliasWarnings.length).toBeGreaterThanOrEqual(1);
            expect(aliasWarnings[0].message).toContain('fake-model');
        } finally {
            restoreEnv(['P1_API_KEY']);
            cleanupJson(filePath);
        }
    });

    // ============================================================
    // Test: provider referenced in config but key not set (no fallback)
    // ============================================================
    test('provider referenced in config but key not set', () => {
        const data = {
            providers: {
                p1: {
                    displayName: 'Provider One',
                    endpoint: 'https://api.p1.test',
                    keyEnv: 'P1_API_KEY',
                    authHeader: 'bearer',
                    wireFormat: 'anthropic',
                },
            },
            contextLimits: {
                'test-model': 100000,
            },
            configs: {
                test: {
                    name: 'Test Config',
                    opus: 'p1:test-model',
                    sonnet: 'p1:test-model',
                    haiku: 'p1:test-model',
                    sub: 'p1:test-model',
                },
            },
        };
        const filePath = makeProvidersJson(data);
        saveEnv(['P1_API_KEY']);
        delete process.env.P1_API_KEY;

        try {
            const issues = validateConfig(filePath);
            const keyErrors = issues.filter(i => i.type === 'ERROR' && i.section === 'keys');
            expect(keyErrors.length).toBeGreaterThanOrEqual(1);
            expect(keyErrors[0].message).toContain('no fallback');
            expect(keyErrors[0].message).toContain('P1_API_KEY');
        } finally {
            restoreEnv(['P1_API_KEY']);
            cleanupJson(filePath);
        }
    });

    // ============================================================
    // Test: missing top-level keys
    // ============================================================
    test('missing top-level keys', () => {
        const data = {};  // Empty object — no providers, contextLimits, or configs
        const filePath = makeProvidersJson(data);

        try {
            const issues = validateConfig(filePath);
            const schemaIssues = issues.filter(i => i.section === 'schema');
            expect(schemaIssues.length).toBe(3);  // 3 missing keys
            const messages = schemaIssues.map(i => i.message);
            expect(messages.some(m => m.indexOf('providers') >= 0)).toBe(true);
            expect(messages.some(m => m.indexOf('contextLimits') >= 0)).toBe(true);
            expect(messages.some(m => m.indexOf('configs') >= 0)).toBe(true);
        } finally {
            cleanupJson(filePath);
        }
    });

    // ============================================================
    // Test: missing provider fields
    // ============================================================
    test('missing provider required fields', () => {
        const data = {
            providers: {
                bad: {
                    displayName: 'Bad Provider',
                    // Missing endpoint, keyEnv, authHeader, wireFormat
                },
            },
            contextLimits: {},
            configs: {},
        };
        const filePath = makeProvidersJson(data);

        try {
            const issues = validateConfig(filePath);
            const fieldIssues = issues.filter(i => i.section === 'providers' && i.message.indexOf('missing required field') >= 0);
            expect(fieldIssues.length).toBe(4);  // 4 missing required fields
        } finally {
            cleanupJson(filePath);
        }
    });

    // ============================================================
    // Test: file not found
    // ============================================================
    test('returns error for nonexistent file', () => {
        const issues = validateConfig('/nonexistent/path/providers.json');
        expect(issues.length).toBeGreaterThanOrEqual(1);
        expect(issues[0].type).toBe('ERROR');
        expect(issues[0].message).toContain('Cannot read');
    });

    // ============================================================
    // Test: invalid JSON
    // ============================================================
    test('returns error for invalid JSON', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-lint-badjson-'));
        const filePath = path.join(tmpDir, 'providers.json');
        fs.writeFileSync(filePath, '{invalid json}');

        try {
            const issues = validateConfig(filePath);
            expect(issues.length).toBeGreaterThanOrEqual(1);
            expect(issues[0].type).toBe('ERROR');
            expect(issues[0].message).toContain('Invalid JSON');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    // ============================================================
    // Test: invalid slot format (not "providerKey:modelId")
    // ============================================================
    test('invalid slot format in config', () => {
        const data = {
            providers: {
                p1: {
                    displayName: 'Provider One',
                    endpoint: 'https://api.p1.test',
                    keyEnv: 'P1_API_KEY',
                    authHeader: 'bearer',
                    wireFormat: 'anthropic',
                },
            },
            contextLimits: {
                'test-model': 100000,
            },
            configs: {
                test: {
                    name: 'Test Config',
                    opus: 'no-colon-here',
                    sonnet: 'p1:test-model',
                    haiku: 'p1:test-model',
                    sub: 'p1:test-model',
                },
            },
        };
        const filePath = makeProvidersJson(data);
        saveEnv(['P1_API_KEY']);
        process.env.P1_API_KEY = 'sk-p1';

        try {
            const issues = validateConfig(filePath);
            const formatIssues = issues.filter(i => i.section === 'configs' && i.message.indexOf('invalid format') >= 0);
            expect(formatIssues.length).toBeGreaterThanOrEqual(1);
            expect(formatIssues[0].message).toContain('no-colon-here');
        } finally {
            restoreEnv(['P1_API_KEY']);
            cleanupJson(filePath);
        }
    });
});

// ============================================================
// Test: formatLintResults produces non-empty output
// ============================================================
describe('formatLintResults', () => {
    test('formats empty issues', () => {
        const output = formatLintResults([], undefined);
        expect(output).toContain('DeepClaude Config Lint');
        expect(output).toContain('No issues');
    });

    test('formats issues with colors', () => {
        const issues = [
            { type: 'ERROR' as const, section: 'keys', message: 'Test error' },
            { type: 'WARNING' as const, section: 'keys', message: 'Test warning' },
        ];
        const output = formatLintResults(issues, undefined);
        expect(output).toContain('Test error');
        expect(output).toContain('Test warning');
        expect(output).toContain('1 error(s)');
        expect(output).toContain('1 warning(s)');
        // Should contain ANSI escape codes for colors
        expect(output).toContain('\x1b[31m');  // red
        expect(output).toContain('\x1b[33m');  // yellow
    });
});
