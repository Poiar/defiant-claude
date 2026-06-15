'use strict';

import fs from 'fs';
import path from 'path';

describe('providers.json', () => {
  let registry: Record<string, unknown>;

  beforeAll(() => {
    const raw = fs.readFileSync(path.join(__dirname, '..', 'providers.json'), 'utf-8');
    registry = JSON.parse(raw);
  });

  test('has providers object', () => {
    expect((registry as Record<string, unknown>).providers).toBeDefined();
    expect(typeof (registry as Record<string, unknown>).providers).toBe('object');
  });

  test('every provider has required fields', () => {
    const providers = (registry as Record<string, Record<string, unknown>>).providers;
    for (const [, def] of Object.entries(providers)) {
      expect(def.displayName).toBeDefined();
      expect(def.endpoint).toBeDefined();
      expect(def.keyEnv).toBeDefined();
      expect(def.authHeader).toBeDefined();
      expect(def.wireFormat).toBeDefined();
      expect(() => new URL(def.endpoint as string)).not.toThrow();
      expect(['bearer', 'x-api-key']).toContain(def.authHeader);
      expect(['anthropic', 'openai', 'gemini']).toContain(def.wireFormat);
    }
  });

  test('fallback providers exist in registry', () => {
    const providers = (registry as Record<string, Record<string, unknown>>).providers;
    for (const [, def] of Object.entries(providers)) {
      if (def.fallback) {
        for (const fb of def.fallback as string[]) {
          expect(providers[fb]).toBeDefined();
        }
      }
    }
  });

  test('context limits are positive integers', () => {
    const contextLimits = (registry as Record<string, Record<string, number>>).contextLimits;
    for (const [, limit] of Object.entries(contextLimits)) {
      expect(Number.isInteger(limit)).toBe(true);
      expect(limit).toBeGreaterThan(0);
    }
  });

  test('configs reference known providers', () => {
    const providerKeys = new Set(
      Object.keys((registry as Record<string, Record<string, unknown>>).providers),
    );
    const configs = (registry as Record<string, Record<string, Record<string, string>>>).configs;
    for (const [, cfg] of Object.entries(configs)) {
      for (const slot of ['opus', 'sonnet', 'haiku', 'sub'] as const) {
        const spec = cfg[slot];
        expect(spec).toBeDefined();
        const [providerKey] = spec.split(':');
        expect(providerKeys.has(providerKey)).toBe(true);
      }
    }
  });

  test('configs have names', () => {
    const configs = (registry as Record<string, Record<string, unknown>>).configs;
    for (const [, cfg] of Object.entries(configs)) {
      expect(cfg.name).toBeDefined();
      expect(typeof cfg.name).toBe('string');
    }
  });

  test('extraHeaders use valid HTTP header names', () => {
    const providers = (registry as Record<string, Record<string, unknown>>).providers;
    for (const [, def] of Object.entries(providers)) {
      if (def.extraHeaders) {
        for (const header of Object.keys(def.extraHeaders as Record<string, string>)) {
          expect(header).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
        }
      }
    }
  });

  test('every provider has streamUsageReporting field matching wireFormat', () => {
    const providers = (registry as Record<string, Record<string, unknown>>).providers;
    for (const [, def] of Object.entries(providers)) {
      expect(def.streamUsageReporting).toBeDefined();
      if (def.wireFormat === 'openai') {
        expect(def.streamUsageReporting).toBe('openai_stream_options');
      } else {
        expect(def.streamUsageReporting).toBeNull();
      }
    }
  });

  test('all expected providers present', () => {
    const expected = [
      'ds',
      'or',
      'fw',
      'oc',
      'an',
      'al',
      'km',
      'mm',
      'um',
      'gr',
      'mt',
      'mx',
      'za',
      'bp',
      'sf',
      'nv',
      'oa',
      'xa',
      'gm',
    ];
    const providers = (registry as Record<string, Record<string, unknown>>).providers;
    for (const key of expected) {
      expect(providers[key]).toBeDefined();
    }
  });
});
