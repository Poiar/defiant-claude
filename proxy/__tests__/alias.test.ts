'use strict';

import { resolveAlias, resetAliasCache } from '../config';
import { resolveTarget } from '../routing';

// Helpers to build test routing state (copied from routing.test.ts)
function makeRouting(providers: Record<string, unknown>, routes?: Record<string, unknown>, defaultProvider?: string | null) {
    return { providers, routes: routes || {}, defaultProvider: defaultProvider || null };
}

function makeProvider(url: string, keyEnv: string, auth: string, format?: string, fallback?: string[]) {
    const p: Record<string, unknown> = { url, keyEnv, auth: auth || 'bearer', format: format || 'anthropic' };
    if (fallback) p.fallback = fallback;
    return p;
}

describe('resolveAlias', () => {
    beforeEach(() => {
        resetAliasCache();
    });

    test('returns same string for unknown models', () => {
        expect(resolveAlias('unknown-model-x99')).toBe('unknown-model-x99');
        expect(resolveAlias('gpt-4')).toBe('gpt-4');
        expect(resolveAlias('claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
        expect(resolveAlias('deepseek-v4-pro')).toBe('deepseek-v4-pro');
    });

    test('resolves all defined aliases', () => {
        expect(resolveAlias('sonnet')).toBe('claude-sonnet-4-6');
        expect(resolveAlias('opus')).toBe('claude-opus-4-7');
        expect(resolveAlias('haiku')).toBe('claude-haiku-4-5-20251001');
        expect(resolveAlias('v4')).toBe('deepseek-v4-pro');
        expect(resolveAlias('v4-pro')).toBe('deepseek-v4-pro');
        expect(resolveAlias('v4-flash')).toBe('deepseek-v4-flash');
        expect(resolveAlias('flash')).toBe('deepseek-v4-flash');
        expect(resolveAlias('big-pickle')).toBe('big-pickle');
        expect(resolveAlias('kimi')).toBe('kimi-k2.6');
        expect(resolveAlias('mimo')).toBe('mimo-v2.5-pro');
        expect(resolveAlias('groq')).toBe('groq/llama-4-maverick');
        expect(resolveAlias('mistral')).toBe('mistral/mistral-large');
        expect(resolveAlias('minimax')).toBe('minimax/minimax-m1');
        expect(resolveAlias('glm')).toBe('zai/glm-4.5');
        expect(resolveAlias('doubao')).toBe('byteplus/doubao-1.5-pro');
    });

    test('is case-insensitive', () => {
        expect(resolveAlias('SONNET')).toBe('claude-sonnet-4-6');
        expect(resolveAlias('Sonnet')).toBe('claude-sonnet-4-6');
        expect(resolveAlias('V4')).toBe('deepseek-v4-pro');
        expect(resolveAlias('Big-Pickle')).toBe('big-pickle');
    });

    test('returns empty string for empty input', () => {
        expect(resolveAlias('')).toBe('');
    });

    test('returns same for already-fully-qualified models', () => {
        expect(resolveAlias('claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
        expect(resolveAlias('deepseek-v4-pro')).toBe('deepseek-v4-pro');
        expect(resolveAlias('kimi-k2.6')).toBe('kimi-k2.6');
        expect(resolveAlias('deepseek/deepseek-v4-pro')).toBe('deepseek/deepseek-v4-pro');
    });
});

describe('resolveTarget with aliases', () => {
    beforeEach(() => {
        process.env.DEEPSEEK_KEY = 'test-ds-key';
        process.env.OPENCODE_KEY = 'test-oc-key';
    });

    afterEach(() => {
        delete process.env.DEEPSEEK_KEY;
        delete process.env.OPENCODE_KEY;
    });

    test('resolves alias in provider-prefixed model', async () => {
        const routing = makeRouting({
            ds: makeProvider('https://api.deepseek.com', 'DEEPSEEK_KEY', 'x-api-key'),
        }, {}, 'ds');

        const result = await resolveTarget('ds:sonnet', routing, {});
        expect(result.primary!.providerKey).toBe('ds');
        expect(result.primary!.rewriteModel).toBe('claude-sonnet-4-6');
    });

    test('resolves bare alias with default provider', async () => {
        const routing = makeRouting({
            ds: makeProvider('https://api.deepseek.com', 'DEEPSEEK_KEY', 'x-api-key'),
        }, {}, 'ds');

        const result = await resolveTarget('sonnet', routing, {});
        expect(result.primary!.providerKey).toBe('ds');
        // Bare alias without route falls back to default provider, rewriteModel stays null
        expect(result.primary!.rewriteModel).toBeNull();
    });

    test('resolves alias then routes table lookup', async () => {
        const routing = makeRouting({
            ds: makeProvider('https://api.deepseek.com', 'DEEPSEEK_KEY', 'x-api-key'),
            oc: makeProvider('https://api.zen.opencode.ai', 'OPENCODE_KEY', 'bearer'),
        }, {
            'claude-sonnet-4-6': 'oc',
        }, 'ds');

        const result = await resolveTarget('sonnet', routing, {});
        // 'sonnet' resolves to 'claude-sonnet-4-6', which exists in routes table -> routs to oc
        expect(result.primary!.providerKey).toBe('oc');
    });

    test('alias resolution does not affect non-alias models', async () => {
        const routing = makeRouting({
            ds: makeProvider('https://api.deepseek.com', 'DEEPSEEK_KEY', 'x-api-key'),
        }, {}, 'ds');

        const result = await resolveTarget('ds:deepseek-v4-pro', routing, {});
        expect(result.primary!.providerKey).toBe('ds');
        expect(result.primary!.rewriteModel).toBe('deepseek-v4-pro');
    });

    test('alias in slot prefix fallback is resolved', async () => {
        const routing = makeRouting({
            ds: makeProvider('https://api.deepseek.com', 'DEEPSEEK_KEY', 'x-api-key'),
        }, {}, 'ds');

        const result = await resolveTarget('sonnet:ds:v4', routing, {});
        expect(result.primary!.providerKey).toBe('ds');
        expect(result.primary!.rewriteModel).toBe('deepseek-v4-pro');
    });
});
