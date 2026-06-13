'use strict';

import fs from 'fs';
import { runDryRun } from '../dry-run';

describe('runDryRun', () => {
  let consoleLogSpy: jest.SpyInstance;
  let mockReadFileSync: jest.SpyInstance;

  beforeEach(() => {
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    if (mockReadFileSync) mockReadFileSync.mockRestore();
  });

  /**
   * Set up fs.readFileSync to return the given route content.
   * When providersContent is non-null, the second readFileSync call (providers.json)
   * returns that; when null, the second call throws (simulating a missing file).
   */
  function setupMocks(routesContent: string, providersContent: string | null): void {
    mockReadFileSync = jest.spyOn(fs, 'readFileSync').mockImplementation((filePath: any) => {
      const p = filePath.toString();
      if (p.includes('providers.json')) {
        if (providersContent === null) throw new Error('ENOENT: no such file');
        return providersContent;
      }
      return routesContent;
    });
  }

  // ----------------------------
  // Slot parsing
  // ----------------------------

  test('valid slot with known provider prints all columns correctly', () => {
    setupMocks(
      JSON.stringify({
        slots: { sonnet: 'chat:deepseek:deepseek-chat' },
        providers: { deepseek: { url: 'https://api.deepseek.com', keyEnv: 'DEEPSEEK_KEY' } },
      }),
      JSON.stringify({ providers: { deepseek: { displayName: 'DeepSeek' } } }),
    );

    // Ensure keyEnv is not set so KEY shows MISSING
    const origKey = process.env.DEEPSEEK_KEY;
    delete process.env.DEEPSEEK_KEY;

    runDryRun('/fake/routes.json');

    if (origKey) process.env.DEEPSEEK_KEY = origKey;

    const lines: string[] = consoleLogSpy.mock.calls.map((c: string[]) => c[0]);

    // Structure: '' , header, separator, data row(s), ''
    expect(lines[0]).toBe('');
    expect(lines[1]).toContain('SLOT');
    expect(lines[1]).toContain('PROVIDER');
    expect(lines[1]).toContain('MODEL');
    expect(lines[1]).toContain('FORMAT');
    expect(lines[1]).toContain('KEY');
    expect(lines[1]).toContain('FALLBACK');

    // Data row
    const row = lines[3];
    expect(row).toContain('sonnet');
    expect(row).toContain('deepseek (DeepSeek)');
    expect(row).toContain('deepseek-chat');
    expect(row).toContain('anthropic');
    expect(row).toContain('MISSING');
    expect(row).toContain('-');

    // Final blank line
    expect(lines[lines.length - 1]).toBe('');
  });

  test('slot with invalid format shows question marks and raw value', () => {
    setupMocks(
      JSON.stringify({
        slots: { main: 'broken-slot-value' },
        providers: {},
      }),
      null,
    );

    runDryRun('/fake/routes.json');

    const lines: string[] = consoleLogSpy.mock.calls.map((c: string[]) => c[0]);

    const row = lines[3];
    expect(row).toContain('main');
    expect(row).toContain('?');
    expect(row).toContain('broken-slot-value');
  });

  test('slot with unknown provider shows (unknown) marker', () => {
    setupMocks(
      JSON.stringify({
        slots: { code: 'chat:nonexistent:some-model' },
        providers: {},
      }),
      null,
    );

    runDryRun('/fake/routes.json');

    const lines: string[] = consoleLogSpy.mock.calls.map((c: string[]) => c[0]);

    const row = lines[3];
    expect(row).toContain('nonexistent (unknown)');
    expect(row).toContain('?');
  });

  test('slot with missing keyEnv shows MISSING', () => {
    setupMocks(
      JSON.stringify({
        slots: { chat: 'chat:testprov:test-model' },
        providers: { testprov: { url: 'https://example.com', keyEnv: 'TEST_API_KEY' } },
      }),
      null,
    );

    const origKey = process.env.TEST_API_KEY;
    delete process.env.TEST_API_KEY;

    runDryRun('/fake/routes.json');

    if (origKey) process.env.TEST_API_KEY = origKey;

    const lines: string[] = consoleLogSpy.mock.calls.map((c: string[]) => c[0]);
    expect(lines[3]).toContain('MISSING');
  });

  test('slot with SET keyEnv shows SET', () => {
    setupMocks(
      JSON.stringify({
        slots: { chat: 'chat:testprov:test-model' },
        providers: { testprov: { url: 'https://example.com', keyEnv: 'TEST_API_KEY' } },
      }),
      null,
    );

    const origKey = process.env.TEST_API_KEY;
    process.env.TEST_API_KEY = 'sk-real-key';

    runDryRun('/fake/routes.json');

    if (origKey) process.env.TEST_API_KEY = origKey;
    else delete process.env.TEST_API_KEY;

    const lines: string[] = consoleLogSpy.mock.calls.map((c: string[]) => c[0]);
    expect(lines[3]).toContain('SET');
  });

  test('provider without fallback shows dash', () => {
    setupMocks(
      JSON.stringify({
        slots: { chat: 'chat:testprov:test-model' },
        providers: { testprov: { url: 'https://example.com' } },
      }),
      null,
    );

    runDryRun('/fake/routes.json');

    const lines: string[] = consoleLogSpy.mock.calls.map((c: string[]) => c[0]);
    expect(lines[3]).toContain('-');
  });

  test('provider with fallback array shows comma-joined names', () => {
    setupMocks(
      JSON.stringify({
        slots: { chat: 'chat:primary:test-model' },
        providers: {
          primary: { url: 'https://example.com', fallback: ['backup1', 'backup2'] },
        },
      }),
      null,
    );

    runDryRun('/fake/routes.json');

    const lines: string[] = consoleLogSpy.mock.calls.map((c: string[]) => c[0]);
    expect(lines[3]).toContain('backup1, backup2');
  });

  test('slot with format=openai shows openai in FORMAT column', () => {
    setupMocks(
      JSON.stringify({
        slots: { chat: 'chat:testprov:gpt-4' },
        providers: { testprov: { url: 'https://example.com', format: 'openai' } },
      }),
      null,
    );

    runDryRun('/fake/routes.json');

    const lines: string[] = consoleLogSpy.mock.calls.map((c: string[]) => c[0]);
    expect(lines[3]).toContain('openai');
  });

  test('slot with no format defaults to anthropic', () => {
    setupMocks(
      JSON.stringify({
        slots: { chat: 'chat:testprov:claude-3' },
        providers: { testprov: { url: 'https://example.com' } },
      }),
      null,
    );

    runDryRun('/fake/routes.json');

    const lines: string[] = consoleLogSpy.mock.calls.map((c: string[]) => c[0]);
    expect(lines[3]).toContain('anthropic');
  });

  test('multiple slots prints all rows', () => {
    setupMocks(
      JSON.stringify({
        slots: {
          sonnet: 'chat:prov1:sonnet-model',
          haiku: 'chat:prov2:haiku-model',
          opus: 'chat:prov1:opus-model',
        },
        providers: {
          prov1: { url: 'https://example.com/1', format: 'anthropic' },
          prov2: { url: 'https://example.com/2', format: 'openai' },
        },
      }),
      null,
    );

    runDryRun('/fake/routes.json');

    const lines: string[] = consoleLogSpy.mock.calls.map((c: string[]) => c[0]);

    // Header + separator + 3 data rows + blank lines = 6
    // lines[0] = '', lines[1] = header, lines[2] = separator,
    // lines[3] = first row, lines[4] = second, lines[5] = third,
    // lines[6] = '' (final)
    expect(lines[3]).toContain('sonnet');
    expect(lines[4]).toContain('haiku');
    expect(lines[5]).toContain('opus');
  });

  test('empty slots object prints only headers and no data rows', () => {
    setupMocks(
      JSON.stringify({
        slots: {},
        providers: {},
      }),
      null,
    );

    runDryRun('/fake/routes.json');

    const lines: string[] = consoleLogSpy.mock.calls.map((c: string[]) => c[0]);

    // lines[0] = '', lines[1] = header, lines[2] = separator, lines[3] = '' (final)
    expect(lines[0]).toBe('');
    expect(lines[1]).toContain('SLOT');
    expect(lines[2]).toContain('---');
    expect(lines[3]).toBe('');
    expect(lines.length).toBe(4);
  });

  // ----------------------------
  // Context limits
  // ----------------------------

  test('context limits present prints formatted limits section', () => {
    setupMocks(
      JSON.stringify({
        slots: { chat: 'chat:testprov:test-model' },
        providers: { testprov: { url: 'https://example.com' } },
        contextLimits: {
          'anthropic/claude-sonnet-4-20250514': 200000,
          'openai/gpt-4o': 128000,
        },
      }),
      null,
    );

    runDryRun('/fake/routes.json');

    const lines: string[] = consoleLogSpy.mock.calls.map((c: string[]) => c[0]);

    // Find the context limits section
    const limitsIdx = lines.findIndex((l: string) => l === 'Context limits:');
    expect(limitsIdx).toBeGreaterThan(0);

    // Limits should be formatted with short names and token counts
    const limitLines = lines.slice(limitsIdx + 1);
    expect(limitLines[0]).toContain('claude-sonnet-4-20250514');
    expect(limitLines[0]).toContain('200K tokens');
    expect(limitLines[1]).toContain('gpt-4o');
    expect(limitLines[1]).toContain('128K tokens');
  });

  test('context limits with duplicate short names deduplicates', () => {
    setupMocks(
      JSON.stringify({
        slots: {},
        providers: {},
        contextLimits: {
          'anthropic/claude-sonnet-4-20250514': 200000,
          'openrouter/claude-sonnet-4-20250514': 200000,
          'anthropic/claude-opus-4-20250514': 1000000,
        },
      }),
      null,
    );

    runDryRun('/fake/routes.json');

    const lines: string[] = consoleLogSpy.mock.calls.map((c: string[]) => c[0]);

    const limitsIdx = lines.findIndex((l: string) => l === 'Context limits:');
    expect(limitsIdx).toBeGreaterThan(0);

    const limitLines = lines.slice(limitsIdx + 1).filter((l: string) => l.startsWith('  '));
    // Should see 2 unique short names, not 3
    const shortNames = limitLines.map((l: string) => l.split(':')[0].trim());
    expect(shortNames).toContain('claude-sonnet-4-20250514');
    expect(shortNames).toContain('claude-opus-4-20250514');
    // The duplicate sonnet short name should appear only once
    expect(shortNames.filter((n: string) => n === 'claude-sonnet-4-20250514').length).toBe(1);
  });

  test('context limits absent from config prints no limits section', () => {
    setupMocks(
      JSON.stringify({
        slots: {},
        providers: {},
      }),
      null,
    );

    runDryRun('/fake/routes.json');

    const lines: string[] = consoleLogSpy.mock.calls.map((c: string[]) => c[0]);

    const limitsIdx = lines.findIndex((l: string) => l === 'Context limits:');
    expect(limitsIdx).toBe(-1);
  });

  test('empty context limits object prints no limits section', () => {
    setupMocks(
      JSON.stringify({
        slots: {},
        providers: {},
        contextLimits: {},
      }),
      null,
    );

    runDryRun('/fake/routes.json');

    const lines: string[] = consoleLogSpy.mock.calls.map((c: string[]) => c[0]);

    const limitsIdx = lines.findIndex((l: string) => l === 'Context limits:');
    expect(limitsIdx).toBe(-1);
  });

  // ----------------------------
  // fmtLimit (via context limits)
  // ----------------------------

  test('fmtLimit: >=1M shows M tokens format', () => {
    setupMocks(
      JSON.stringify({
        slots: {},
        providers: {},
        contextLimits: { 'model/huge': 1000000 },
      }),
      null,
    );

    runDryRun('/fake/routes.json');

    const lines: string[] = consoleLogSpy.mock.calls.map((c: string[]) => c[0]);
    const limitLine = lines.find((l: string) => l.includes('huge'));
    expect(limitLine).toContain('1M tokens');
  });

  test('fmtLimit: >=1000 shows K tokens format', () => {
    setupMocks(
      JSON.stringify({
        slots: {},
        providers: {},
        contextLimits: { 'model/medium': 128000 },
      }),
      null,
    );

    runDryRun('/fake/routes.json');

    const lines: string[] = consoleLogSpy.mock.calls.map((c: string[]) => c[0]);
    const limitLine = lines.find((l: string) => l.includes('medium'));
    expect(limitLine).toContain('128K tokens');
  });

  test('fmtLimit: <1000 shows raw tokens format', () => {
    setupMocks(
      JSON.stringify({
        slots: {},
        providers: {},
        contextLimits: { 'model/small': 999 },
      }),
      null,
    );

    runDryRun('/fake/routes.json');

    const lines: string[] = consoleLogSpy.mock.calls.map((c: string[]) => c[0]);
    const limitLine = lines.find((l: string) => l.includes('small'));
    expect(limitLine).toContain('999 tokens');
  });

  test('fmtLimit: zero shows 0 tokens', () => {
    setupMocks(
      JSON.stringify({
        slots: {},
        providers: {},
        contextLimits: { 'model/zero': 0 },
      }),
      null,
    );

    runDryRun('/fake/routes.json');

    const lines: string[] = consoleLogSpy.mock.calls.map((c: string[]) => c[0]);
    const limitLine = lines.find((l: string) => l.includes('zero'));
    expect(limitLine).toContain('0 tokens');
  });

  // ----------------------------
  // providers.json handling
  // ----------------------------

  test('providers.json read failure falls back to providerKey as display name', () => {
    setupMocks(
      JSON.stringify({
        slots: { chat: 'chat:testprov:test-model' },
        providers: { testprov: { url: 'https://example.com' } },
      }),
      null, // providersContent = null => throw
    );

    runDryRun('/fake/routes.json');

    const lines: string[] = consoleLogSpy.mock.calls.map((c: string[]) => c[0]);

    // Without display name, the providerKey is used as the display name
    // So we expect "testprov (testprov)" - the key plus fallback to self
    const row = lines[3];
    expect(row).toContain('testprov (testprov)');
  });

  test('providers.json with displayName shows name in parentheses', () => {
    setupMocks(
      JSON.stringify({
        slots: { chat: 'chat:testprov:test-model' },
        providers: { testprov: { url: 'https://example.com' } },
      }),
      JSON.stringify({ providers: { testprov: { displayName: 'Test Provider Co' } } }),
    );

    runDryRun('/fake/routes.json');

    const lines: string[] = consoleLogSpy.mock.calls.map((c: string[]) => c[0]);

    const row = lines[3];
    expect(row).toContain('testprov (Test Provider Co)');
  });

  test('providers.json entry without displayName falls back to provider key', () => {
    setupMocks(
      JSON.stringify({
        slots: { chat: 'chat:testprov:test-model' },
        providers: { testprov: { url: 'https://example.com' } },
      }),
      JSON.stringify({ providers: { testprov: {} } }),
    );

    runDryRun('/fake/routes.json');

    const lines: string[] = consoleLogSpy.mock.calls.map((c: string[]) => c[0]);

    const row = lines[3];
    expect(row).toContain('testprov (testprov)');
  });

  test('providers.json with no providers property is handled gracefully', () => {
    setupMocks(
      JSON.stringify({
        slots: { chat: 'chat:testprov:test-model' },
        providers: { testprov: { url: 'https://example.com', keyEnv: 'TEST_KEY' } },
      }),
      JSON.stringify({ something: 'else' }), // no .providers property
    );

    runDryRun('/fake/routes.json');

    const lines: string[] = consoleLogSpy.mock.calls.map((c: string[]) => c[0]);

    // No displayName found, so falls back to provider key
    const row = lines[3];
    expect(row).toContain('testprov (testprov)');
  });

  // ----------------------------
  // N/A keyStatus
  // ----------------------------

  test('provider without keyEnv shows N/A in KEY column', () => {
    setupMocks(
      JSON.stringify({
        slots: { chat: 'chat:testprov:test-model' },
        providers: { testprov: { url: 'https://example.com' } },
      }),
      null,
    );

    runDryRun('/fake/routes.json');

    const lines: string[] = consoleLogSpy.mock.calls.map((c: string[]) => c[0]);
    expect(lines[3]).toContain('N/A');
  });

  // ----------------------------
  // Column padding (padEnd via output)
  // ----------------------------

  test('column padding ensures equal row lengths', () => {
    setupMocks(
      JSON.stringify({
        slots: {
          main: 'chat:prov:sonnet',
          chat: 'chat:prov:haiku',
        },
        providers: { prov: { url: 'https://example.com', format: 'openai' } },
      }),
      null,
    );

    runDryRun('/fake/routes.json');

    const lines: string[] = consoleLogSpy.mock.calls.map((c: string[]) => c[0]);

    // Data rows should have consistent column positions (same length)
    const dataRows = lines.filter((l: string) => l.includes('main') || l.includes('chat'));
    expect(dataRows.length).toBe(2);
    expect(dataRows[0].length).toBe(dataRows[1].length);
  });
});
