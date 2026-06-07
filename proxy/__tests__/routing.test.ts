'use strict';

import { resolveTarget } from '../routing';

// Helpers to build test routing state
function makeRouting(providers: Record<string, unknown>, routes?: Record<string, unknown>, defaultProvider?: string | null) {
    return { providers, routes: routes || {}, defaultProvider: defaultProvider || null };
}

function makeProvider(url: string, keyEnv: string, auth: string, format?: string, fallback?: string[]) {
    const p: Record<string, unknown> = { url, keyEnv, auth: auth || 'bearer', format: format || 'anthropic' };
    if (fallback) p.fallback = fallback;
    return p;
}

describe('resolveTarget', () => {
    beforeEach(() => {
        process.env.OPENROUTER_KEY = 'test-or-key';
        process.env.DEEPSEEK_KEY = 'test-ds-key';
        process.env.OPENCODE_KEY = 'test-oc-key';
    });

    afterEach(() => {
        delete process.env.OPENROUTER_KEY;
        delete process.env.DEEPSEEK_KEY;
        delete process.env.OPENCODE_KEY;
    });

    test('routes by model ID via routes table', () => {
        const routing = makeRouting({
            ds: makeProvider('https://api.deepseek.com', 'DEEPSEEK_KEY', 'x-api-key'),
        }, {
            'deepseek-v4-pro': 'ds',
        }, 'ds');

        const result = resolveTarget('deepseek-v4-pro', routing, {});
        expect(result.primary!.providerKey).toBe('ds');
        expect(result.primary!.url).toBe('https://api.deepseek.com');
        expect(result.primary!.isBearer).toBe(false);
        expect(result.fallbacks).toHaveLength(0);
    });

    test('resolves provider prefix syntax (provider:model)', () => {
        const routing = makeRouting({
            oc: makeProvider('https://api.zen.opencode.ai', 'OPENCODE_KEY', 'bearer'),
        }, {}, 'ds');

        const result = resolveTarget('oc:big-pickle', routing, {});
        expect(result.primary!.providerKey).toBe('oc');
        expect(result.primary!.rewriteModel).toBe('big-pickle');
    });

    test('resolves slot prefix with override', () => {
        const routing = makeRouting({
            ds: makeProvider('https://api.deepseek.com', 'DEEPSEEK_KEY', 'x-api-key'),
            oc: makeProvider('https://api.zen.opencode.ai', 'OPENCODE_KEY', 'bearer'),
        }, {}, 'ds');

        const overrides = { haiku: 'oc:big-pickle' };
        const result = resolveTarget('haiku:ds:deepseek-v4-flash', routing, overrides);
        expect(result.primary!.providerKey).toBe('oc');
        expect(result.primary!.rewriteModel).toBe('big-pickle');
    });

    test('falls back to slot model when no override', () => {
        const routing = makeRouting({
            ds: makeProvider('https://api.deepseek.com', 'DEEPSEEK_KEY', 'x-api-key'),
        }, {
            'deepseek-v4-flash': 'ds',
        }, 'ds');

        const result = resolveTarget('haiku:ds:deepseek-v4-flash', routing, {});
        expect(result.primary!.providerKey).toBe('ds');
    });

    test('uses default provider when model not in routes', () => {
        const routing = makeRouting({
            ds: makeProvider('https://api.deepseek.com', 'DEEPSEEK_KEY', 'x-api-key'),
        }, {}, 'ds');

        const result = resolveTarget('unknown-model', routing, {});
        expect(result.primary!.providerKey).toBe('ds');
    });

    test('builds fallback chain', () => {
        const routing = makeRouting({
            ds: makeProvider('https://api.deepseek.com', 'DEEPSEEK_KEY', 'x-api-key', 'anthropic', ['oc']),
            oc: makeProvider('https://api.zen.opencode.ai', 'OPENCODE_KEY', 'bearer'),
        }, {}, 'ds');

        const result = resolveTarget('any-model', routing, {});
        expect(result.fallbacks).toHaveLength(1);
        expect(result.fallbacks![0].providerKey).toBe('oc');
    });

    test('skips fallback if it matches primary', () => {
        const routing = makeRouting({
            ds: makeProvider('https://api.deepseek.com', 'DEEPSEEK_KEY', 'x-api-key', 'anthropic', ['ds']),
        }, {}, 'ds');

        const result = resolveTarget('any-model', routing, {});
        expect(result.fallbacks).toHaveLength(0);
    });

    test('skips fallback if key is missing', () => {
        const routing = makeRouting({
            ds: makeProvider('https://api.deepseek.com', 'DEEPSEEK_KEY', 'x-api-key', 'anthropic', ['missing']),
            missing: makeProvider('https://api.example.com', 'MISSING_KEY', 'bearer'),
        }, {}, 'ds');

        const result = resolveTarget('any-model', routing, {});
        expect(result.fallbacks).toHaveLength(0);
    });

    test('returns error for unknown provider', () => {
        const routing = makeRouting({}, {}, 'nonexistent');
        const result = resolveTarget('any-model', routing, {});
        expect(result.error).toBeTruthy();
    });

    test('returns error when no default provider configured', () => {
        const routing = makeRouting({}, {}, null);
        const result = resolveTarget('any-model', routing, {});
        expect(result.error).toBe('No default provider configured');
    });

    test('resolves route with object format (provider + rewrite)', () => {
        const routing = makeRouting({
            or: makeProvider('https://openrouter.ai/api/v1', 'OPENROUTER_KEY', 'bearer'),
        }, {
            'openrouter/owl-alpha': { provider: 'or', rewrite: 'openrouter/owl-alpha' },
        }, 'ds');

        const result = resolveTarget('openrouter/owl-alpha', routing, {});
        expect(result.primary!.providerKey).toBe('or');
        expect(result.primary!.rewriteModel).toBe('openrouter/owl-alpha');
    });
});
