'use strict';

/**
 * Tests for the Admin API (proxy/admin.ts).
 */

import http from 'http';
import { EventEmitter } from 'events';

// Mock stats.setDailyBudget
const mockSetDailyBudget = jest.fn();
jest.mock('../stats', () => ({
  ...jest.requireActual('../stats'),
  setDailyBudget: (...args: any[]) => mockSetDailyBudget(...args),
}));

// Mock fs
const mockReadFileSync = jest.fn();
const mockWriteFileSync = jest.fn();
const mockExistsSync = jest.fn();

jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    readFileSync: (...args: any[]) => {
      const path = String(args[0] || '');
      if (
        path.includes('providers.json') ||
        path.includes('overrides.json') ||
        path.includes('requests.log') ||
        path.includes('routes.json')
      ) {
        return mockReadFileSync(...args);
      }
      return actual.readFileSync(...args);
    },
    writeFileSync: (...args: any[]) => mockWriteFileSync(...args),
    existsSync: (...args: any[]) => mockExistsSync(...args),
  };
});

import { handleAdminRequest, getAdminKey } from '../admin';

// Helpers
function makeMockReq(
  method: string,
  url: string,
  body?: string,
): http.IncomingMessage & { _body?: string } {
  const ee = new EventEmitter();
  const req = Object.assign(ee, {
    method,
    url,
    headers: {} as Record<string, string>,
    _body: body,
    socket: { remoteAddress: '127.0.0.1', destroy: () => {} },
    destroy: () => {},
  }) as unknown as http.IncomingMessage & { _body?: string };
  return req;
}

function makeMockRes(): http.ServerResponse & { status: number; data: string } {
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200,
    _headers: {} as Record<string, string>,
    status: 200,
    data: '',
    writeHead: function (this: any, status: number, headers?: Record<string, string>) {
      this.status = status;
      if (headers) this._headers = { ...this._headers, ...headers };
      return this;
    },
    end: function (this: any, data?: string) {
      this.data = data || '';
      // Don't emit - we'll read .data directly
    },
    write: function () {
      return true;
    },
    destroyed: false,
    destroy: () => {},
  }) as unknown as http.ServerResponse & { status: number; data: string };
  return res;
}

const DEFAULT_DEPS = {
  overridesFile: '/tmp/.defiant/slot-overrides.json',
  thinkingOverridesFile: '/tmp/.defiant/thinking-overrides.json',
  providersFile: '/tmp/.defiant/providers.json',
  routing: null,
  slotOverrides: {},
  concurrencyStatus: {},
  rateLimiterStatus: {},
  port: 8080,
  providerDisplayNames: {},
};

describe('handleAdminRequest', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation((path: string) => {
      if (path.includes('providers.json')) {
        return JSON.stringify({
          providers: {
            ds: {
              displayName: 'DeepSeek',
              endpoint: 'https://api.deepseek.com',
              wireFormat: 'anthropic',
            },
            an: {
              displayName: 'Anthropic',
              endpoint: 'https://api.anthropic.com',
              wireFormat: 'anthropic',
            },
          },
          configs: {
            ds: {
              name: 'DeepSeek Default',
              opus: 'ds:deepseek-v4-pro',
              sonnet: 'ds:deepseek-v4-pro',
              haiku: 'ds:deepseek-v4-flash',
              sub: 'ds:deepseek-v4-flash',
              fable: 'ds:deepseek-v4-pro',
            },
            an: {
              name: 'Anthropic Direct',
              opus: 'an:claude-sonnet-4-6',
              sonnet: 'an:claude-sonnet-4-6',
              haiku: 'an:claude-haiku',
              sub: 'an:claude-haiku',
              fable: 'an:claude-sonnet-4-6',
            },
          },
          thinking: { 'deepseek-v4-pro': { type: 'enabled', budget_tokens: 32000 } },
        });
      }
      if (path.includes('slot-overrides.json')) return '{}';
      if (path.includes('thinking-overrides.json')) return '{}';
      if (path.includes('requests.log')) return 'line1\nline2\nline3\n';
      return '{}';
    });
  });

  test('returns false for non-admin routes', () => {
    const req = makeMockReq('GET', '/health');
    const res = makeMockRes();
    expect(handleAdminRequest(req, res, DEFAULT_DEPS)).toBe(false);
  });

  test('serves admin HTML page on GET /admin', () => {
    const req = makeMockReq('GET', '/admin');
    const res = makeMockRes();
    expect(handleAdminRequest(req, res, DEFAULT_DEPS)).toBe(true);
    expect(res.data).toContain('Defiant Claude Admin');
    expect(res.data).toContain('Slot Overrides');
    expect(res.data).toContain('Daily Budget');
  });

  test('POST /admin/api/set-slot writes to overrides file', (done) => {
    const req = makeMockReq(
      'POST',
      '/admin/api/set-slot',
      JSON.stringify({ slot: 'opus', spec: 'ds:deepseek-v4-pro' }),
    );
    req.headers['x-dashboard-key'] = getAdminKey();
    const res = makeMockRes();

    const result = handleAdminRequest(req, res, DEFAULT_DEPS);
    expect(result).toBe(true);

    // Emit body data
    setImmediate(() => {
      req.emit('data', Buffer.from(req._body!));
      req.emit('end');
    });

    setImmediate(() => {
      expect(mockWriteFileSync).toHaveBeenCalled();
      const parsed = JSON.parse(res.data);
      expect(parsed.ok).toBe(true);
      done();
    });
  });

  test('POST /admin/api/reset-slot clears override', (done) => {
    const req = makeMockReq('POST', '/admin/api/reset-slot', JSON.stringify({ slot: 'haiku' }));
    req.headers['x-dashboard-key'] = getAdminKey();
    const res = makeMockRes();

    handleAdminRequest(req, res, {
      ...DEFAULT_DEPS,
      slotOverrides: { haiku: 'ds:deepseek-v4-flash' },
    });

    setImmediate(() => {
      req.emit('data', Buffer.from(req._body!));
      req.emit('end');
    });

    setImmediate(() => {
      const parsed = JSON.parse(res.data);
      expect(parsed.ok).toBe(true);
      done();
    });
  });

  test('POST /admin/api/set-budget calls setDailyBudget', (done) => {
    const req = makeMockReq('POST', '/admin/api/set-budget', JSON.stringify({ budget: 5.0 }));
    req.headers['x-dashboard-key'] = getAdminKey();
    const res = makeMockRes();

    handleAdminRequest(req, res, DEFAULT_DEPS);

    setImmediate(() => {
      req.emit('data', Buffer.from(req._body!));
      req.emit('end');
    });

    setImmediate(() => {
      const parsed = JSON.parse(res.data);
      expect(parsed.ok).toBe(true);
      expect(mockSetDailyBudget).toHaveBeenCalledWith(5.0);
      done();
    });
  });

  test('POST /admin/api/set-thinking writes thinking overrides', (done) => {
    const req = makeMockReq(
      'POST',
      '/admin/api/set-thinking',
      JSON.stringify({ model: 'deepseek-v4-pro', type: 'enabled', budget_tokens: 16000 }),
    );
    req.headers['x-dashboard-key'] = getAdminKey();
    const res = makeMockRes();

    handleAdminRequest(req, res, DEFAULT_DEPS);

    setImmediate(() => {
      req.emit('data', Buffer.from(req._body!));
      req.emit('end');
    });

    setImmediate(() => {
      const parsed = JSON.parse(res.data);
      expect(parsed.ok).toBe(true);
      expect(parsed.message).toContain('deepseek-v4-pro');
      expect(mockWriteFileSync).toHaveBeenCalled();
      done();
    });
  });

  test('GET /admin/api/logs returns log entries', () => {
    const req = makeMockReq('GET', '/admin/api/logs?lines=10');
    req.headers['x-dashboard-key'] = getAdminKey();
    const res = makeMockRes();

    handleAdminRequest(req, res, DEFAULT_DEPS);
    const parsed = JSON.parse(res.data);
    expect(parsed.ok).toBe(true);
    expect(parsed.entries).toEqual(['line1', 'line2', 'line3']);
  });

  test('GET /admin/api/config returns current config', () => {
    const req = makeMockReq('GET', '/admin/api/config');
    req.headers['x-dashboard-key'] = getAdminKey();
    const res = makeMockRes();

    handleAdminRequest(req, res, {
      ...DEFAULT_DEPS,
      slotOverrides: { opus: 'ds:deepseek-v4-pro' },
    });
    const parsed = JSON.parse(res.data);
    expect(parsed.slotOverrides.opus).toBe('ds:deepseek-v4-pro');
    expect(parsed.availableConfigs).toBeDefined();
    expect(parsed.availableProviders).toBeDefined();
    expect(parsed.availableProviders.length).toBe(2);
  });

  test('rejects POST without auth key', () => {
    const req = makeMockReq('POST', '/admin/api/set-slot', '{}');
    const res = makeMockRes();
    handleAdminRequest(req, res, DEFAULT_DEPS);
    const parsed = JSON.parse(res.data);
    expect(parsed.error).toBe('Unauthorized');
  });
});
