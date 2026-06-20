'use strict';

import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn, ChildProcess, execSync } from 'child_process';

const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const IS_WIN = process.platform === 'win32';

// Shell-safe spawn: avoid DEP0190 on Windows (args + shell:true)
// Build a single command string for cmd /c — don't double-quote
// each arg individually as that breaks cmd.exe's argument parsing.
const shellSafe = (cmd: string, args: string[]): [string, string[]] =>
  IS_WIN ? [`${cmd} ${args.join(' ')}`, []] : [cmd, args];

let proxyProcess: ChildProcess;
let proxyPort: number;
let routesFile: string;
let overridesFile: string;

function request(
  method: string,
  urlPath: string,
  opts: { headers?: Record<string, string>; body?: string } = {},
): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}> {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: '127.0.0.1',
      port: proxyPort,
      path: urlPath,
      method,
      headers: opts.headers || {},
      timeout: 5000,
      agent: false,
    };
    const req = http.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c as Buffer));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        try {
          resolve({ status: res.statusCode || 0, headers: res.headers, body: JSON.parse(body) });
        } catch (_) {
          resolve({ status: res.statusCode || 0, headers: res.headers, body });
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

beforeAll(async () => {
  routesFile = path.join(os.tmpdir(), 'dc-int-test-routes-' + process.pid + '.json');
  overridesFile = path.join(os.tmpdir(), 'dc-int-test-overrides-' + process.pid + '.json');

  fs.writeFileSync(
    routesFile,
    JSON.stringify({
      routes: {},
      providers: {},
      defaultProvider: null,
    }),
  );
  fs.writeFileSync(overridesFile, JSON.stringify({}));

  proxyProcess = spawn(
    ...shellSafe(npxCmd, [
      'tsx',
      'proxy/start-proxy.ts',
      '--routes',
      routesFile,
      '--overrides',
      overridesFile,
    ]),
    {
      cwd: path.resolve(__dirname, '../..'),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        DEFIANT_NO_PID_LOCK: '1',
        DEFIANT_SEARCH_ENGINES: 'ddg',
        DEFIANT_SEARCH_NO_NETWORK: '1',
        DEFIANT_SKIP_STARTUP_CHECK: 'true',
      },
      ...(IS_WIN ? { shell: true } : {}),
    },
  );

  const portStr = await new Promise<string>((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error('Proxy did not start within 15s')), 15000);
    proxyProcess.stdout!.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      const m = out.match(/PORT:(\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    proxyProcess.stderr!.on('data', () => {});
  });
  proxyPort = parseInt(portStr, 10);
}, 20000);

afterAll(async () => {
  if (proxyProcess) {
    // Kill the full process tree on Windows — spawn with shell:true
    // creates cmd.exe which doesn't forward signals to node children.
    if (process.platform === 'win32' && proxyProcess.pid) {
      try {
        execSync(`taskkill /T /F /PID ${proxyProcess.pid}`, {
          windowsHide: true,
          timeout: 5000,
          stdio: 'ignore',
        });
      } catch (_) {
        /* taskkill may exit 1 if processes have already died */
      }
    } else {
      proxyProcess.kill('SIGKILL');
    }
    proxyProcess.stdout?.destroy();
    proxyProcess.stderr?.destroy();
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 2000);
      proxyProcess.on('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  try {
    fs.unlinkSync(routesFile);
  } catch (_) {}
  try {
    fs.unlinkSync(overridesFile);
  } catch (_) {}
});

describe('Proxy integration tests', () => {
  test('GET /health returns 200 with correct structure', async () => {
    const res = await request('GET', '/health');

    expect(res.status).toBe(200);
    expect((res.body as Record<string, unknown>).status).toBe('ok');
    expect(typeof (res.body as Record<string, unknown>).version).toBe('string');
    expect(typeof (res.body as Record<string, unknown>).uptime).toBe('number');

    expect((res.body as Record<string, unknown>).concurrency).toBeDefined();
    const concurrency = (res.body as Record<string, unknown>).concurrency as Record<
      string,
      unknown
    >;
    // Per-slot pools: subagent + default
    for (const pool of ['subagent', 'default']) {
      const p = concurrency[pool] as Record<string, unknown>;
      expect(p).toBeDefined();
      expect(typeof p.active).toBe('number');
      expect(typeof p.waiting).toBe('number');
      expect(typeof p.limit).toBe('number');
      expect(typeof p.utilization).toBe('number');
    }

    expect((res.body as Record<string, unknown>).rateLimiter).toBeDefined();
    const rateLimiter = (res.body as Record<string, unknown>).rateLimiter as Record<
      string,
      unknown
    >;
    expect(typeof rateLimiter.tracked).toBe('number');
    expect(typeof rateLimiter.maxEntries).toBe('number');
    expect(typeof rateLimiter.maxPerWindow).toBe('number');
    expect(typeof rateLimiter.windowMs).toBe('number');

    expect((res.body as Record<string, unknown>).providers).toBeDefined();
    expect(typeof (res.body as Record<string, unknown>).providers).toBe('object');
  });

  test('POST /v1/messages with text/plain Content-Type returns 415', async () => {
    const res = await request('POST', '/v1/messages', {
      headers: { 'Content-Type': 'text/plain' },
      body: 'hello',
    });

    expect(res.status).toBe(415);
    expect((res.body as Record<string, unknown>).type).toBe('api_error');
    expect((res.body as Record<string, unknown>).message).toContain('Content-Type');
  });

  test('POST /v1/messages with body > 10MB returns 413', async () => {
    const padding = 'x'.repeat(10_500_000);
    const body = JSON.stringify({ model: 'test', padding });
    const contentLength = Buffer.byteLength(body);

    let res;
    try {
      res = await request('POST', '/v1/messages', {
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(contentLength),
        },
        body,
      });
    } catch (err) {
      expect(err).toBeDefined();
      return;
    }

    expect([413, 400]).toContain(res.status);
    if (res.status === 413) {
      expect((res.body as Record<string, unknown>).type).toBe('api_error');
      expect(typeof (res.body as Record<string, unknown>).message).toBe('string');
    }
  });

  test('POST /v1/messages with valid JSON but no model returns 400', async () => {
    const res = await request('POST', '/v1/messages', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const body = res.body as Record<string, unknown>;
    expect(body.type).toBe('error');
    const err = body.error as Record<string, unknown>;
    expect(err.type).toBe('invalid_request_error');
    expect(err.message).toContain('model');
  });

  test('GET /health uptime increases between calls', async () => {
    const res1 = await request('GET', '/health');
    await new Promise((r) => setTimeout(r, 1000));
    const res2 = await request('GET', '/health');

    expect(typeof (res1.body as Record<string, unknown>).uptime).toBe('number');
    expect(typeof (res2.body as Record<string, unknown>).uptime).toBe('number');
    expect((res2.body as Record<string, unknown>).uptime as number).toBeGreaterThanOrEqual(
      ((res1.body as Record<string, unknown>).uptime as number) + 900,
    );
  });

  test('POST to unknown path proxies to Anthropic and returns error', async () => {
    const res = await request('POST', '/v1/something-else', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBeGreaterThanOrEqual(400);

    if (res.status === 502 && typeof res.body === 'object') {
      expect((res.body as Record<string, unknown>).type).toBe('api_error');
    }
  });

  test('health endpoint works (multiple concurrent connections allowed)', async () => {
    // Health/dashboard/metrics endpoints are exempt from session tracking
    // enforcement so statusline and probes don't get blocked. Both
    // concurrent requests over separate connections should succeed.
    const results = await Promise.all([request('GET', '/health'), request('GET', '/health')]);

    expect(results[0].status).toBe(200);
    expect((results[0].body as Record<string, unknown>).status).toBe('ok');
    expect(results[1].status).toBe(200);
    expect((results[1].body as Record<string, unknown>).status).toBe('ok');
  });

  test('concurrent health connections are all allowed (session-based, not TCP-level)', async () => {
    // Three concurrent health requests should all succeed. Session-based
    // enforcement only blocks model calls, not health endpoints.
    const results = await Promise.all([
      request('GET', '/health'),
      request('GET', '/health'),
      request('GET', '/health'),
    ]);
    for (const r of results) {
      expect(r.status).toBe(200);
    }
  });

  test('session tracking: main + sub-sessions both allowed', async () => {
    // First model call with key-A becomes the main session.
    const res1 = await request('POST', '/v1/messages', {
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'session-alpha' },
      body: JSON.stringify({ model: 'test', max_tokens: 1, messages: [] }),
    });
    // First call binds the main session (may 502 if no upstream, but not 409)
    expect(res1.status).not.toBe(409);

    // Second call with same key-A → allowed (main session)
    const res2 = await request('POST', '/v1/messages', {
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'session-alpha' },
      body: JSON.stringify({ model: 'test', max_tokens: 1, messages: [] }),
    });
    expect(res2.status).not.toBe(409);

    // Third call with key-B → allowed as sub-session (subagent/team/explore)
    const res3 = await request('POST', '/v1/messages', {
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'session-beta' },
      body: JSON.stringify({ model: 'test', max_tokens: 1, messages: [] }),
    });
    expect(res3.status).not.toBe(409);

    // Health endpoint always exempt
    const healthRes = await request('GET', '/health');
    expect(healthRes.status).toBe(200);
  });

  test('POST /v1/messages without Content-Type header is rejected with 415', async () => {
    const res = await request('POST', '/v1/messages', {
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(415);
    expect((res.body as Record<string, unknown>).type).toBe('api_error');
  });
});

// =========================================================================
// Protocol routing integration: mock upstream → proxy → verify
// =========================================================================

// types used in skipped Protocol routing integration tests
// import type { AnthropicRequestBody, AnthropicSSEEvent } from '../protocol-types';

interface StreamResult {
  status: number;
  events: Array<{ type: string; payload: unknown }>;
  raw: string;
}

/** Read SSE stream from a response, extracting event: and data: lines. */
function readStream(res: http.IncomingMessage): Promise<StreamResult> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      const events: Array<{ type: string; payload: unknown }> = [];
      const lines = raw.split('\n');
      let currentEvent = '';
      let currentData = '';
      for (const line of lines) {
        if (line.startsWith('event: ')) {
          currentEvent = line.slice(7).trim();
        } else if (line.startsWith('data: ')) {
          currentData = line.slice(6);
          try {
            events.push({ type: currentEvent, payload: JSON.parse(currentData) });
          } catch {
            events.push({ type: currentEvent, payload: currentData });
          }
          currentEvent = '';
          currentData = '';
        }
      }
      resolve({ status: res.statusCode || 0, events, raw });
    });
    res.on('error', reject);
  });
}

/** Create a mock upstream server that echoes requests for inspection. */
function createMockUpstream(): Promise<{
  port: number;
  requests: Array<{ headers: Record<string, string>; body: unknown }>;
  setHandler: (h: (req: http.IncomingMessage, res: http.ServerResponse) => void) => void;
}> {
  const requests: Array<{ headers: Record<string, string>; body: unknown }> = [];
  let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void = (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        type: 'message',
        role: 'assistant',
        model: 'mock-model',
        content: [{ type: 'text', text: 'Mock response' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    );
  };

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        requests.push({
          headers: req.headers as Record<string, string>,
          body: body ? JSON.parse(body) : null,
        });
        handler(req, res);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        port,
        requests,
        setHandler: (h) => {
          handler = h;
        },
      });
    });
    server.on('error', reject);
  });
}

describe.skip('Protocol routing integration', () => {
  let mockPort: number;
  let mockRequests: Array<{ headers: Record<string, string>; body: unknown }>;
  let setMockHandler: (h: (req: http.IncomingMessage, res: http.ServerResponse) => void) => void;
  let protoRoutesFile: string;
  let protoOverridesFile: string;
  let protoProvidersFile: string;
  let protoProxyProcess: ChildProcess;
  let protoProxyPort: number;

  beforeAll(async () => {
    // Start mock upstream
    const mock = await createMockUpstream();
    mockPort = mock.port;
    mockRequests = mock.requests;
    setMockHandler = mock.setHandler;

    // Write route config pointing to mock
    protoRoutesFile = path.join(os.tmpdir(), 'dc-proto-routes-' + process.pid + '.json');
    protoOverridesFile = path.join(os.tmpdir(), 'dc-proto-overrides-' + process.pid + '.json');
    protoProvidersFile = path.join(os.tmpdir(), 'dc-proto-providers-' + process.pid + '.json');

    const upstreamUrl = `http://127.0.0.1:${mockPort}`;

    // Write providers.json for the test
    fs.writeFileSync(
      protoProvidersFile,
      JSON.stringify({
        providers: {
          ds: {
            displayName: 'Test DS',
            endpoint: upstreamUrl,
            keyEnv: 'TEST_KEY',
            authHeader: 'x-api-key',
            wireFormat: 'anthropic',
            noAutoFallback: true,
          },
          or: {
            displayName: 'Test OR',
            endpoint: upstreamUrl,
            keyEnv: 'TEST_KEY',
            authHeader: 'bearer',
            wireFormat: 'openai',
            noAutoFallback: true,
          },
          an: {
            displayName: 'Test AN',
            endpoint: upstreamUrl,
            keyEnv: 'TEST_KEY',
            authHeader: 'x-api-key',
            wireFormat: 'anthropic',
            noAutoFallback: true,
          },
        },
        thinking: {
          'deepseek-v4-flash': { type: 'enabled', budget_tokens: 16000 },
          'deepseek-v4-pro': { type: 'enabled', budget_tokens: 32000 },
        },
      }),
    );

    fs.writeFileSync(
      protoRoutesFile,
      JSON.stringify({
        routes: { '': 'ds' },
        providers: {
          ds: {
            url: upstreamUrl,
            keyEnv: 'TEST_KEY',
            auth: 'x-api-key',
            format: 'anthropic',
            fallback: [],
            noAutoFallback: true,
          },
          or: {
            url: upstreamUrl,
            keyEnv: 'TEST_KEY',
            auth: 'bearer',
            format: 'openai',
            fallback: [],
            noAutoFallback: true,
          },
          an: {
            url: upstreamUrl,
            keyEnv: 'TEST_KEY',
            auth: 'x-api-key',
            format: 'anthropic',
            fallback: [],
            noAutoFallback: true,
          },
        },
        defaultProvider: 'ds',
        models: {
          'haiku:deepseek-v4-flash': { targetProvider: 'ds', targetModel: 'deepseek-v4-flash' },
          'claude-sonnet-4-6': { targetProvider: 'an', targetModel: 'claude-sonnet-4-6' },
        },
      }),
    );
    fs.writeFileSync(protoOverridesFile, JSON.stringify({}));

    // Set test API key
    process.env.TEST_KEY = 'test-key-123';

    protoProxyProcess = spawn(
      ...shellSafe(npxCmd, [
        'tsx',
        'proxy/start-proxy.ts',
        '--routes',
        protoRoutesFile,
        '--overrides',
        protoOverridesFile,
        '--providers',
        protoProvidersFile,
      ]),
      {
        cwd: path.resolve(__dirname, '../..'),
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, DEFIANT_NO_PID_LOCK: '1', TEST_KEY: 'test-key-123' },
        ...(IS_WIN ? { shell: true } : {}),
      },
    );

    const portStr = await new Promise<string>((resolve, reject) => {
      let out = '';
      const timer = setTimeout(
        () => reject(new Error('Proto proxy did not start within 25s')),
        25000,
      );
      protoProxyProcess.stdout!.on('data', (chunk: Buffer) => {
        out += chunk.toString();
        const m = out.match(/PORT:(\d+)/);
        if (m) {
          clearTimeout(timer);
          resolve(m[1]);
        }
      });
      protoProxyProcess.stderr!.on('data', () => {});
    });
    protoProxyPort = parseInt(portStr, 10);
  }, 35000);

  afterAll(async () => {
    delete process.env.TEST_KEY;
    if (protoProxyProcess && protoProxyProcess.pid) {
      if (process.platform === 'win32') {
        try {
          execSync(`taskkill /T /F /PID ${protoProxyProcess.pid}`, {
            windowsHide: true,
            timeout: 5000,
            stdio: 'ignore',
          });
        } catch {}
      } else {
        protoProxyProcess.kill('SIGKILL');
      }
      protoProxyProcess.stdout?.destroy();
      protoProxyProcess.stderr?.destroy();
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 2000);
        protoProxyProcess.on('exit', () => {
          clearTimeout(t);
          resolve();
        });
      });
    }
    try {
      fs.unlinkSync(protoRoutesFile);
    } catch {}
    try {
      fs.unlinkSync(protoOverridesFile);
    } catch {}
    try {
      fs.unlinkSync(protoProvidersFile);
    } catch {}
  });

  function protoRequest(
    path: string,
    opts: { headers?: Record<string, string>; body?: string } = {},
  ) {
    return new Promise<{
      status: number;
      headers: Record<string, string | string[] | undefined>;
      body: unknown;
    }>((resolve, reject) => {
      const options = {
        hostname: '127.0.0.1',
        port: protoProxyPort,
        path,
        method: opts.body ? 'POST' : 'GET',
        headers: opts.headers || {},
        timeout: 10000,
        agent: false,
      };
      const req = http.request(options, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c as Buffer));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString();
          try {
            resolve({ status: res.statusCode || 0, headers: res.headers, body: JSON.parse(body) });
          } catch {
            resolve({ status: res.statusCode || 0, headers: res.headers, body });
          }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('timeout'));
      });
      if (opts.body) req.write(opts.body);
      req.end();
    });
  }

  // =========================================================================
  // PATH 1: DeepSeek Anthropic (ds) — tool conversion + tool_choice strip
  // =========================================================================

  test('ds path: web_search_20250305 → generic web_search, tool_choice stripped', async () => {
    const ccBody = {
      model: 'haiku:deepseek-v4-flash',
      messages: [{ role: 'user', content: 'Perform a web search for the query: test' }],
      system: 'You are Claude Code.',
      tools: [{ type: 'web_search_20250305', name: 'web_search', description: 'Search the web' }],
      tool_choice: { type: 'tool', name: 'web_search' },
      max_tokens: 4096,
      stream: true,
    };

    const res = await new Promise<StreamResult>((resolve, reject) => {
      const options = {
        hostname: '127.0.0.1',
        port: protoProxyPort,
        path: '/v1/messages',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000,
        agent: false,
      };
      const req = http.request(options, (res) => resolve(readStream(res)));
      req.on('error', reject);
      req.write(JSON.stringify(ccBody));
      req.end();
    });

    expect(res.status).toBe(200);

    // Verify what arrived at the mock upstream
    expect(mockRequests.length).toBeGreaterThan(0);
    const upstreamBody = mockRequests[mockRequests.length - 1].body as Record<string, unknown>;

    // Model: slot prefix stripped
    expect(upstreamBody.model).toBe('deepseek-v4-flash');

    // Tools: web_search_20250305 → name: 'web_search' (type prefix stripped)
    const tools = upstreamBody.tools as Array<Record<string, unknown>>;
    expect(tools).toBeDefined();
    expect(tools.length).toBe(1);
    expect(tools[0].name).toBe('web_search');
    expect(tools[0].type).toBeUndefined(); // Anthropic server tool type stripped

    // tool_choice: stripped (DeepSeek rejects it with thinking)
    expect(upstreamBody.tool_choice).toBeUndefined();

    // Thinking: injected for deepseek-v4-flash
    const thinking = upstreamBody.thinking as Record<string, unknown> | undefined;
    expect(thinking).toBeDefined();
    expect(thinking!.type).toBe('enabled');
    expect(thinking!.budget_tokens).toBe(16000);
  });

  // =========================================================================
  // PATH 2: Anthropic direct (an) — full passthrough, no conversion
  // =========================================================================

  test('an path: server tools and tool_choice pass through untouched', async () => {
    // Set mock to respond like Anthropic
    setMockHandler((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          content: [
            { type: 'text', text: 'Let me search for that.' },
            {
              type: 'tool_use',
              id: 'toolu_mock_001',
              name: 'web_search',
              input: { query: 'test' },
            },
          ],
          stop_reason: 'tool_use',
          stop_sequence: null,
          usage: {
            input_tokens: 50,
            output_tokens: 30,
            server_tool_use: { web_search_requests: 1, web_fetch_requests: 0 },
          },
        }),
      );
    });

    const ccBody = {
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'Search for test' }],
      system: 'You are helpful.',
      tools: [{ type: 'web_search_20250305', name: 'web_search', description: 'Search the web' }],
      tool_choice: { type: 'tool', name: 'web_search' },
      max_tokens: 4096,
      stream: false,
    };

    const res = await protoRequest('/v1/messages', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ccBody),
    });

    // Wait for async processing
    expect(res.status).toBe(200);
    const respBody = res.body as Record<string, unknown>;

    // Anthropic response: server_tool_use preserved from upstream
    const usage = respBody.usage as Record<string, unknown> | undefined;
    expect(usage).toBeDefined();
    const stu = usage!.server_tool_use as Record<string, number> | undefined;
    expect(stu).toBeDefined();
    expect(stu!.web_search_requests).toBe(1);

    // Content preserved
    const content = respBody.content as Array<Record<string, unknown>>;
    expect(content.length).toBe(2);
    expect(content[0].type).toBe('text');
    expect(content[1].type).toBe('tool_use');
  });

  // =========================================================================
  // PATH 3: OpenRouter (or) — full OpenAI protocol translation
  // =========================================================================

  test('or path: Anthropic request → OpenAI format, Anthropic fields stripped', async () => {
    setMockHandler((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-mock',
          model: 'deepseek-v4-flash',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'Code haiku: Logic flows, bugs hide' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 30, completion_tokens: 15, total_tokens: 45 },
        }),
      );
    });

    // Force route to or by setting the model header (prompt-router)
    const ccBody = {
      model: 'openrouter/deepseek-v4-flash',
      messages: [{ role: 'user', content: 'Write a haiku about code' }],
      system: 'You are a helpful assistant.',
      max_tokens: 1024,
      top_k: 5,
      metadata: { user: 'test' },
      stream: false,
    };

    const res = await protoRequest('/v1/messages', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ccBody),
    });

    expect(res.status).toBe(200);

    // Anthropic response translated back
    const respBody = res.body as Record<string, unknown>;
    expect(respBody.type).toBe('message');
    expect(respBody.role).toBe('assistant');
    expect(respBody.stop_reason).toBe('end_turn');

    const content = respBody.content as Array<Record<string, unknown>>;
    const textBlock = content.find((c) => c.type === 'text');
    expect(textBlock).toBeDefined();
    expect((textBlock as any).text).toBe('Code haiku: Logic flows, bugs hide');

    // Usage translated: prompt_tokens → input_tokens
    const usage = respBody.usage as Record<string, unknown>;
    expect(usage.input_tokens).toBe(30);
    expect(usage.output_tokens).toBe(15);
  });
});

// =========================================================================
// buildHotSwapHeaders — header rewriting for hot-swap forwarding
// =========================================================================

import { buildHotSwapHeaders } from '../hot-swap-headers';

describe('buildHotSwapHeaders', () => {
  test('rewrites x-api-key to defiant-<targetPort>', () => {
    const original = {
      'x-api-key': 'defiant-53746',
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
    };
    const result = buildHotSwapHeaders(original, 53747);
    expect(result['x-api-key']).toBe('defiant-53747');
  });

  test('preserves non-auth headers', () => {
    const original = {
      'x-api-key': 'defiant-53746',
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      accept: 'text/event-stream',
    };
    const result = buildHotSwapHeaders(original, 65151);
    expect(result['content-type']).toBe('application/json');
    expect(result['anthropic-version']).toBe('2023-06-01');
    expect(result['accept']).toBe('text/event-stream');
  });

  test('sets host header to new proxy address', () => {
    const result = buildHotSwapHeaders(
      { host: '127.0.0.1:53746', 'x-api-key': 'defiant-53746' },
      53747,
    );
    expect(result['host']).toBe('127.0.0.1:53747');
  });

  test('strips authorization header', () => {
    const original = {
      authorization: 'Bearer sk-ant-api03-old-session-token',
      'x-api-key': 'defiant-53746',
      'content-type': 'application/json',
    };
    const result = buildHotSwapHeaders(original, 53747);
    expect(result['x-api-key']).toBe('defiant-53747');
    expect(result['authorization']).toBeUndefined();
    expect(result['content-type']).toBe('application/json');
  });

  test('handles header keys with mixed case (x-api-key)', () => {
    // HTTP headers are case-insensitive; the function should still rewrite
    const original: Record<string, string> = {
      'X-API-Key': 'defiant-53746',
      'Content-Type': 'application/json',
    };
    const result = buildHotSwapHeaders(original, 65151);
    // JavaScript object keys are case-sensitive — x-api-key is set, original
    // X-API-Key remains (Node.js http library normalizes to lowercase, so
    // this tests that the function sets the canonical form)
    expect(result['x-api-key']).toBe('defiant-65151');
  });

  test('immutates original headers object', () => {
    const original = {
      'x-api-key': 'defiant-53746',
      'content-type': 'application/json',
    };
    const originalKeys = Object.keys(original).sort();
    buildHotSwapHeaders(original, 53747);
    // Original object should be unchanged
    expect(Object.keys(original).sort()).toEqual(originalKeys);
    expect(original['x-api-key']).toBe('defiant-53746');
  });

  test('default port schema works for any valid port', () => {
    const result = buildHotSwapHeaders({ 'x-api-key': 'defiant-3000' }, 65199);
    expect(result['x-api-key']).toBe('defiant-65199');
    expect(result['host']).toBe('127.0.0.1:65199');
  });
});

// =========================================================================
// Web search pre-execution — requests intercepted and served from DDG
// =========================================================================

describe('web search pre-execution', () => {
  test('intercepts web search request and returns results inline', async () => {
    const ccBody = {
      model: 'haiku:deepseek-v4-flash',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Perform a web search for the query: latest iPhone model 2026',
            },
          ],
        },
      ],
      system: [{ type: 'text', text: 'You are an assistant for performing a web search tool use' }],
      tools: [
        {
          type: 'web_search_20250305',
          name: 'web_search',
          description: 'Search',
          input_schema: {
            type: 'object',
            properties: { query: { type: 'string', description: 'Search query' } },
            required: ['query'],
          },
        },
      ],
      tool_choice: { type: 'tool', name: 'web_search_20250305' },
      max_tokens: 500,
      stream: false,
    };

    const res = await request('POST', '/v1/messages', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ccBody),
    });

    // Pre-execution should intercept and return 200, not fall through to routing
    expect(res.status).toBe(200);

    const body = res.body as Record<string, unknown>;
    // Model must start with claude- for CC to trust server_tool_use
    expect(typeof body.model).toBe('string');
    expect(body.model!.toString()).toMatch(/^claude-/);

    // Must have server_tool_use so CC shows "Did N searches"
    const usage = body.usage as Record<string, unknown>;
    expect(usage).toBeDefined();
    expect(usage.server_tool_use).toBeDefined();
    const stu = usage.server_tool_use as Record<string, number>;
    expect(stu.web_search_requests).toBeGreaterThanOrEqual(1);

    // Content must be web_search_tool_result block (CC counts these for "Did N")
    const content = body.content as Array<Record<string, unknown>>;
    expect(Array.isArray(content)).toBe(true);
    expect(content.length).toBeGreaterThan(0);
    const searchBlock = content[0] as Record<string, unknown>;
    expect(searchBlock.type).toBe('web_search_tool_result');
    expect(typeof searchBlock.tool_use_id).toBe('string');
    expect(searchBlock.caller).toBeDefined();
    expect((searchBlock.caller as Record<string, unknown>).type).toBe('direct');

    // Must have web_search_result sub-blocks with url, title, encrypted_content
    const results = searchBlock.content as Array<Record<string, unknown>>;
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
    const firstResult = results[0];
    expect(firstResult.type).toBe('web_search_result');
    expect(typeof firstResult.url).toBe('string');
    expect(typeof firstResult.title).toBe('string');
    expect(typeof firstResult.encrypted_content).toBe('string');
  });

  test('returns streaming SSE response for stream:true with web_search_tool_result', async () => {
    const ccBody = {
      model: 'haiku:deepseek-v4-flash',
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'Perform a web search for the query: iPhone 18 Pro' }],
        },
      ],
      system: [{ type: 'text', text: 'You are an assistant for performing a web search tool use' }],
      tools: [
        {
          type: 'web_search_20250305',
          name: 'web_search',
          description: 'Search',
          input_schema: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
          },
        },
      ],
      tool_choice: { type: 'tool', name: 'web_search_20250305' },
      max_tokens: 500,
      stream: true,
    };

    const result = await request('POST', '/v1/messages', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ccBody),
    });

    // Streaming SSE should return 200 with web_search_tool_result in content_block_start
    expect(result.status).toBe(200);
    const sseText = result.body as string;
    // Should contain web_search_tool_result in content_block_start
    expect(sseText).toContain('web_search_tool_result');
    // Should contain server_tool_use in message_delta
    expect(sseText).toContain('server_tool_use');
    expect(sseText).toContain('web_search_requests');
  });

  test('falls through to normal routing when no query extractable', async () => {
    // Message format without "Perform a web search for the query:" pattern
    const ccBody = {
      model: 'haiku:claude-haiku-4-5-20251001',
      messages: [{ role: 'user', content: 'What is the weather in Paris?' }],
      tools: [
        {
          type: 'web_search_20250305',
          name: 'web_search',
          description: 'Search the web',
          input_schema: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
          },
        },
      ],
      tool_choice: { type: 'tool', name: 'web_search' },
      max_tokens: 200,
      stream: false,
    };

    const res = await request('POST', '/v1/messages', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ccBody),
    });

    // Should not be intercepted — no extractable query means routing fails
    // (routes file has no providers), so we get a 502 from fallback exhaustion
    // or the request may hang. Either way, it should NOT be a 200 with
    // server_tool_use injected from pre-execution.
    if (res.status === 200) {
      const body = res.body as Record<string, unknown>;
      if (body.usage) {
        const stu = (body.usage as Record<string, unknown>).server_tool_use as
          | Record<string, unknown>
          | undefined;
        // If we somehow got here, server_tool_use should not be present
        // since pre-execution should have been skipped
        expect(stu).toBeUndefined();
      }
    }
    // 502 or other error is expected (no providers configured)
  });

  test('intercepts web_fetch tools too', async () => {
    const ccBody = {
      model: 'haiku:deepseek-v4-flash',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Perform a web search for the query: latest news',
            },
          ],
        },
      ],
      system: [{ type: 'text', text: 'You are an assistant for performing a web search tool use' }],
      tools: [
        {
          type: 'web_fetch_20250305',
          name: 'web_fetch',
          description: 'Fetch URL content',
          input_schema: {
            type: 'object',
            properties: { url: { type: 'string' } },
            required: ['url'],
          },
        },
      ],
      tool_choice: { type: 'tool', name: 'web_fetch_20250305' },
      max_tokens: 500,
      stream: false,
    };

    const res = await request('POST', '/v1/messages', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ccBody),
    });

    // web_fetch type is detected by hasWebTools, and "Perform a web search
    // for the query:" in the user message triggers extractSearchQuery.
    // Should be intercepted and return 200 with DDG results.
    expect(res.status).toBe(200);
  });

  test('response has complete web_search_tool_result with all required fields', async () => {
    const ccBody = {
      model: 'haiku:deepseek-v4-flash',
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'Perform a web search for the query: test query' }],
        },
      ],
      system: [{ type: 'text', text: 'web search assistant' }],
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      max_tokens: 200,
      stream: false,
    };

    const res = await request('POST', '/v1/messages', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ccBody),
    });

    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;

    // Content block must be web_search_tool_result (NOT text)
    const content = body.content as Array<Record<string, unknown>>;
    expect(content[0].type).toBe('web_search_tool_result');

    // Required fields on web_search_tool_result
    expect(typeof content[0].tool_use_id).toBe('string');
    expect((content[0].tool_use_id as string).length).toBeGreaterThan(0);
    expect(content[0].caller).toBeDefined();
    expect((content[0].caller as Record<string, unknown>).type).toBe('direct');

    // Must have content array with web_search_result sub-blocks
    const results = content[0].content as Array<Record<string, unknown>>;
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);

    // Each result has required fields
    for (const r of results) {
      expect(r.type).toBe('web_search_result');
      expect(typeof r.url).toBe('string');
      expect(typeof r.title).toBe('string');
      expect(typeof r.encrypted_content).toBe('string');
      // page_age should be string or null
      expect(r.page_age === null || typeof r.page_age === 'string').toBe(true);
    }

    // Usage with server_tool_use
    const usage = body.usage as Record<string, unknown>;
    const stu = usage.server_tool_use as Record<string, number>;
    expect(stu.web_search_requests).toBeGreaterThanOrEqual(1);
  });

  test('streaming SSE response contains web_search_tool_result and server_tool_use', async () => {
    const ccBody = {
      model: 'haiku:deepseek-v4-flash',
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'Perform a web search for the query: streaming test' }],
        },
      ],
      system: [{ type: 'text', text: 'web search assistant' }],
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      max_tokens: 200,
      stream: true,
    };

    const result = await request('POST', '/v1/messages', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ccBody),
    });

    expect(result.status).toBe(200);
    const sseText = result.body as string;

    // Must contain the correct content block type in content_block_start
    expect(sseText).toContain('web_search_tool_result');

    // Must contain tool_use_id and caller in the SSE payload
    expect(sseText).toContain('tool_use_id');
    expect(sseText).toContain('"caller"');

    // Must have web_search_result sub-blocks
    expect(sseText).toContain('web_search_result');

    // Must inject server_tool_use in message_delta
    expect(sseText).toContain('server_tool_use');
    expect(sseText).toContain('web_search_requests');
  });

  test('handles queries with special characters', async () => {
    const ccBody = {
      model: 'haiku:deepseek-v4-flash',
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'Perform a web search for the query: C++ vs Rust 2026' }],
        },
      ],
      system: [{ type: 'text', text: 'web search assistant' }],
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      max_tokens: 200,
      stream: false,
    };

    const res = await request('POST', '/v1/messages', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ccBody),
    });

    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    const content = body.content as Array<Record<string, unknown>>;
    expect(content[0].type).toBe('web_search_tool_result');
  });

  test('model field uses trusted claude- name from any slot prefix', async () => {
    // Test that haiku:deepseek-v4-flash gets mapped to claude-haiku-4-5-20251001
    const ccBody = {
      model: 'haiku:deepseek-v4-flash',
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'Perform a web search for the query: model trust test' }],
        },
      ],
      system: [{ type: 'text', text: 'web search assistant' }],
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      max_tokens: 200,
      stream: false,
    };

    const res = await request('POST', '/v1/messages', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ccBody),
    });

    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(typeof body.model).toBe('string');
    expect(body.model!.toString()).toMatch(/^claude-haiku/);
  });

  test('sonnet slot maps to claude-sonnet trusted model', async () => {
    const ccBody = {
      model: 'sonnet:deepseek-v4-pro',
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'Perform a web search for the query: sonnet slot test' }],
        },
      ],
      system: [{ type: 'text', text: 'web search assistant' }],
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      max_tokens: 200,
      stream: false,
    };

    const res = await request('POST', '/v1/messages', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ccBody),
    });

    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(typeof body.model).toBe('string');
    expect(body.model!.toString()).toMatch(/^claude-sonnet/);
  });

  test('multi-search: handles multiple queries in a single request', async () => {
    const ccBody = {
      model: 'haiku:deepseek-v4-flash',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Perform a web search for the query: iPhone 18 Pro' },
            { type: 'text', text: 'Perform a web search for the query: Samsung Galaxy S26' },
            { type: 'text', text: 'Perform a web search for the query: Google Pixel 10' },
          ],
        },
      ],
      system: [{ type: 'text', text: 'web search assistant' }],
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      max_tokens: 500,
      stream: false,
    };

    const res = await request('POST', '/v1/messages', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ccBody),
    });

    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;

    // Should have 3 content blocks (one per query)
    const content = body.content as Array<Record<string, unknown>>;
    expect(content.length).toBe(3);

    // Each block should be a valid web_search_tool_result
    for (let i = 0; i < 3; i++) {
      expect(content[i].type).toBe('web_search_tool_result');
      expect(typeof content[i].tool_use_id).toBe('string');
      expect(content[i].tool_use_id as string).toContain('_' + i);
      expect(content[i].caller).toBeDefined();
      expect((content[i].caller as Record<string, unknown>).type).toBe('direct');
      const results = content[i].content as Array<Record<string, unknown>>;
      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].type).toBe('web_search_result');
      expect(typeof results[0].url).toBe('string');
      expect(typeof results[0].title).toBe('string');
      expect(typeof results[0].encrypted_content).toBe('string');
    }

    // server_tool_use should show 3 searches
    const usage = body.usage as Record<string, unknown>;
    const stu = usage.server_tool_use as Record<string, number>;
    expect(stu.web_search_requests).toBe(3);
  });

  test('multi-search: streaming SSE has multiple content_block_start events', async () => {
    const ccBody = {
      model: 'haiku:deepseek-v4-flash',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Perform a web search for the query: weather Paris' },
            { type: 'text', text: 'Perform a web search for the query: weather London' },
          ],
        },
      ],
      system: [{ type: 'text', text: 'web search assistant' }],
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      max_tokens: 500,
      stream: true,
    };

    const result = await request('POST', '/v1/messages', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ccBody),
    });

    expect(result.status).toBe(200);
    const sseText = result.body as string;

    // Two content_block_start events (index 0 and 1)
    expect(sseText.match(/"content_block_start"/g)?.length).toBeGreaterThanOrEqual(2);
    // Two content_block_stop events
    expect(sseText.match(/"content_block_stop"/g)?.length).toBeGreaterThanOrEqual(2);
    // web_search_requests should be 2
    expect(sseText).toContain('"web_search_requests":2');
    // Each block has its own tool_use_id with index
    expect(sseText).toContain('toolu_SEARCH_');
    expect(sseText).toContain('_0');
    expect(sseText).toContain('_1');
  });

  test('multi-search: falls through when query count exceeds max', async () => {
    const ccBody = {
      model: 'haiku:deepseek-v4-flash',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Perform a web search for the query: q1' },
            { type: 'text', text: 'Perform a web search for the query: q2' },
            { type: 'text', text: 'Perform a web search for the query: q3' },
            { type: 'text', text: 'Perform a web search for the query: q4' },
            { type: 'text', text: 'Perform a web search for the query: q5' },
            { type: 'text', text: 'Perform a web search for the query: q6' },
          ],
        },
      ],
      system: [{ type: 'text', text: 'web search assistant' }],
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      max_tokens: 200,
      stream: false,
    };

    const res = await request('POST', '/v1/messages', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ccBody),
    });

    // 6 queries > 5 max — should fall through (no pre-execution)
    // Routes file has no providers, so we get 502 or other error
    expect(res.status).not.toBe(200);
  });
});
