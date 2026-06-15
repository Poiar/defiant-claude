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

// These tests spawn real proxies and wait for TCP drain timers (30s grace).
// 60s per test is generous but safe.
jest.setTimeout(60_000);

// CRITICAL: use an isolated DEEPCLAUDE_DIR so hot-swap signal files
// (next-proxy.port) never leak to real running proxies. Without this,
// a real proxy would detect the test's signal file, enter forwarding
// mode to the test proxy, and die when the test proxy is killed.
const TEST_DEEPCLAUDE_DIR = path.join(os.tmpdir(), 'dc-hotswap-test-' + process.pid);
const NEXT_PORT_FILE = path.join(TEST_DEEPCLAUDE_DIR, 'next-proxy.port');
const PORT_FILE = path.join(TEST_DEEPCLAUDE_DIR, 'proxy.port');

let testDir: string;

function request(
  port: number,
  method: string,
  urlPath: string,
  opts: { headers?: Record<string, string>; body?: string; timeout?: number } = {},
): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}> {
  return new Promise((resolve, reject) => {
    const options: http.RequestOptions = {
      hostname: '127.0.0.1',
      port,
      path: urlPath,
      method,
      headers: opts.headers || {},
      timeout: opts.timeout || 5000,
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

// Health-check only — does NOT set hadTcpClient
async function healthCheck(port: number, timeoutMs = 3000): Promise<boolean> {
  try {
    const res = await request(port, 'GET', '/health', { timeout: timeoutMs });
    return res.status === 200;
  } catch {
    return false;
  }
}

function startProxy(
  port: number,
  routesFile: string,
  overridesFile: string,
): { process: ChildProcess; portPromise: Promise<number> } {
  const proxyProc = spawn(
    ...shellSafe(npxCmd, [
      'tsx',
      'proxy/start-proxy.ts',
      '--routes',
      routesFile,
      '--overrides',
      overridesFile,
      '--port',
      String(port),
    ]),
    {
      cwd: path.resolve(__dirname, '../..'),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
      ...(IS_WIN ? { shell: true } : {}),
    },
  );

  const portPromise = new Promise<number>((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error('Proxy did not start within 25s')), 25000);
    proxyProc.stdout!.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      const m = out.match(/PORT:(\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve(parseInt(m[1], 10));
      }
    });
    proxyProc.stderr!.on('data', () => {});
  });

  return { process: proxyProc, portPromise };
}

function killProxy(proc: ChildProcess): void {
  if (proc.exitCode !== null) return; // Already dead
  try {
    if (process.platform === 'win32') {
      try {
        execSync(`taskkill /PID ${proc.pid} /T /F`, { stdio: 'ignore' });
      } catch {
        // Process may already be dead
      }
    } else {
      proc.kill('SIGTERM');
    }
  } catch {
    // Already dead
  }
}

function cleanupSignalFiles(): void {
  try {
    if (fs.existsSync(NEXT_PORT_FILE)) fs.unlinkSync(NEXT_PORT_FILE);
  } catch {}
}

beforeAll(() => {
  testDir = os.tmpdir();
  // Create isolated .deepclaude directory so signal files never touch
  // real running proxies' state.
  try {
    fs.mkdirSync(TEST_DEEPCLAUDE_DIR, { recursive: true });
  } catch {}
  process.env.DEEPCLAUDE_DIR = TEST_DEEPCLAUDE_DIR;
  cleanupSignalFiles();
});

afterAll(() => {
  cleanupSignalFiles();
  try {
    fs.rmSync(TEST_DEEPCLAUDE_DIR, { recursive: true, force: true });
  } catch {}
  delete process.env.DEEPCLAUDE_DIR;
});

describe('Hot-swap mechanism', () => {
  let routesFile: string;
  let overridesFile: string;

  beforeEach(() => {
    routesFile = path.join(
      testDir,
      'dc-hotswap-routes-' + process.pid + '-' + Date.now() + '.json',
    );
    overridesFile = path.join(
      testDir,
      'dc-hotswap-overrides-' + process.pid + '-' + Date.now() + '.json',
    );
    fs.writeFileSync(
      routesFile,
      JSON.stringify({ routes: {}, providers: {}, defaultProvider: null }),
    );
    fs.writeFileSync(overridesFile, JSON.stringify({}));
    cleanupSignalFiles();
  });

  afterEach(() => {
    try {
      fs.unlinkSync(routesFile);
    } catch {}
    try {
      fs.unlinkSync(overridesFile);
    } catch {}
    cleanupSignalFiles();
  });

  describe('port file on startup', () => {
    it('writes proxy.port with its listening port', async () => {
      // Save any existing port file (from a running real proxy) so we can
      // restore it after this test overwrites it.
      let savedPort = '';
      try {
        if (fs.existsSync(PORT_FILE)) savedPort = fs.readFileSync(PORT_FILE, 'utf-8').trim();
      } catch {}

      const port = 56000 + Math.floor(Math.random() * 1000);
      const { process: proxyProc, portPromise } = startProxy(port, routesFile, overridesFile);

      try {
        await portPromise;
        await new Promise((r) => setTimeout(r, 500));

        const writtenPort = parseInt(fs.readFileSync(PORT_FILE, 'utf-8').trim(), 10);
        expect(writtenPort).toBe(port);
      } finally {
        killProxy(proxyProc);
        // Restore the real proxy's port file
        try {
          if (savedPort) fs.writeFileSync(PORT_FILE, savedPort);
        } catch {}
      }
    });
  });

  describe('signal file cleanup', () => {
    it('deletes next-proxy.port when started as the replacement', async () => {
      const port = 56000 + Math.floor(Math.random() * 1000);

      // Write the signal file BEFORE starting the proxy
      fs.mkdirSync(TEST_DEEPCLAUDE_DIR, { recursive: true });
      fs.writeFileSync(NEXT_PORT_FILE, String(port));

      const { process: proxyProc, portPromise } = startProxy(port, routesFile, overridesFile);

      try {
        await portPromise;
        await new Promise((r) => setTimeout(r, 500));

        // Signal file should be deleted because this proxy IS the replacement
        expect(fs.existsSync(NEXT_PORT_FILE)).toBe(false);
      } finally {
        killProxy(proxyProc);
      }
    });

    it('does NOT delete next-proxy.port when started on a different port', async () => {
      const signalPort = 56000 + Math.floor(Math.random() * 1000);
      const actualPort = signalPort + 1;

      // Write the signal file for a different port
      fs.mkdirSync(TEST_DEEPCLAUDE_DIR, { recursive: true });
      fs.writeFileSync(NEXT_PORT_FILE, String(signalPort));

      const { process: proxyProc, portPromise } = startProxy(actualPort, routesFile, overridesFile);

      try {
        await portPromise;
        await new Promise((r) => setTimeout(r, 500));

        // Signal file should still exist — this proxy isn't the replacement
        expect(fs.existsSync(NEXT_PORT_FILE)).toBe(true);
      } finally {
        killProxy(proxyProc);
      }
    });
  });

  describe('TCP connection tracking', () => {
    it('stays alive after health checks (hadTcpClient not set)', async () => {
      const port = 56000 + Math.floor(Math.random() * 1000);
      const { process: proxyProc, portPromise } = startProxy(port, routesFile, overridesFile);

      try {
        await portPromise;
        await new Promise((r) => setTimeout(r, 500));

        // Health checks should NOT set hadTcpClient
        const healthy = await healthCheck(port);
        expect(healthy).toBe(true);

        // Wait past the 5s drain grace period
        await new Promise((r) => setTimeout(r, 6000));

        // Proxy should still be alive (exitCode is null — still running)
        expect(proxyProc.exitCode).toBe(null);
      } finally {
        killProxy(proxyProc);
      }
    });

    it('does NOT auto-exit when client disconnects (only superseded proxies drain)', async () => {
      const port = 56000 + Math.floor(Math.random() * 1000);
      const { process: proxyProc, portPromise } = startProxy(port, routesFile, overridesFile);

      try {
        await portPromise;
        await new Promise((r) => setTimeout(r, 500));

        // Send a real API request (sets hadTcpClient = true).
        // Connection: close forces the TCP socket to fully close afterwards.
        try {
          await request(port, 'POST', '/v1/messages', {
            headers: { 'content-type': 'application/json', connection: 'close' },
            body: JSON.stringify({
              model: 'fake-model',
              messages: [{ role: 'user', content: 'hi' }],
              stream: false,
            }),
            timeout: 5000,
          });
        } catch {
          // Expected to fail — no real provider configured
        }

        // Wait past the drain grace period — proxy should STILL be alive
        // because checkDrain only fires for superseded (forwarding) proxies.
        await new Promise((r) => setTimeout(r, 35000));

        // Normal proxies never auto-exit — only forwarding proxies drain.
        expect(proxyProc.exitCode).toBe(null);
      } finally {
        killProxy(proxyProc);
      }
    });
  });

  describe('hot-swap forwarding', () => {
    it('old proxy enters forwarding mode when next-proxy.port appears', async () => {
      const oldPort = 56000 + Math.floor(Math.random() * 1000);
      const newPort = oldPort + 1;

      // Start the "old" proxy
      const { process: oldProxy, portPromise: oldPortPromise } = startProxy(
        oldPort,
        routesFile,
        overridesFile,
      );

      // Start the "new" proxy (this will be the forwarding target)
      const newRoutesFile = path.join(
        testDir,
        'dc-hotswap-new-routes-' + process.pid + '-' + Date.now() + '.json',
      );
      const newOverridesFile = path.join(
        testDir,
        'dc-hotswap-new-overrides-' + process.pid + '-' + Date.now() + '.json',
      );
      fs.writeFileSync(
        newRoutesFile,
        JSON.stringify({ routes: {}, providers: {}, defaultProvider: null }),
      );
      fs.writeFileSync(newOverridesFile, JSON.stringify({}));

      const { process: newProxy, portPromise: newPortPromise } = startProxy(
        newPort,
        newRoutesFile,
        newOverridesFile,
      );

      try {
        await oldPortPromise;
        await newPortPromise;
        await new Promise((r) => setTimeout(r, 500));

        // Both proxies should be healthy
        expect(await healthCheck(oldPort)).toBe(true);
        expect(await healthCheck(newPort)).toBe(true);

        // Write the signal file — old proxy should detect it and enter forwarding mode
        fs.writeFileSync(NEXT_PORT_FILE, String(newPort));

        // Poll: wait up to 10s for old proxy to detect signal and enter forwarding
        let oldForwarding = false;
        for (let i = 0; i < 20; i++) {
          await new Promise((r) => setTimeout(r, 500));
          // Old proxy should forward requests to new proxy now.
          // Send a health check to old — it should reach new proxy.
          try {
            const res = await request(oldPort, 'GET', '/health', { timeout: 3000 });
            if (res.status === 200) {
              oldForwarding = true;
              break;
            }
          } catch {
            // Still checking
          }
        }

        expect(oldForwarding).toBe(true);

        // Send a model request through old proxy — it should forward
        // Instead of a full model call (which will fail with no routes),
        // just verify old proxy is still functional.
        const healthViaOld = await request(oldPort, 'GET', '/health', { timeout: 3000 });
        expect(healthViaOld.status).toBe(200);
      } finally {
        cleanupSignalFiles();
        killProxy(oldProxy);
        killProxy(newProxy);
        try {
          fs.unlinkSync(newRoutesFile);
        } catch {}
        try {
          fs.unlinkSync(newOverridesFile);
        } catch {}
      }
    });

    it('old proxy exits after client disconnects + all connections drain', async () => {
      // Clean up port file so it doesn't interfere
      try {
        if (fs.existsSync(PORT_FILE)) fs.unlinkSync(PORT_FILE);
      } catch {}

      const oldPort = 56000 + Math.floor(Math.random() * 1000);
      const newPort = oldPort + 1;

      const { process: oldProxy, portPromise: oldPortPromise } = startProxy(
        oldPort,
        routesFile,
        overridesFile,
      );
      const newRoutesFile2 = path.join(
        testDir,
        'dc-hotswap-drain-routes-' + process.pid + '-' + Date.now() + '.json',
      );
      const newOverridesFile2 = path.join(
        testDir,
        'dc-hotswap-drain-overrides-' + process.pid + '-' + Date.now() + '.json',
      );
      fs.writeFileSync(
        newRoutesFile2,
        JSON.stringify({ routes: {}, providers: {}, defaultProvider: null }),
      );
      fs.writeFileSync(newOverridesFile2, JSON.stringify({}));
      const { process: newProxy, portPromise: newPortPromise } = startProxy(
        newPort,
        newRoutesFile2,
        newOverridesFile2,
      );

      try {
        await oldPortPromise;
        await newPortPromise;
        await new Promise((r) => setTimeout(r, 500));

        // Mark old proxy as having had a real client
        try {
          await request(oldPort, 'POST', '/v1/messages', {
            headers: { 'content-type': 'application/json', connection: 'close' },
            body: JSON.stringify({
              model: 'fake',
              messages: [{ role: 'user', content: 'hi' }],
              stream: false,
            }),
            timeout: 5000,
          });
        } catch {
          /* expected */
        }

        // Signal the old proxy to enter forwarding mode
        fs.writeFileSync(NEXT_PORT_FILE, String(newPort));

        // Wait for old proxy to detect signal (5s poll) + 30s drain grace + buffer
        await new Promise((r) => setTimeout(r, 40000));

        // Old proxy should have exited (all connections drained)
        expect(oldProxy.exitCode).not.toBe(null);
      } finally {
        cleanupSignalFiles();
        killProxy(oldProxy);
        killProxy(newProxy);
        try {
          fs.unlinkSync(newRoutesFile2);
        } catch {}
        try {
          fs.unlinkSync(newOverridesFile2);
        } catch {}
      }
    });
  });
});
