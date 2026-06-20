#!/usr/bin/env node
'use strict';

// Hot-swap proxy restart — start a new proxy and tell the old one to forward.
// NEVER kills the old proxy. Old proxy detects the signal, enters forwarding
// mode, and exits when all client connections drain.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir, platform } from 'os';
import { spawn } from 'child_process';
import { get } from 'http';

const DEFIANT_DIR = join(homedir(), '.defiant');
const PORT_FILE = join(DEFIANT_DIR, 'proxy.port');
const NEXT_PORT_FILE = join(DEFIANT_DIR, 'next-proxy.port');
const ROUTES_FILE = join(DEFIANT_DIR, 'current-routes.json');
const OVERRIDES_FILE = join(DEFIANT_DIR, 'slot-overrides.json');
const THINKING_OVERRIDES_FILE = join(DEFIANT_DIR, 'thinking-overrides.json');

const REPO_DIR = join(import.meta.dirname, '..');

function fail(msg) {
  console.error('ERROR: ' + msg);
  process.exit(1);
}

function healthCheck(port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const req = get(`http://127.0.0.1:${port}/health`, { timeout: timeoutMs }, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function main() {
  // 0. Guard: refuse to restart from within a CC session managed by this proxy.
  //    The ANTHROPIC_BASE_URL points to this proxy — killing it kills the session.
  const ccProxyPort = process.env.ANTHROPIC_BASE_URL?.match(/:(\d+)/)?.[1];
  if (ccProxyPort) {
    const proxyPort = existsSync(PORT_FILE) ? readFileSync(PORT_FILE, 'utf-8').trim() : null;
    if (proxyPort && ccProxyPort === proxyPort) {
      fail(
        'REFUSING to restart the proxy from within a Claude Code session that uses it.\n' +
          'This would kill your current session.\n' +
          'Run this from another terminal, or restart with: dc',
      );
    }
  }

  // 1. Read current port
  if (!existsSync(PORT_FILE)) fail('No proxy.port found — is a proxy running?');
  const currentPort = parseInt(readFileSync(PORT_FILE, 'utf-8').trim(), 10);
  if (!currentPort || isNaN(currentPort)) fail('Invalid proxy.port content');

  // 2. Pick new port
  const newPort = currentPort + 1;
  console.log(`Current proxy: port ${currentPort} → New proxy: port ${newPort}`);

  // 3. Build launch args
  const args = ['tsx', join(REPO_DIR, 'proxy/start-proxy.ts'), '--port', String(newPort)];
  if (existsSync(ROUTES_FILE)) args.push('--routes', ROUTES_FILE);
  if (existsSync(OVERRIDES_FILE)) args.push('--overrides', OVERRIDES_FILE);
  args.push('--providers', join(REPO_DIR, 'proxy/providers.json'));
  if (existsSync(THINKING_OVERRIDES_FILE))
    args.push('--thinking-overrides', THINKING_OVERRIDES_FILE);

  // 4. Write signal file
  mkdirSync(DEFIANT_DIR, { recursive: true });
  writeFileSync(NEXT_PORT_FILE, String(newPort));
  console.log('Signal file written: ' + NEXT_PORT_FILE);

  // 5. Start new proxy detached with full env inheritance.
  // On Windows cmd /c is more reliable than pwsh -NoProfile for env vars.
  // The proxy needs API keys (DEEPSEEK_API_KEY etc.) from the parent process.
  const isWin = platform() === 'win32';
  const child = spawn(isWin ? 'cmd' : 'npx', isWin ? ['/c', 'npx ' + args.join(' ')] : args, {
    cwd: REPO_DIR,
    stdio: 'ignore',
    detached: true,
    env: process.env, // explicit env inherit
  });
  child.unref();

  // 6. Wait for new proxy to be healthy (15s — some providers are slow to probe)
  console.log('Waiting for new proxy to be healthy...');
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const healthy = await healthCheck(newPort, 3000);
    if (healthy) {
      console.log('New proxy is healthy on port ' + newPort);
      console.log('');
      console.log('Restart Claude Code to pick up the new proxy:');
      console.log('  dc');
      process.exit(0);
    }
  }

  fail('New proxy did not become healthy within 15 seconds');
  process.exit(1);
}

main().catch((err) => {
  fail(err.message);
});
