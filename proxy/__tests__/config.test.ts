'use strict';

import { parseArgs, loadConfig, validateConfig } from '../config';
import fs from 'fs';
import path from 'path';
import os from 'os';

jest.mock('../ssrf', () => ({
  validateUrl: jest.fn().mockResolvedValue({ valid: true }),
}));

describe('parseArgs', () => {
    test('parses --routes with overrides', () => {
        const result = parseArgs([
            'node', 'start-proxy.js',
            '--routes', '/tmp/routes.json',
            '--overrides', '/tmp/overrides.json',
        ]);
        expect(result.routesFile).toBe('/tmp/routes.json');
        expect(result.overridesFile).toBe('/tmp/overrides.json');
        expect(result.singleUrl).toBeNull();
        expect(result.singleKey).toBeNull();
    });

    test('parses --routes without overrides', () => {
        const result = parseArgs([
            'node', 'start-proxy.js',
            '--routes', '/tmp/routes.json',
        ]);
        expect(result.routesFile).toBe('/tmp/routes.json');
        expect(result.overridesFile).toBeNull();
    });

    test('parses single provider mode', () => {
        const result = parseArgs([
            'node', 'start-proxy.js',
            'https://api.deepseek.com',
            'sk-test-key',
        ]);
        expect(result.singleUrl).toBe('https://api.deepseek.com');
        expect(result.singleKey).toBe('sk-test-key');
        expect(result.routesFile).toBeNull();
    });
});

describe('loadConfig', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-test-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('loads routes file', () => {
        const routesPath = path.join(tmpDir, 'routes.json');
        fs.writeFileSync(routesPath, JSON.stringify({
            providers: { ds: { url: 'https://api.deepseek.com', keyEnv: 'DEEPSEEK_KEY', auth: 'x-api-key' } },
            routes: {},
            defaultProvider: 'ds',
        }));

        const state = loadConfig({ routesFile: routesPath, overridesFile: null });
        expect(state.routing!.defaultProvider).toBe('ds');
        expect(state.routing!.providers.ds.url).toBe('https://api.deepseek.com');
    });

    test('handles missing overrides file gracefully', () => {
        const routesPath = path.join(tmpDir, 'routes.json');
        fs.writeFileSync(routesPath, JSON.stringify({ providers: {}, routes: {}, defaultProvider: 'ds' }));

        const overridesPath = path.join(tmpDir, 'nonexistent.json');
        const state = loadConfig({ routesFile: routesPath, overridesFile: overridesPath });
        expect(state.slotOverrides).toEqual({});
    });
});

describe('validateConfig', () => {
    test('warns about missing default provider', () => {
        const routing = {
            providers: { ds: { url: 'https://api.deepseek.com', keyEnv: 'KEY', auth: 'x-api-key' } },
            routes: {},
            defaultProvider: 'nonexistent',
        };
        const warnings = validateConfig({ routing });
        expect(warnings.some(w => w.includes('nonexistent'))).toBe(true);
    });

    test('warns about provider with no URL', () => {
        const routing = {
            providers: { bad: { keyEnv: 'KEY', auth: 'bearer' } },
            routes: {},
            defaultProvider: 'bad',
        };
        const warnings = validateConfig({ routing });
        expect(warnings.some(w => w.includes('URL'))).toBe(true);
    });

    test('returns no warnings for valid config', () => {
        const routing = {
            providers: { ds: { url: 'https://api.deepseek.com', keyEnv: 'KEY', auth: 'x-api-key' } },
            routes: {},
            defaultProvider: 'ds',
        };
        const warnings = validateConfig({ routing });
        expect(warnings).toHaveLength(0);
    });
});
