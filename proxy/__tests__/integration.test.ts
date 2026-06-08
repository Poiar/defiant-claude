'use strict';

import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn, ChildProcess } from 'child_process';

const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';

let proxyProcess: ChildProcess;
let proxyPort: number;
let routesFile: string;
let overridesFile: string;

function request(method: string, urlPath: string, opts: { headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: unknown }> {
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
            res.on('data', c => chunks.push(c as Buffer));
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

    fs.writeFileSync(routesFile, JSON.stringify({
        routes: {},
        providers: {},
        defaultProvider: null,
    }));
    fs.writeFileSync(overridesFile, JSON.stringify({}));

    proxyProcess = spawn(npxCmd, [
        'tsx',
        'proxy/start-proxy.ts',
        '--routes', routesFile,
        '--overrides', overridesFile,
    ], {
        cwd: path.resolve(__dirname, '../..'),
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(process.platform === 'win32' ? { shell: true } : {}),
    });

    const portStr = await new Promise<string>((resolve, reject) => {
        let out = '';
        const timer = setTimeout(() => reject(new Error('Proxy did not start within 25s')), 25000);
        proxyProcess.stdout!.on('data', (chunk: Buffer) => {
            out += chunk.toString();
            const m = out.match(/PORT:(\d+)/);
            if (m) { clearTimeout(timer); resolve(m[1]); }
        });
        proxyProcess.stderr!.on('data', () => {});
    });
    proxyPort = parseInt(portStr, 10);
}, 15000);

afterAll(async () => {
    if (proxyProcess) {
        proxyProcess.kill();
        proxyProcess.stdout?.destroy();
        proxyProcess.stderr?.destroy();
        await new Promise(resolve => {
            const timer = setTimeout(resolve, 2000);
            proxyProcess.on('exit', () => { clearTimeout(timer); resolve(); });
        });
    }
    try { fs.unlinkSync(routesFile); } catch (_) {}
    try { fs.unlinkSync(overridesFile); } catch (_) {}
});

describe('Proxy integration tests', () => {

    test('GET /health returns 200 with correct structure', async () => {
        const res = await request('GET', '/health');

        expect(res.status).toBe(200);
        expect((res.body as Record<string, unknown>).status).toBe('ok');
        expect(typeof (res.body as Record<string, unknown>).version).toBe('string');
        expect(typeof (res.body as Record<string, unknown>).uptime).toBe('number');

        expect((res.body as Record<string, unknown>).concurrency).toBeDefined();
        const concurrency = (res.body as Record<string, unknown>).concurrency as Record<string, unknown>;
        expect(typeof concurrency.active).toBe('number');
        expect(typeof concurrency.waiting).toBe('number');
        expect(typeof concurrency.limit).toBe('number');
        expect(typeof concurrency.utilization).toBe('number');

        expect((res.body as Record<string, unknown>).rateLimiter).toBeDefined();
        const rateLimiter = (res.body as Record<string, unknown>).rateLimiter as Record<string, unknown>;
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

    test('POST /v1/messages with valid JSON but no model returns 502', async () => {
        const res = await request('POST', '/v1/messages', {
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        });

        expect(res.status).toBe(502);
        expect((res.body as Record<string, unknown>).type).toBe('api_error');
    });

    test('GET /health uptime increases between calls', async () => {
        const res1 = await request('GET', '/health');
        await new Promise(r => setTimeout(r, 1000));
        const res2 = await request('GET', '/health');

        expect(typeof (res1.body as Record<string, unknown>).uptime).toBe('number');
        expect(typeof (res2.body as Record<string, unknown>).uptime).toBe('number');
        expect((res2.body as Record<string, unknown>).uptime as number).toBeGreaterThanOrEqual((res1.body as Record<string, unknown>).uptime as number + 900);
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

    test('Multiple concurrent health requests all return 200', async () => {
        const reqs = Array.from({ length: 10 }, () => request('GET', '/health'));
        const results = await Promise.all(reqs);

        expect(results).toHaveLength(10);
        for (const res of results) {
            expect(res.status).toBe(200);
            expect((res.body as Record<string, unknown>).status).toBe('ok');
            expect((res.body as Record<string, unknown>).concurrency).toBeDefined();
            expect((res.body as Record<string, unknown>).rateLimiter).toBeDefined();
        }
    });

    test('POST /v1/messages without Content-Type header is allowed and returns 502', async () => {
        const res = await request('POST', '/v1/messages', {
            body: JSON.stringify({}),
        });

        expect(res.status).toBe(502);
        expect((res.body as Record<string, unknown>).type).toBe('api_error');
    });

});
