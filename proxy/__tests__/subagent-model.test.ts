'use strict';

import { resolveTarget, resolveSubagentModel } from '../routing';
import { resetAliasCache } from '../config';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Helpers to build test routing state
function makeRouting(providers: Record<string, unknown>, routes?: Record<string, unknown>, defaultProvider?: string | null) {
    return { providers, routes: routes || {}, defaultProvider: defaultProvider || null };
}

function makeProvider(url: string, keyEnv: string, auth: string, format?: string, fallback?: string[]) {
    const p: Record<string, unknown> = { url, keyEnv, auth: auth || 'bearer', format: format || 'anthropic' };
    if (fallback) p.fallback = fallback;
    return p;
}

function writeSubagentModel(dir: string, data: unknown): void {
    const subDir = path.join(dir, '.deepclaude');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, 'subagent-model.json'), JSON.stringify(data));
}

function removeSubagentModel(dir: string): void {
    const filePath = path.join(dir, '.deepclaude', 'subagent-model.json');
    try { fs.unlinkSync(filePath); } catch (_) { /* ignore */ }
}

describe('resolveSubagentModel', () => {
    let tmpDir: string;
    let origHome: string | undefined;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-model-test-'));
        origHome = process.env.HOME;
        process.env.HOME = tmpDir;
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        if (origHome !== undefined) {
            process.env.HOME = origHome;
        } else {
            delete process.env.HOME;
        }
    });

    test('returns null when no config file exists', () => {
        expect(resolveSubagentModel()).toBeNull();
    });

    test('returns parsed config when file exists', () => {
        writeSubagentModel(tmpDir, { providerKey: 'oc', modelId: 'big-pickle' });
        const result = resolveSubagentModel();
        expect(result).not.toBeNull();
        expect(result!.providerKey).toBe('oc');
        expect(result!.modelId).toBe('big-pickle');
    });

    test('returns null for invalid JSON content', () => {
        const subDir = path.join(tmpDir, '.deepclaude');
        fs.mkdirSync(subDir, { recursive: true });
        fs.writeFileSync(path.join(subDir, 'subagent-model.json'), 'not valid json');
        expect(resolveSubagentModel()).toBeNull();
    });

    test('returns null when providerKey is missing', () => {
        writeSubagentModel(tmpDir, { modelId: 'big-pickle' });
        expect(resolveSubagentModel()).toBeNull();
    });

    test('returns null when modelId is missing', () => {
        writeSubagentModel(tmpDir, { providerKey: 'oc' });
        expect(resolveSubagentModel()).toBeNull();
    });

    test('returns null for empty object', () => {
        writeSubagentModel(tmpDir, {});
        expect(resolveSubagentModel()).toBeNull();
    });

    test('returns null when HOME is not set', () => {
        delete process.env.HOME;
        expect(resolveSubagentModel()).toBeNull();
    });

    test('hot-reload: reads file fresh on each call', () => {
        writeSubagentModel(tmpDir, { providerKey: 'oc', modelId: 'big-pickle' });
        const first = resolveSubagentModel();
        expect(first!.modelId).toBe('big-pickle');

        writeSubagentModel(tmpDir, { providerKey: 'ds', modelId: 'deepseek-v4-pro' });
        const second = resolveSubagentModel();
        expect(second!.providerKey).toBe('ds');
        expect(second!.modelId).toBe('deepseek-v4-pro');
    });
});

describe('resolveTarget with dedicated subagent model', () => {
    let tmpDir: string;
    let origHome: string | undefined;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-target-test-'));
        origHome = process.env.HOME;
        process.env.HOME = tmpDir;
        process.env.OPENROUTER_KEY = 'test-or-key';
        process.env.DEEPSEEK_KEY = 'test-ds-key';
        process.env.OPENCODE_KEY = 'test-oc-key';
        resetAliasCache();
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        if (origHome !== undefined) {
            process.env.HOME = origHome;
        } else {
            delete process.env.HOME;
        }
        delete process.env.OPENROUTER_KEY;
        delete process.env.DEEPSEEK_KEY;
        delete process.env.OPENCODE_KEY;
    });

    test('dedicated subagent model takes priority over routes table', async () => {
        writeSubagentModel(tmpDir, { providerKey: 'oc', modelId: 'big-pickle' });

        const routing = makeRouting({
            ds: makeProvider('https://api.deepseek.com', 'DEEPSEEK_KEY', 'x-api-key'),
            oc: makeProvider('https://api.zen.opencode.ai', 'OPENCODE_KEY', 'bearer'),
        }, {
            'deepseek-v4-flash': 'ds',
        }, 'ds');

        const result = await resolveTarget('subagent:ds:deepseek-v4-flash', routing, {});
        expect(result.primary!.providerKey).toBe('oc');
        expect(result.primary!.rewriteModel).toBe('big-pickle');
    });

    test('slot override takes priority over dedicated subagent model', async () => {
        writeSubagentModel(tmpDir, { providerKey: 'oc', modelId: 'big-pickle' });

        const routing = makeRouting({
            ds: makeProvider('https://api.deepseek.com', 'DEEPSEEK_KEY', 'x-api-key'),
            oc: makeProvider('https://api.zen.opencode.ai', 'OPENCODE_KEY', 'bearer'),
            or: makeProvider('https://openrouter.ai/api/v1', 'OPENROUTER_KEY', 'bearer'),
        }, {}, 'ds');

        const overrides = { subagent: 'or:openrouter/owl-alpha' };
        const result = await resolveTarget('subagent:ds:deepseek-v4-flash', routing, overrides);
        expect(result.primary!.providerKey).toBe('or');
        expect(result.primary!.rewriteModel).toBe('openrouter/owl-alpha');
    });

    test('config route takes effect when no dedicated model or override', async () => {
        const routing = makeRouting({
            ds: makeProvider('https://api.deepseek.com', 'DEEPSEEK_KEY', 'x-api-key'),
            oc: makeProvider('https://api.zen.opencode.ai', 'OPENCODE_KEY', 'bearer'),
        }, {
            'deepseek-v4-flash': 'ds',
            'big-pickle': 'oc',
        }, 'ds');

        // No dedicated model file exists
        const result = await resolveTarget('subagent:ds:deepseek-v4-flash', routing, {});
        // Without dedicated model or override, the fallback "ds:deepseek-v4-flash" is used.
        // rewriteModel is "deepseek-v4-flash" because prefix matching routes through alias resolution
        // and resolveAlias("deepseek-v4-flash") returns itself.
        expect(result.primary!.providerKey).toBe('ds');
        expect(result.primary!.rewriteModel).toBe('deepseek-v4-flash');
    });

    test('alias expansion works on dedicated subagent model (sonnet -> claude-sonnet-4-6)', async () => {
        writeSubagentModel(tmpDir, { providerKey: 'oc', modelId: 'sonnet' });

        const routing = makeRouting({
            ds: makeProvider('https://api.deepseek.com', 'DEEPSEEK_KEY', 'x-api-key'),
            oc: makeProvider('https://api.zen.opencode.ai', 'OPENCODE_KEY', 'bearer'),
        }, {}, 'ds');

        const result = await resolveTarget('subagent:ds:deepseek-v4-flash', routing, {});
        expect(result.primary!.providerKey).toBe('oc');
        // "sonnet" is aliased to "claude-sonnet-4-6" in providers.json
        expect(result.primary!.rewriteModel).toBe('claude-sonnet-4-6');
    });

    test('alias expansion works on dedicated subagent model (big-pickle passes through)', async () => {
        writeSubagentModel(tmpDir, { providerKey: 'oc', modelId: 'big-pickle' });

        const routing = makeRouting({
            ds: makeProvider('https://api.deepseek.com', 'DEEPSEEK_KEY', 'x-api-key'),
            oc: makeProvider('https://api.zen.opencode.ai', 'OPENCODE_KEY', 'bearer'),
        }, {}, 'ds');

        const result = await resolveTarget('subagent:ds:deepseek-v4-flash', routing, {});
        expect(result.primary!.providerKey).toBe('oc');
        // "big-pickle" is its own alias in providers.json (maps to itself)
        expect(result.primary!.rewriteModel).toBe('big-pickle');
    });

    test('non-subagent slots are not affected by dedicated subagent model', async () => {
        writeSubagentModel(tmpDir, { providerKey: 'oc', modelId: 'big-pickle' });

        const routing = makeRouting({
            ds: makeProvider('https://api.deepseek.com', 'DEEPSEEK_KEY', 'x-api-key'),
            oc: makeProvider('https://api.zen.opencode.ai', 'OPENCODE_KEY', 'bearer'),
        }, {}, 'ds');

        // Haiku slot should NOT use the dedicated subagent model
        const result = await resolveTarget('haiku:ds:deepseek-v4-flash', routing, {});
        expect(result.primary!.providerKey).toBe('ds');
    });

    test('dedicated subagent model used when no slot override and no routes match', async () => {
        writeSubagentModel(tmpDir, { providerKey: 'oc', modelId: 'big-pickle' });

        const routing = makeRouting({
            ds: makeProvider('https://api.deepseek.com', 'DEEPSEEK_KEY', 'x-api-key'),
            oc: makeProvider('https://api.zen.opencode.ai', 'OPENCODE_KEY', 'bearer'),
        }, {}, 'ds');

        const result = await resolveTarget('subagent:ds:deepseek-v4-flash', routing, {});
        expect(result.primary!.providerKey).toBe('oc');
        expect(result.primary!.rewriteModel).toBe('big-pickle');
    });

    test('invalid subagent model file falls back to config route', async () => {
        // Write invalid JSON
        fs.mkdirSync(path.join(tmpDir, '.deepclaude'), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, '.deepclaude', 'subagent-model.json'), '{{{broken');

        const routing = makeRouting({
            ds: makeProvider('https://api.deepseek.com', 'DEEPSEEK_KEY', 'x-api-key'),
        }, {
            'deepseek-v4-flash': 'ds',
        }, 'ds');

        const result = await resolveTarget('subagent:ds:deepseek-v4-flash', routing, {});
        expect(result.primary!.providerKey).toBe('ds');
    });
});
