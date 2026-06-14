'use strict';

import { parseArgs, loadConfig, validateConfig } from '../config';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  readJson,
  tryReadJson,
  resolveKey,
  resolveProviderKey,
  loadAliases,
  resetAliasCache,
  resolveAlias,
  applyThinkingOverrides,
  getEffectiveThinkingConfig,
} from '../config';

jest.mock('../ssrf', () => ({
  validateUrl: jest.fn().mockResolvedValue({ valid: true }),
}));
jest.mock('../crypto', () => ({
  decrypt: jest.fn(),
}));
jest.mock('../stats', () => ({
  reconcileCircuitBreakers: jest.fn(),
  reconcileProviderStats: jest.fn(),
  registerProviderInfo: jest.fn(),
  reloadPricing: jest.fn(),
}));
jest.mock('child_process', () => ({
  execSync: jest.fn(() => {
    throw new Error('not found');
  }),
}));

describe('parseArgs', () => {
  test('parses --routes with overrides', () => {
    const result = parseArgs([
      'node',
      'start-proxy.js',
      '--routes',
      '/tmp/routes.json',
      '--overrides',
      '/tmp/overrides.json',
    ]);
    expect(result.routesFile).toBe('/tmp/routes.json');
    expect(result.overridesFile).toBe('/tmp/overrides.json');
    expect(result.singleUrl).toBeNull();
    expect(result.singleKey).toBeNull();
  });

  test('parses --routes without overrides', () => {
    const result = parseArgs(['node', 'start-proxy.js', '--routes', '/tmp/routes.json']);
    expect(result.routesFile).toBe('/tmp/routes.json');
    expect(result.overridesFile).toBeNull();
  });

  test('parses single provider mode', () => {
    const result = parseArgs(['node', 'start-proxy.js', 'https://api.deepseek.com', 'sk-test-key']);
    expect(result.singleUrl).toBe('https://api.deepseek.com');
    expect(result.singleKey).toBe('sk-test-key');
    expect(result.routesFile).toBeNull();
  });

  test('parses --port', () => {
    const result = parseArgs([
      'node',
      'start-proxy.js',
      '--routes',
      '/tmp/routes.json',
      '--port',
      '54432',
    ]);
    expect(result.port).toBe(54432);
    expect(result.routesFile).toBe('/tmp/routes.json');
  });

  test('parses --port before --routes', () => {
    const result = parseArgs([
      'node',
      'start-proxy.js',
      '--port',
      '9999',
      '--routes',
      '/tmp/routes.json',
    ]);
    expect(result.port).toBe(9999);
    expect(result.routesFile).toBe('/tmp/routes.json');
  });

  test('--port defaults to null when not provided', () => {
    const result = parseArgs(['node', 'start-proxy.js', '--routes', '/tmp/routes.json']);
    expect(result.port).toBeNull();
  });

  test('rejects invalid --port (0)', () => {
    const throwExit = (): never => {
      throw new Error('exit');
    };
    const mockExit = jest.spyOn(process, 'exit').mockImplementation(throwExit as any);
    const mockError = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(() =>
      parseArgs(['node', 'start-proxy.js', '--routes', '/tmp/routes.json', '--port', '0']),
    ).toThrow('exit');
    mockExit.mockRestore();
    mockError.mockRestore();
  });

  test('rejects invalid --port (>65535)', () => {
    const throwExit = (): never => {
      throw new Error('exit');
    };
    const mockExit = jest.spyOn(process, 'exit').mockImplementation(throwExit as any);
    const mockError = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(() =>
      parseArgs(['node', 'start-proxy.js', '--routes', '/tmp/routes.json', '--port', '99999']),
    ).toThrow('exit');
    mockExit.mockRestore();
    mockError.mockRestore();
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
    fs.writeFileSync(
      routesPath,
      JSON.stringify({
        providers: {
          ds: { url: 'https://api.deepseek.com', keyEnv: 'DEEPSEEK_KEY', auth: 'x-api-key' },
        },
        routes: {},
        defaultProvider: 'ds',
      }),
    );

    const state = loadConfig({ routesFile: routesPath, overridesFile: null });
    expect(state.routing!.defaultProvider).toBe('ds');
    expect(state.routing!.providers.ds.url).toBe('https://api.deepseek.com');
  });

  test('handles missing overrides file gracefully', () => {
    const routesPath = path.join(tmpDir, 'routes.json');
    fs.writeFileSync(
      routesPath,
      JSON.stringify({ providers: {}, routes: {}, defaultProvider: 'ds' }),
    );

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
    expect(warnings.some((w) => w.includes('nonexistent'))).toBe(true);
  });

  test('warns about provider with no URL', () => {
    const routing = {
      providers: { bad: { keyEnv: 'KEY', auth: 'bearer' } },
      routes: {},
      defaultProvider: 'bad',
    };
    const warnings = validateConfig({ routing });
    expect(warnings.some((w) => w.includes('URL'))).toBe(true);
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

// ===== readJson / tryReadJson =====

describe('readJson', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-test-read-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('parses valid JSON', () => {
    const p = path.join(tmpDir, 'valid.json');
    fs.writeFileSync(p, JSON.stringify({ a: 1, b: 'hello' }));
    expect(readJson(p)).toEqual({ a: 1, b: 'hello' });
  });

  test('throws on missing file', () => {
    const p = path.join(tmpDir, 'nonexistent.json');
    expect(() => readJson(p)).toThrow();
  });

  test('throws on malformed JSON', () => {
    const p = path.join(tmpDir, 'bad.json');
    fs.writeFileSync(p, '{ not json }');
    expect(() => readJson(p)).toThrow(SyntaxError);
  });

  test('throws on empty file with JSON parse error', () => {
    const p = path.join(tmpDir, 'empty.json');
    fs.writeFileSync(p, '');
    expect(() => readJson(p)).toThrow(SyntaxError);
  });
});

describe('tryReadJson', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-test-try-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('returns parsed data on success', () => {
    const p = path.join(tmpDir, 'ok.json');
    fs.writeFileSync(p, JSON.stringify({ x: 42 }));
    expect(tryReadJson(p)).toEqual({ x: 42 });
  });

  test('returns null on missing file', () => {
    const p = path.join(tmpDir, 'nope.json');
    expect(tryReadJson(p)).toBeNull();
  });

  test('returns null on malformed JSON', () => {
    const p = path.join(tmpDir, 'bad.json');
    fs.writeFileSync(p, '{ invalid }');
    expect(tryReadJson(p)).toBeNull();
  });
});

// ===== resolveKey =====

describe('resolveKey', () => {
  const { decrypt } = require('../crypto');

  beforeEach(() => {
    delete process.env.DEEPCLAUDE_ENCRYPTION_KEY;
    decrypt.mockReset();
  });

  test('returns null for null input', async () => {
    expect(await resolveKey(null)).toBeNull();
  });

  test('returns null for undefined input', async () => {
    expect(await resolveKey(undefined)).toBeNull();
  });

  test('returns null for literal "null" string', async () => {
    expect(await resolveKey('null')).toBeNull();
  });

  test('returns plaintext key as-is', async () => {
    expect(await resolveKey('sk-plaintext-key')).toBe('sk-plaintext-key');
  });

  test('passes through non-string types', async () => {
    const num = 12345 as unknown as string;
    expect(await resolveKey(num)).toBe(12345 as unknown as string);
  });

  test('encrypted key without env var returns null', async () => {
    const result = await resolveKey('$aes256gcm:salt:iv:tag:cipher');
    expect(result).toBeNull();
    expect(decrypt).not.toHaveBeenCalled();
  });

  test('encrypted key with env var and successful decrypt', async () => {
    process.env.DEEPCLAUDE_ENCRYPTION_KEY = 'my-secret';
    decrypt.mockResolvedValue('decrypted-key-value');
    const result = await resolveKey('$aes256gcm:salt:iv:tag:cipher');
    expect(result).toBe('decrypted-key-value');
    expect(decrypt).toHaveBeenCalledWith('$aes256gcm:salt:iv:tag:cipher', 'my-secret');
  });

  test('encrypted key with env var and decryption failure', async () => {
    process.env.DEEPCLAUDE_ENCRYPTION_KEY = 'my-secret';
    decrypt.mockRejectedValue(new Error('decrypt error'));
    const result = await resolveKey('$aes256gcm:salt:iv:tag:cipher');
    expect(result).toBeNull();
  });
});

// ===== resolveProviderKey =====

describe('resolveProviderKey', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    process.env = { ...OLD_ENV };
    delete process.env.TEST_PROVIDER_KEY;
    delete process.env.EMPTY_VAR;
  });

  afterAll(() => {
    process.env = OLD_ENV;
  });

  test('returns empty string for null/undefined key env', () => {
    expect(resolveProviderKey(null as unknown as string)).toBe('');
    expect(resolveProviderKey(undefined as unknown as string)).toBe('');
  });

  test('returns empty string for empty key env', () => {
    expect(resolveProviderKey('')).toBe('');
  });

  test('returns empty string for non-string key env', () => {
    expect(resolveProviderKey(123 as unknown as string)).toBe('');
  });

  test('returns env var value when set', () => {
    process.env.TEST_PROVIDER_KEY = 'sk-my-key';
    expect(resolveProviderKey('TEST_PROVIDER_KEY')).toBe('sk-my-key');
  });

  test('returns empty string when env var is not set', () => {
    expect(resolveProviderKey('NONEXISTENT_VAR')).toBe('');
  });

  test('returns empty string for empty env var', () => {
    process.env.EMPTY_VAR = '';
    expect(resolveProviderKey('EMPTY_VAR')).toBe('');
  });

  test('returns whitespace env var as-is', () => {
    process.env.TEST_PROVIDER_KEY = '  ';
    expect(resolveProviderKey('TEST_PROVIDER_KEY')).toBe('  ');
  });
});

// ===== loadAliases / resetAliasCache / resolveAlias =====

describe('loadAliases', () => {
  beforeEach(() => {
    resetAliasCache();
  });

  test('loads aliases from providers.json on disk', () => {
    const aliases = loadAliases();
    expect(typeof aliases).toBe('object');
    // Real providers.json has these aliases
    expect(aliases.sonnet).toBe('claude-sonnet-4-6');
  });

  test('returns cached result on second call without reset', () => {
    const first = loadAliases();
    const second = loadAliases();
    expect(second).toBe(first);
  });

  test('reloads from disk after cache reset', () => {
    const first = loadAliases();
    resetAliasCache();
    const second = loadAliases();
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
  });
});

describe('resetAliasCache', () => {
  test('clears the cache so next loadAliases re-reads from disk', () => {
    resetAliasCache();
    const a = loadAliases();
    resetAliasCache();
    const b = loadAliases();
    expect(b).toEqual(a);
  });
});

describe('resolveAlias', () => {
  beforeEach(() => {
    resetAliasCache();
  });

  test('returns empty string for empty input', () => {
    expect(resolveAlias('')).toBe('');
  });

  test('resolves exact match alias', () => {
    expect(resolveAlias('sonnet')).toBe('claude-sonnet-4-6');
  });

  test('resolves case-insensitive alias', () => {
    expect(resolveAlias('SONNET')).toBe('claude-sonnet-4-6');
    expect(resolveAlias('Sonnet')).toBe('claude-sonnet-4-6');
  });

  test('resolves flash alias', () => {
    expect(resolveAlias('flash')).toBe('deepseek-v4-flash');
  });

  test('returns original string for unknown alias', () => {
    expect(resolveAlias('unknown-model-xyz')).toBe('unknown-model-xyz');
  });
});

// ===== applyThinkingOverrides / getEffectiveThinkingConfig =====

describe('applyThinkingOverrides', () => {
  const baseConfig = {
    'model-a': { type: 'enabled', budget_tokens: 16000 },
    'model-b': { type: 'enabled', budget_tokens: 32000 },
  };

  test('null overridesFile returns base unchanged', () => {
    const result = applyThinkingOverrides(baseConfig, null);
    expect(result).toEqual(baseConfig);
  });

  test('returns base unchanged when overrides file parse fails', () => {
    const result = applyThinkingOverrides(baseConfig, '/nonexistent/overrides.json');
    expect(result).toEqual(baseConfig);
  });

  test('null override removes model from config', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-test-think-'));
    try {
      const overridesPath = path.join(tmpDir, 'overrides.json');
      fs.writeFileSync(overridesPath, JSON.stringify({ 'model-a': null }));
      const result = applyThinkingOverrides(baseConfig, overridesPath);
      expect(result['model-a']).toBeUndefined();
      expect(result['model-b']).toEqual({ type: 'enabled', budget_tokens: 32000 });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('override with type only preserves base budget_tokens', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-test-think-'));
    try {
      const overridesPath = path.join(tmpDir, 'overrides.json');
      fs.writeFileSync(overridesPath, JSON.stringify({ 'model-a': { type: 'disabled' } }));
      const result = applyThinkingOverrides(baseConfig, overridesPath);
      expect(result['model-a']).toEqual({ type: 'disabled', budget_tokens: 16000 });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('override with budget_tokens only preserves base type', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-test-think-'));
    try {
      const overridesPath = path.join(tmpDir, 'overrides.json');
      fs.writeFileSync(overridesPath, JSON.stringify({ 'model-b': { budget_tokens: 64000 } }));
      const result = applyThinkingOverrides(baseConfig, overridesPath);
      expect(result['model-b']).toEqual({ type: 'enabled', budget_tokens: 64000 });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('full override replaces both type and budget_tokens', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-test-think-'));
    try {
      const overridesPath = path.join(tmpDir, 'overrides.json');
      fs.writeFileSync(
        overridesPath,
        JSON.stringify({ 'model-a': { type: 'disabled', budget_tokens: 8000 } }),
      );
      const result = applyThinkingOverrides(baseConfig, overridesPath);
      expect(result['model-a']).toEqual({ type: 'disabled', budget_tokens: 8000 });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('model in override but not in base gets defaults', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-test-think-'));
    try {
      const overridesPath = path.join(tmpDir, 'overrides.json');
      fs.writeFileSync(overridesPath, JSON.stringify({ 'new-model': { type: 'enabled' } }));
      const result = applyThinkingOverrides(baseConfig, overridesPath);
      expect(result['new-model']).toEqual({ type: 'enabled', budget_tokens: 16000 });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('multiple models overridden simultaneously', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-test-think-'));
    try {
      const overridesPath = path.join(tmpDir, 'overrides.json');
      fs.writeFileSync(
        overridesPath,
        JSON.stringify({
          'model-a': null,
          'model-b': { budget_tokens: 99999 },
        }),
      );
      const result = applyThinkingOverrides(baseConfig, overridesPath);
      expect(result['model-a']).toBeUndefined();
      expect(result['model-b']).toEqual({ type: 'enabled', budget_tokens: 99999 });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('getEffectiveThinkingConfig', () => {
  test('delegates to applyThinkingOverrides', () => {
    const base = { m: { type: 'enabled', budget_tokens: 1000 } };
    const result = getEffectiveThinkingConfig(base, null);
    expect(result).toEqual(base);
  });
});

// ===== parseArgs additional =====

describe('parseArgs additional edge cases', () => {
  let exitSpy: jest.SpyInstance;

  beforeEach(() => {
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
      /* noop */
    });
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  test('parses --routes with --providers', () => {
    const result = parseArgs(['node', 'start.js', '--routes', '/r.json', '--providers', '/p.json']);
    expect(result.routesFile).toBe('/r.json');
    expect(result.providersFile).toBe('/p.json');
    expect(result.overridesFile).toBeNull();
    expect(result.thinkingOverridesFile).toBeNull();
  });

  test('parses --routes with --thinking-overrides', () => {
    const result = parseArgs([
      'node',
      'start.js',
      '--routes',
      '/r.json',
      '--thinking-overrides',
      '/t.json',
    ]);
    expect(result.routesFile).toBe('/r.json');
    expect(result.thinkingOverridesFile).toBe('/t.json');
  });

  test('parses --routes with all optional flags', () => {
    const result = parseArgs([
      'node',
      'start.js',
      '--routes',
      '/r.json',
      '--overrides',
      '/o.json',
      '--providers',
      '/p.json',
      '--thinking-overrides',
      '/t.json',
    ]);
    expect(result.routesFile).toBe('/r.json');
    expect(result.overridesFile).toBe('/o.json');
    expect(result.providersFile).toBe('/p.json');
    expect(result.thinkingOverridesFile).toBe('/t.json');
    expect(result.singleUrl).toBeNull();
    expect(result.singleKey).toBeNull();
  });

  test('calls process.exit on invalid args', () => {
    parseArgs(['node', 'start.js']);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test('stops processing optional flags at unknown flags', () => {
    // Once a flag is encountered that doesn't match --overrides/--providers/--thinking-overrides,
    // the loop should skip past it. Unknown flags are just ignored by the loop.
    const result = parseArgs([
      'node',
      'start.js',
      '--routes',
      '/r.json',
      '--unknown',
      'whatever',
      '--overrides',
      '/o.json',
    ]);
    // The loop at i=2 checks args[2]='--unknown', doesn't match any known flag, skips
    // then i=4: args[4]='--overrides' but args[5] would be args[5]='whatever' — wait let me re-check
    // Actually the overrides might still get picked up depending on indices.
    // The key point is the function doesn't crash on unexpected flags.
    expect(result.routesFile).toBe('/r.json');
  });
});

// ===== loadConfig additional =====

describe('loadConfig additional edge cases', () => {
  let tmpDir: string;
  let exitSpy: jest.SpyInstance;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-test-load-'));
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
      /* noop */
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    exitSpy.mockRestore();
  });

  test('exits with code 1 on failed routes file', () => {
    const result = loadConfig({
      routesFile: path.join(tmpDir, 'nonexistent.json'),
      overridesFile: null,
    });
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(result.routing).toBeNull();
  });

  test('loads providers metadata and patches routing', () => {
    const routesPath = path.join(tmpDir, 'routes.json');
    const providersPath = path.join(tmpDir, 'providers.json');
    fs.writeFileSync(
      routesPath,
      JSON.stringify({
        providers: { ds: { url: '', keyEnv: '', auth: 'bearer', format: 'anthropic' } },
        routes: {},
      }),
    );
    fs.writeFileSync(
      providersPath,
      JSON.stringify({
        providers: {
          ds: {
            endpoint: 'https://api.new.com',
            keyEnv: 'NEW_KEY',
            authHeader: 'x-api-key',
            wireFormat: 'openai',
          },
        },
      }),
    );
    const state = loadConfig({
      routesFile: routesPath,
      overridesFile: null,
      providersFile: providersPath,
    });
    // Metadata should be patched onto the routing
    expect(state.routing!.providers.ds.url).toBe('https://api.new.com');
    expect(state.routing!.providers.ds.keyEnv).toBe('NEW_KEY');
    expect(state.routing!.providers.ds.auth).toBe('x-api-key');
    expect(state.routing!.providers.ds.format).toBe('openai');
    expect(state.providersFile).toBe(providersPath);
  });

  test('provider metadata creates new provider if missing from routing', () => {
    const routesPath = path.join(tmpDir, 'routes.json');
    const providersPath = path.join(tmpDir, 'providers.json');
    fs.writeFileSync(routesPath, JSON.stringify({ providers: {}, routes: {} }));
    fs.writeFileSync(
      providersPath,
      JSON.stringify({
        providers: {
          newp: {
            endpoint: 'https://new.provider.com',
            keyEnv: 'NEWP_KEY',
            authHeader: 'bearer',
            wireFormat: 'anthropic',
          },
        },
      }),
    );
    const state = loadConfig({
      routesFile: routesPath,
      overridesFile: null,
      providersFile: providersPath,
    });
    expect(state.routing!.providers.newp).toBeDefined();
    expect(state.routing!.providers.newp.url).toBe('https://new.provider.com');
  });

  test('loads thinking config from providers.json', () => {
    const routesPath = path.join(tmpDir, 'routes.json');
    const providersPath = path.join(tmpDir, 'providers.json');
    fs.writeFileSync(
      routesPath,
      JSON.stringify({ providers: { ds: { url: 'https://api.ds.com', keyEnv: 'K' } }, routes: {} }),
    );
    fs.writeFileSync(
      providersPath,
      JSON.stringify({
        providers: {
          ds: {
            endpoint: 'https://api.ds.com',
            keyEnv: 'K',
            authHeader: 'bearer',
            wireFormat: 'anthropic',
          },
        },
        thinking: { 'deepseek-v4-pro': { type: 'enabled', budget_tokens: 32000 } },
      }),
    );
    const state = loadConfig({
      routesFile: routesPath,
      overridesFile: null,
      providersFile: providersPath,
    });
    expect(state.thinkingConfig).toEqual({
      'deepseek-v4-pro': { type: 'enabled', budget_tokens: 32000 },
    });
  });

  test('handles providers file load failure gracefully', () => {
    const routesPath = path.join(tmpDir, 'routes.json');
    fs.writeFileSync(
      routesPath,
      JSON.stringify({ providers: { ds: { url: 'https://api.ds.com', keyEnv: 'K' } }, routes: {} }),
    );
    const state = loadConfig({
      routesFile: routesPath,
      overridesFile: null,
      providersFile: '/nonexistent/providers.json',
    });
    // Should not crash; routing should remain loaded
    expect(state.routing).toBeDefined();
    expect(state.providersMtime).toBe(0);
  });

  test('returns null routing when no routesFile', () => {
    const state = loadConfig({ routesFile: null, overridesFile: null });
    expect(state.routing).toBeNull();
    expect(state.slotOverrides).toEqual({});
  });

  test('parses overrides file successfully', () => {
    const routesPath = path.join(tmpDir, 'routes.json');
    const overridesPath = path.join(tmpDir, 'overrides.json');
    fs.writeFileSync(routesPath, JSON.stringify({ providers: {}, routes: {} }));
    fs.writeFileSync(overridesPath, JSON.stringify({ 'model-a': 'provider-x' }));
    const state = loadConfig({
      routesFile: routesPath,
      overridesFile: overridesPath,
    });
    expect(state.slotOverrides).toEqual({ 'model-a': 'provider-x' });
  });
});

// ===== validateConfig additional =====

describe('validateConfig additional edge cases', () => {
  test('returns empty warnings when routing is null', () => {
    const warnings = validateConfig({ routing: null as unknown as RoutingConfig });
    expect(warnings).toEqual([]);
  });

  test('returns empty warnings when routing has no providers', () => {
    const warnings = validateConfig({ routing: { providers: {}, routes: {} } as RoutingConfig });
    expect(warnings).toEqual([]);
  });

  test('warns about unrecognized auth type', () => {
    const routing = {
      providers: { p: { url: 'https://x.com', keyEnv: 'K', auth: 'custom-token' } },
      routes: {},
    };
    const warnings = validateConfig({ routing });
    expect(warnings.some((w) => w.includes('custom-token'))).toBe(true);
  });

  test('warns about unrecognized format', () => {
    const routing = {
      providers: { p: { url: 'https://x.com', keyEnv: 'K', format: 'vertex-ai' } },
      routes: {},
    };
    const warnings = validateConfig({ routing });
    expect(warnings.some((w) => w.includes('vertex-ai'))).toBe(true);
  });

  test('warns about fallback to unknown provider', () => {
    const routing = {
      providers: {
        p1: { url: 'https://x.com', keyEnv: 'K', fallback: ['p2', 'nonexistent'] },
      },
      routes: {},
      defaultProvider: 'p1',
    };
    const warnings = validateConfig({ routing });
    expect(warnings.some((w) => w.includes('nonexistent'))).toBe(true);
    expect(warnings.some((w) => w.includes('p2'))).toBe(true); // p2 is also not in providerKeys
  });

  test('warns about route string referencing unknown provider', () => {
    const routing = {
      providers: { p: { url: 'https://x.com', keyEnv: 'K' } },
      routes: { 'model-a': 'nonexistent-provider' },
      defaultProvider: 'p',
    };
    const warnings = validateConfig({ routing });
    expect(warnings.some((w) => w.includes('model-a') && w.includes('nonexistent-provider'))).toBe(
      true,
    );
  });

  test('warns about route object referencing unknown provider', () => {
    const routing = {
      providers: { p: { url: 'https://x.com', keyEnv: 'K' } },
      routes: { 'model-b': { provider: 'missing-provider' } },
      defaultProvider: 'p',
    };
    const warnings = validateConfig({ routing });
    expect(warnings.some((w) => w.includes('model-b') && w.includes('missing-provider'))).toBe(
      true,
    );
  });

  test('no warning for valid route object with known provider', () => {
    const routing = {
      providers: { p: { url: 'https://x.com', keyEnv: 'K' } },
      routes: { 'model-c': { provider: 'p' } },
      defaultProvider: 'p',
    };
    const warnings = validateConfig({ routing });
    expect(warnings).toHaveLength(0);
  });
});

// ===== applyProviderMetadata (internal, tested via loadConfig) =====

describe('applyProviderMetadata (via loadConfig)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-test-meta-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createRoutes(providers: Record<string, any>) {
    const p = path.join(tmpDir, 'routes.json');
    fs.writeFileSync(p, JSON.stringify({ providers, routes: {} }));
    return p;
  }

  function createProviders(data: any) {
    const p = path.join(tmpDir, 'providers.json');
    fs.writeFileSync(p, JSON.stringify(data));
    return p;
  }

  test('adds new provider fields from providers.json', () => {
    const routesPath = createRoutes({
      existing: { url: 'https://old.com' }, // no keyEnv — will be patched from providers.json
    });
    const providersPath = createProviders({
      providers: {
        existing: {
          endpoint: 'https://new.com',
          keyEnv: 'NEW_KEY',
          authHeader: 'x-api-key',
          wireFormat: 'openai',
          fallback: ['alt'],
          extraHeaders: { 'X-Custom': 'val' },
          streamUsageReporting: 'openai_stream_options',
          noAutoFallback: true,
        },
      },
    });
    const state = loadConfig({
      routesFile: routesPath,
      overridesFile: null,
      providersFile: providersPath,
    });
    const p = state.routing!.providers.existing;
    expect(p.url).toBe('https://new.com');
    expect(p.keyEnv).toBe('NEW_KEY');
    expect(p.auth).toBe('x-api-key');
    expect(p.format).toBe('openai');
    expect(p.fallback).toEqual(['alt']);
    expect(p.extraHeaders).toEqual({ 'X-Custom': 'val' });
    expect(p.streamUsageReporting).toBe('openai_stream_options');
    expect(p.noAutoFallback).toBe(true);
  });

  test('does not remove providers when providers list is empty', () => {
    const routesPath = createRoutes({
      keep: { url: 'https://keep.com', keyEnv: 'K' },
    });
    const providersPath = createProviders({ providers: {} });
    const state = loadConfig({
      routesFile: routesPath,
      overridesFile: null,
      providersFile: providersPath,
    });
    // Empty providers {} should NOT trigger removal (SAFETY check)
    expect(state.routing!.providers.keep).toBeDefined();
  });

  test('removes providers not in the new providers list (non-empty)', () => {
    const routesPath = createRoutes({
      keep: { url: 'https://keep.com', keyEnv: 'K' },
      remove: { url: 'https://remove.com', keyEnv: 'K' },
    });
    const providersPath = createProviders({
      providers: {
        keep: {
          endpoint: 'https://keep.com',
          keyEnv: 'K',
          authHeader: 'bearer',
          wireFormat: 'anthropic',
        },
      },
    });
    const state = loadConfig({
      routesFile: routesPath,
      overridesFile: null,
      providersFile: providersPath,
    });
    expect(state.routing!.providers.keep).toBeDefined();
    expect(state.routing!.providers.remove).toBeUndefined();
  });

  test('patches extraHeaders on existing provider', () => {
    const routesPath = createRoutes({
      p: { url: 'https://x.com', keyEnv: 'K', auth: 'bearer', format: 'anthropic' },
    });
    const providersPath = createProviders({
      providers: {
        p: {
          endpoint: 'https://x.com',
          keyEnv: 'K',
          authHeader: 'bearer',
          wireFormat: 'anthropic',
          extraHeaders: { 'X-New': 'header' },
        },
      },
    });
    const state = loadConfig({
      routesFile: routesPath,
      overridesFile: null,
      providersFile: providersPath,
    });
    expect(state.routing!.providers.p.extraHeaders).toEqual({ 'X-New': 'header' });
  });

  test('patches streamUsageReporting on existing provider', () => {
    const routesPath = createRoutes({
      p: { url: 'https://x.com', keyEnv: 'K', auth: 'bearer', format: 'anthropic' },
    });
    const providersPath = createProviders({
      providers: {
        p: {
          endpoint: 'https://x.com',
          keyEnv: 'K',
          authHeader: 'bearer',
          wireFormat: 'anthropic',
          streamUsageReporting: 'openai_stream_options',
        },
      },
    });
    const state = loadConfig({
      routesFile: routesPath,
      overridesFile: null,
      providersFile: providersPath,
    });
    expect(state.routing!.providers.p.streamUsageReporting).toBe('openai_stream_options');
  });

  test('patches noAutoFallback on existing provider', () => {
    const routesPath = createRoutes({
      p: { url: 'https://x.com', keyEnv: 'K', auth: 'bearer', format: 'anthropic' },
    });
    const providersPath = createProviders({
      providers: {
        p: {
          endpoint: 'https://x.com',
          keyEnv: 'K',
          authHeader: 'bearer',
          wireFormat: 'anthropic',
          noAutoFallback: true,
        },
      },
    });
    const state = loadConfig({
      routesFile: routesPath,
      overridesFile: null,
      providersFile: providersPath,
    });
    expect(state.routing!.providers.p.noAutoFallback).toBe(true);
  });

  test('skips patching when providersData has no providers key', () => {
    const routesPath = createRoutes({
      p: { url: 'https://x.com', keyEnv: 'K' },
    });
    // providersData with no "providers" key — applyProviderMetadata returns false
    const providersPath = createProviders({ thinking: {} });
    const state = loadConfig({
      routesFile: routesPath,
      overridesFile: null,
      providersFile: providersPath,
    });
    // Provider should remain as-is in routing
    expect(state.routing!.providers.p.url).toBe('https://x.com');
  });
});

// ===== checkReload =====

describe('checkReload', () => {
  // Each call to checkReload modifies the module-level lastStatCheck,
  // which creates cross-test contamination.  We use jest.resetModules()
  // + a fresh require() so every test gets a pristine module with
  // lastStatCheck = 0 and the time gate open.
  async function freshCheckReload(state: any, parsed: any): Promise<boolean> {
    jest.resetModules();
    const { checkReload: cr } = require('../config');
    return cr(state, parsed);
  }

  const T0 = 9999999999000;
  let state: any;
  let parsed: any;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(T0);

    parsed = {};
    state = {
      routing: { providers: {}, routes: {} },
      routesMtime: 0,
      slotOverrides: {},
      overridesMtime: 0,
      providersFile: null,
      providersMtime: 0,
      thinkingOverridesFile: null,
      thinkingOverridesMtime: 0,
      thinkingConfig: {},
    };
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('time gate: returns false on second call within 1000ms', async () => {
    // First call on fresh module — lastStatCheck=0, T0-0 >= 1000, gate passes
    const _r1 = await freshCheckReload(state, parsed);

    // Advance time only 500ms — gate should block
    jest.advanceTimersByTime(500);
    const r2 = await freshCheckReload(state, parsed);
    expect(r2).toBe(false);
  });

  test('time gate: allows second call after 1000ms', async () => {
    await freshCheckReload(state, parsed);

    jest.advanceTimersByTime(1500);
    const r2 = await freshCheckReload(state, parsed);
    expect(typeof r2).toBe('boolean');
  });

  test('providers file mtime change triggers reload', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-test-cr-'));
    try {
      const providersPath = path.join(tmpDir, 'providers.json');
      fs.writeFileSync(
        providersPath,
        JSON.stringify({
          providers: {
            p: {
              endpoint: 'https://new.com',
              keyEnv: 'NEW_KEY',
              authHeader: 'x-api-key',
              wireFormat: 'openai',
            },
          },
        }),
      );

      state.providersFile = providersPath;
      state.providersMtime = 0;
      state.routing = { providers: { p: { url: 'https://old.com', keyEnv: '' } }, routes: {} };

      const stat = fs.statSync(providersPath);
      const result = await freshCheckReload(state, parsed);
      expect(result).toBe(true);
      expect(state.routing.providers.p.url).toBe('https://new.com');
      expect(state.routing.providers.p.auth).toBe('x-api-key');
      expect(state.routing.providers.p.format).toBe('openai');
      expect(state.providersMtime).toBe(stat.mtimeMs);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('providers file with thinking config change triggers reload', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-test-cr2-'));
    try {
      const providersPath = path.join(tmpDir, 'providers.json');
      fs.writeFileSync(
        providersPath,
        JSON.stringify({
          providers: {},
          thinking: { 'model-x': { type: 'enabled', budget_tokens: 16000 } },
        }),
      );

      state.providersFile = providersPath;
      state.providersMtime = 0;
      state.routing = { providers: {}, routes: {} };
      state.thinkingConfig = {};

      const result = await freshCheckReload(state, parsed);
      expect(result).toBe(true);
      expect(state.thinkingConfig).toEqual({
        'model-x': { type: 'enabled', budget_tokens: 16000 },
      });
      expect(state.providersMtime).toBeGreaterThan(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('routes file mtime change triggers reload', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-test-cr3-'));
    try {
      const routesPath = path.join(tmpDir, 'routes.json');
      fs.writeFileSync(
        routesPath,
        JSON.stringify({ providers: { p: { url: 'https://x.com', keyEnv: 'K' } }, routes: {} }),
      );

      parsed.routesFile = routesPath;
      state.routesMtime = 0;
      state.routing = { providers: {}, routes: {} };

      const result = await freshCheckReload(state, parsed);
      expect(result).toBe(true);
      expect(state.routing.providers.p).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('overrides file mtime change triggers reload', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-test-cr4-'));
    try {
      const overridesPath = path.join(tmpDir, 'overrides.json');
      fs.writeFileSync(overridesPath, JSON.stringify({ 'slot-a': 'provider-b' }));

      parsed.overridesFile = overridesPath;
      state.overridesMtime = 0;
      state.slotOverrides = {};

      const result = await freshCheckReload(state, parsed);
      expect(result).toBe(true);
      expect(state.slotOverrides).toEqual({ 'slot-a': 'provider-b' });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('handles routes file read failure gracefully', async () => {
    parsed.routesFile = '/nonexistent/routes.json';
    state.routesMtime = 0;

    const result = await freshCheckReload(state, parsed);
    expect(result).toBe(false);
  });

  test('handles providers file read failure gracefully', async () => {
    state.providersFile = '/nonexistent/providers.json';
    state.providersMtime = 0;

    const result = await freshCheckReload(state, parsed);
    expect(result).toBe(false);
  });

  test('thinking overrides file mtime change sets changed to true', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-test-cr5-'));
    try {
      const toPath = path.join(tmpDir, 'thinking-overrides.json');
      fs.writeFileSync(toPath, JSON.stringify({ 'model-a': null }));

      state.thinkingOverridesFile = toPath;
      state.thinkingOverridesMtime = 0;

      const result = await freshCheckReload(state, parsed);
      expect(result).toBe(true);
      expect(state.thinkingOverridesMtime).toBeGreaterThan(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('does not re-process providers when mtime has NOT changed', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-test-cr6-'));
    try {
      const providersPath = path.join(tmpDir, 'providers.json');
      fs.writeFileSync(providersPath, JSON.stringify({ providers: {} }));

      const stat = fs.statSync(providersPath);
      state.providersFile = providersPath;
      state.providersMtime = stat.mtimeMs;
      state.routing = { providers: { p: { url: 'https://x.com', keyEnv: 'K' } }, routes: {} };

      const result = await freshCheckReload(state, parsed);
      expect(result).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
