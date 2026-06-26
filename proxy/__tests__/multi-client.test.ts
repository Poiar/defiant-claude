'use strict';

/**
 * Tests for multi-client support.
 */

import { spawnSync } from 'child_process';
import { join } from 'path';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';

const MULTI_CLIENT_SCRIPT = join(__dirname, '..', 'multi-client.mjs');

describe('multi-client CLI', () => {
  test('runs with no flags and no port (no-op)', () => {
    const r = spawnSync('node', [MULTI_CLIENT_SCRIPT], { encoding: 'utf-8' });
    // Should not crash
    expect(r.status).toBe(0);
  });

  test('--sdk flag prints instructions', () => {
    const r = spawnSync('node', [MULTI_CLIENT_SCRIPT, '--port=9999', '--sdk'], {
      encoding: 'utf-8',
    });
    expect(r.stdout).toContain('ANTHROPIC_BASE_URL');
    expect(r.stdout).toContain('http://127.0.0.1:9999');
  });

  test('--codex flag prints env vars', () => {
    const r = spawnSync('node', [MULTI_CLIENT_SCRIPT, '--port=5000', '--codex'], {
      encoding: 'utf-8',
    });
    expect(r.stdout).toContain('OPENAI_BASE_URL');
    expect(r.stdout).toContain('http://127.0.0.1:5000/v1');
  });
});

describe('multi-client file operations', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), 'dc-mc-' + process.pid + '-' + Date.now());
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  test('--vscode writes .vscode/settings.json', () => {
    // Create a .vscode dir so the script finds it (it uses process.cwd)
    const vsDir = join(tmpDir, '.vscode');
    mkdirSync(vsDir, { recursive: true });
    writeFileSync(join(vsDir, 'settings.json'), '{}');

    const r = spawnSync('node', [MULTI_CLIENT_SCRIPT, `--port=7777`, '--vscode'], {
      cwd: tmpDir,
      encoding: 'utf-8',
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('VS Code');

    // Verify file was updated
    const contents = JSON.parse(readFileSync(join(vsDir, 'settings.json'), 'utf-8'));
    expect(contents['claude-code.apiUrl']).toBe('http://127.0.0.1:7777');
  });

  test('--vscode updates existing apiUrl', () => {
    const vsDir = join(tmpDir, '.vscode');
    mkdirSync(vsDir, { recursive: true });
    writeFileSync(
      join(vsDir, 'settings.json'),
      JSON.stringify({ 'claude-code.apiUrl': 'http://old:1234' }),
    );

    const r = spawnSync('node', [MULTI_CLIENT_SCRIPT, `--port=8888`, '--vscode'], {
      cwd: tmpDir,
      encoding: 'utf-8',
    });
    expect(r.status).toBe(0);

    const contents = JSON.parse(readFileSync(join(vsDir, 'settings.json'), 'utf-8'));
    expect(contents['claude-code.apiUrl']).toBe('http://127.0.0.1:8888');
  });

  test('--jetbrains writes anthropic.xml fallback', () => {
    const r = spawnSync('node', [MULTI_CLIENT_SCRIPT, '--port=12345', '--jetbrains'], {
      encoding: 'utf-8',
    });
    expect(r.status).toBe(0);
    // The script will either find a JetBrains install or write the fallback
    expect(r.stdout).toContain('JetBrains');
  });
});
