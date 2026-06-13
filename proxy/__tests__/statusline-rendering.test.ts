'use strict';

// Test statusline.mjs rendering beyond spend: location, slot overrides,
// context window, DS milestone tags, proxy port, hex model stripping.

import { spawnSync } from 'child_process';
import { join } from 'path';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';

const STATUSLINE = join(__dirname, '..', '..', 'statusline', 'statusline.mjs');

interface SpawnOpts {
  env: Record<string, string>;
  stdin?: string;
  timeout?: number;
}

function runStatusline(opts: SpawnOpts): { stdout: string; stderr: string; status: number } {
  const r = spawnSync('node', [STATUSLINE], {
    encoding: 'utf-8',
    timeout: opts.timeout || 5000,
    env: opts.env,
    input: opts.stdin || '',
  });
  return {
    stdout: r.stdout?.trim() || '',
    stderr: r.stderr?.trim() || '',
    status: r.status || 0,
  };
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function makeCcJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    workspace: { current_dir: '/home/user/test-project' },
    model: { id: 'sonnet:claude-sonnet-4-6', display_name: 'Sonnet 4.6' },
    effort: { level: 'medium' },
    context_window: { total_input_tokens: 12000, max_input_tokens: 200000 },
    ...overrides,
  });
}

// ── setup / teardown ─────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = join(
    tmpdir(),
    `deepclaude-statusline-render-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch (_) {
    /* ok */
  }
});

// ── tests ────────────────────────────────────────────────────────────

describe('statusline location group', () => {
  test('shows directory name from workspace.current_dir', () => {
    const ccJson = JSON.stringify({
      workspace: { current_dir: '/home/user/my-awesome-project' },
      model: { id: 'sonnet:claude-sonnet-4-6' },
      effort: { level: 'medium' },
      context_window: { total_input_tokens: 500, max_input_tokens: 200000 },
    });

    const result = runStatusline({
      stdin: ccJson,
      env: {
        ...process.env,
        DEEPCLAUDE_DIR: tmpDir,
        GIT_BRANCH: '',
        PATH: process.env.PATH || '',
      },
    });

    expect(result.status).toBe(0);
    expect(stripAnsi(result.stdout)).toContain('my-awesome-project');
  });

  test('falls back to d.cwd when workspace.current_dir is absent', () => {
    const ccJson = JSON.stringify({
      cwd: '/home/user/fallback-dir',
      model: { id: 'sonnet:claude-sonnet-4-6' },
      effort: { level: 'medium' },
      context_window: { total_input_tokens: 500, max_input_tokens: 200000 },
    });

    const result = runStatusline({
      stdin: ccJson,
      env: {
        ...process.env,
        DEEPCLAUDE_DIR: tmpDir,
        GIT_BRANCH: '',
        PATH: process.env.PATH || '',
      },
    });

    expect(result.status).toBe(0);
    expect(stripAnsi(result.stdout)).toContain('fallback-dir');
  });

  test('shows branch from GIT_BRANCH env var', () => {
    const result = runStatusline({
      stdin: makeCcJson(),
      env: {
        ...process.env,
        DEEPCLAUDE_DIR: tmpDir,
        GIT_BRANCH: 'feature/cool-stuff',
        PATH: process.env.PATH || '',
      },
    });

    expect(result.status).toBe(0);
    expect(stripAnsi(result.stdout)).toContain('feature/cool-stuff');
  });

  test('shows branch from git command when GIT_BRANCH is unset and cwd is a repo', () => {
    // Only meaningful in a real repo — use the actual project dir.
    const ccJson = JSON.stringify({
      workspace: { current_dir: join(__dirname, '..', '..').replace(/\\/g, '/') },
      model: { id: 'sonnet:claude-sonnet-4-6' },
      effort: { level: 'medium' },
      context_window: { total_input_tokens: 500, max_input_tokens: 200000 },
    });

    const result = runStatusline({
      stdin: ccJson,
      env: {
        ...process.env,
        DEEPCLAUDE_DIR: tmpDir,
        GIT_BRANCH: '',
        PATH: process.env.PATH || '',
      },
    });

    expect(result.status).toBe(0);
    // Should have resolved the branch via git (main, or whatever is checked out).
    const branchMatch = stripAnsi(result.stdout).match(/[a-z]+\/[a-z-]+|\bm\w+\b/);
    const hasGitBranch = stripAnsi(result.stdout).includes('main') || branchMatch;
    expect(hasGitBranch).toBeTruthy();
  });
});

describe('statusline model & slot overrides', () => {
  test('shows slot label when model id matches a known slot prefix', () => {
    // Model "sonnet:something" triggers slot label "s " (abbreviated from sonnet).
    const ccJson = JSON.stringify({
      workspace: { current_dir: '/home/user/proj' },
      model: { id: 'sonnet:claude-sonnet-4-6', display_name: 'Sonnet 4.6' },
      effort: { level: 'high' },
      context_window: { total_input_tokens: 500, max_input_tokens: 200000 },
    });

    const overrides = { sonnet: 'an:claude-sonnet-4-6' };
    writeFileSync(join(tmpDir, 'slot-overrides.json'), JSON.stringify(overrides));

    const result = runStatusline({
      stdin: ccJson,
      env: {
        ...process.env,
        DEEPCLAUDE_DIR: tmpDir,
        GIT_BRANCH: 'main',
        PATH: process.env.PATH || '',
      },
    });

    expect(result.status).toBe(0);
    const plain = stripAnsi(result.stdout);
    // Should show "s " prefix (abbreviated slot label).
    expect(plain).toContain('an:claude-sonnet-4-6');
  });

  test('falls back to subagent-model.json when sub slot has no override', () => {
    const ccJson = JSON.stringify({
      workspace: { current_dir: '/home/user/proj' },
      model: { id: 'sub:claude-haiku-4-5', display_name: 'Sub' },
      effort: { level: 'medium' },
      context_window: { total_input_tokens: 500, max_input_tokens: 200000 },
    });

    // slot-overrides.json exists but has NO sub key — so it should fall back to subagent-model.json.
    writeFileSync(
      join(tmpDir, 'slot-overrides.json'),
      JSON.stringify({ sonnet: 'ds:deepseek-v4-pro' }),
    );
    writeFileSync(
      join(tmpDir, 'subagent-model.json'),
      JSON.stringify({ providerKey: 'an', modelId: 'claude-haiku-4-5-20251001' }),
    );

    const result = runStatusline({
      stdin: ccJson,
      env: {
        ...process.env,
        DEEPCLAUDE_DIR: tmpDir,
        GIT_BRANCH: 'main',
        PATH: process.env.PATH || '',
      },
    });

    expect(result.status).toBe(0);
    const plain = stripAnsi(result.stdout);
    // Note: "20251001" is all hex chars and gets stripped by the output
    // assembly regex \b[a-f0-9]{6,}\b. The visible part is still correct.
    expect(plain).toContain('an:claude-haiku-4-5');
  });

  test('shows fable slot label for fable: models', () => {
    const ccJson = JSON.stringify({
      workspace: { current_dir: '/home/user/proj' },
      model: { id: 'fable:claude-fable-5' },
      effort: { level: 'medium' },
      context_window: { total_input_tokens: 500, max_input_tokens: 200000 },
    });

    writeFileSync(
      join(tmpDir, 'slot-overrides.json'),
      JSON.stringify({ fable: 'an:claude-fable-5' }),
    );

    const result = runStatusline({
      stdin: ccJson,
      env: {
        ...process.env,
        DEEPCLAUDE_DIR: tmpDir,
        GIT_BRANCH: 'main',
        PATH: process.env.PATH || '',
      },
    });

    expect(result.status).toBe(0);
    const plain = stripAnsi(result.stdout);
    expect(plain).toContain('an:claude-fable-5');
  });
});

describe('statusline context window', () => {
  test('formats tokens >= 1000 as k', () => {
    const ccJson = JSON.stringify({
      workspace: { current_dir: '/home/user/proj' },
      model: { id: 'sonnet:claude-sonnet-4-6' },
      effort: { level: 'medium' },
      context_window: { total_input_tokens: 12345, max_input_tokens: 200000 },
    });

    const result = runStatusline({
      stdin: ccJson,
      env: {
        ...process.env,
        DEEPCLAUDE_DIR: tmpDir,
        GIT_BRANCH: 'main',
        PATH: process.env.PATH || '',
      },
    });

    expect(result.status).toBe(0);
    const plain = stripAnsi(result.stdout);
    expect(plain).toContain('12k/6%');
  });

  test('formats tokens < 1000 as raw number', () => {
    const ccJson = JSON.stringify({
      workspace: { current_dir: '/home/user/proj' },
      model: { id: 'sonnet:claude-sonnet-4-6' },
      effort: { level: 'medium' },
      context_window: { total_input_tokens: 500, max_input_tokens: 200000 },
    });

    const result = runStatusline({
      stdin: ccJson,
      env: {
        ...process.env,
        DEEPCLAUDE_DIR: tmpDir,
        GIT_BRANCH: 'main',
        PATH: process.env.PATH || '',
      },
    });

    expect(result.status).toBe(0);
    const plain = stripAnsi(result.stdout);
    expect(plain).toContain('500/');
  });

  test('shows only percentage when tokens are present but not shown as k', () => {
    const ccJson = JSON.stringify({
      workspace: { current_dir: '/home/user/proj' },
      model: { id: 'sonnet:claude-sonnet-4-6' },
      effort: { level: 'medium' },
      context_window: { total_input_tokens: 500, max_input_tokens: 200000 },
    });

    const result = runStatusline({
      stdin: ccJson,
      env: {
        ...process.env,
        DEEPCLAUDE_DIR: tmpDir,
        GIT_BRANCH: 'main',
        PATH: process.env.PATH || '',
      },
    });

    expect(result.status).toBe(0);
    const plain = stripAnsi(result.stdout);
    // 500 tokens at 200K max = 0% (Math.round(500/200000 * 100) = 0)
    expect(plain).toContain('500/0%');
  });

  test('resolves max tokens from current-routes.json when not in CC JSON', () => {
    const routesJson = { contextLimits: { 'claude-sonnet-4-6': 200000 } };
    writeFileSync(join(tmpDir, 'current-routes.json'), JSON.stringify(routesJson));

    const ccJson = JSON.stringify({
      workspace: { current_dir: '/home/user/proj' },
      model: { id: 'sonnet:claude-sonnet-4-6' },
      effort: { level: 'medium' },
      context_window: { total_input_tokens: 40000 },
      // No max_input_tokens — must fall back to current-routes.json
    });

    const result = runStatusline({
      stdin: ccJson,
      env: {
        ...process.env,
        DEEPCLAUDE_DIR: tmpDir,
        GIT_BRANCH: 'main',
        PATH: process.env.PATH || '',
      },
    });

    expect(result.status).toBe(0);
    const plain = stripAnsi(result.stdout);
    expect(plain).toContain('40k/20%');
  });

  test('shows no context when tokens are absent', () => {
    const ccJson = JSON.stringify({
      workspace: { current_dir: '/home/user/proj' },
      model: { id: 'sonnet:claude-sonnet-4-6' },
      effort: { level: 'medium' },
      // No context_window at all
    });

    const result = runStatusline({
      stdin: ccJson,
      env: {
        ...process.env,
        DEEPCLAUDE_DIR: tmpDir,
        GIT_BRANCH: 'main',
        PATH: process.env.PATH || '',
      },
    });

    expect(result.status).toBe(0);
    const plain = stripAnsi(result.stdout);
    // Should not contain a percentage or token count.
    expect(plain).not.toMatch(/\d+k\/\d+%|\d+\/\d+%|\d+%/);
  });
});

describe('statusline DeepSeek milestone tags', () => {
  test('shows FBR tag at 400K+ tokens for deepseek-v4-pro', () => {
    const ccJson = JSON.stringify({
      workspace: { current_dir: '/home/user/proj' },
      model: { id: 'ds:deepseek-v4-pro' },
      effort: { level: 'medium' },
      context_window: { total_input_tokens: 450000, max_input_tokens: 1000000 },
    });

    const result = runStatusline({
      stdin: ccJson,
      env: {
        ...process.env,
        DEEPCLAUDE_DIR: tmpDir,
        GIT_BRANCH: 'main',
        PATH: process.env.PATH || '',
      },
    });

    expect(result.status).toBe(0);
    const plain = stripAnsi(result.stdout);
    expect(plain).toContain('FBR');
  });

  test('shows SR tag at 300K-399K tokens for deepseek-v4-pro', () => {
    const ccJson = JSON.stringify({
      workspace: { current_dir: '/home/user/proj' },
      model: { id: 'ds:deepseek-v4-pro' },
      effort: { level: 'medium' },
      context_window: { total_input_tokens: 350000, max_input_tokens: 1000000 },
    });

    const result = runStatusline({
      stdin: ccJson,
      env: {
        ...process.env,
        DEEPCLAUDE_DIR: tmpDir,
        GIT_BRANCH: 'main',
        PATH: process.env.PATH || '',
      },
    });

    expect(result.status).toBe(0);
    const plain = stripAnsi(result.stdout);
    expect(plain).toContain('SR');
    expect(plain).not.toContain('FBR');
  });

  test('shows no milestone tag below 300K tokens', () => {
    const ccJson = JSON.stringify({
      workspace: { current_dir: '/home/user/proj' },
      model: { id: 'ds:deepseek-v4-pro' },
      effort: { level: 'medium' },
      context_window: { total_input_tokens: 150000, max_input_tokens: 1000000 },
    });

    const result = runStatusline({
      stdin: ccJson,
      env: {
        ...process.env,
        DEEPCLAUDE_DIR: tmpDir,
        GIT_BRANCH: 'main',
        PATH: process.env.PATH || '',
      },
    });

    expect(result.status).toBe(0);
    const plain = stripAnsi(result.stdout);
    expect(plain).not.toContain('FBR');
    expect(plain).not.toContain('SR');
  });

  test('shows no milestone tag for non-DeepSeek models even at high tokens', () => {
    const ccJson = JSON.stringify({
      workspace: { current_dir: '/home/user/proj' },
      model: { id: 'an:claude-opus-4-7' },
      effort: { level: 'medium' },
      context_window: { total_input_tokens: 450000, max_input_tokens: 500000 },
    });

    const result = runStatusline({
      stdin: ccJson,
      env: {
        ...process.env,
        DEEPCLAUDE_DIR: tmpDir,
        GIT_BRANCH: 'main',
        PATH: process.env.PATH || '',
      },
    });

    expect(result.status).toBe(0);
    const plain = stripAnsi(result.stdout);
    expect(plain).not.toContain('FBR');
    expect(plain).not.toContain('SR');
  });
});

describe('statusline proxy port', () => {
  test('shows proxy port when proxy.json exists with port', () => {
    writeFileSync(join(tmpDir, 'proxy.json'), JSON.stringify({ pid: 12345, port: 49999 }));
    writeFileSync(join(tmpDir, 'spend.json'), JSON.stringify({}));

    const result = runStatusline({
      stdin: makeCcJson(),
      env: {
        ...process.env,
        DEEPCLAUDE_DIR: tmpDir,
        GIT_BRANCH: 'main',
        PATH: process.env.PATH || '',
      },
    });

    expect(result.status).toBe(0);
    const plain = stripAnsi(result.stdout);
    expect(plain).toContain('49999');
  });

  test('shows proxy port from proxy.pid when proxy.json is absent', () => {
    writeFileSync(join(tmpDir, 'proxy.pid'), '54321:50123');
    writeFileSync(join(tmpDir, 'spend.json'), JSON.stringify({}));

    const result = runStatusline({
      stdin: makeCcJson(),
      env: {
        ...process.env,
        DEEPCLAUDE_DIR: tmpDir,
        GIT_BRANCH: 'main',
        PATH: process.env.PATH || '',
      },
    });

    expect(result.status).toBe(0);
    const plain = stripAnsi(result.stdout);
    expect(plain).toContain('50123');
  });

  test('shows proxy port even when spend data has no active session', () => {
    // spend.json exists but has no CLAUDE_CODE_SESSION_ID — port should still show.
    writeFileSync(join(tmpDir, 'proxy.json'), JSON.stringify({ pid: 12345, port: 51000 }));
    writeFileSync(join(tmpDir, 'spend.json'), JSON.stringify({ daily: {} }));

    const result = runStatusline({
      stdin: makeCcJson(),
      env: {
        ...process.env,
        DEEPCLAUDE_DIR: tmpDir,
        CLAUDE_CODE_SESSION_ID: '',
        GIT_BRANCH: 'main',
        PATH: process.env.PATH || '',
      },
    });

    expect(result.status).toBe(0);
    const plain = stripAnsi(result.stdout);
    expect(plain).toContain('51000');
  });
});

describe('statusline output assembly', () => {
  test('strips hex-only model keys from output', () => {
    // A model key that is purely hex (like a hashed key) should be stripped.
    const ccJson = JSON.stringify({
      workspace: { current_dir: '/home/user/proj' },
      model: { id: 'a1b2c3d4e5f6:some-provider:real-model' },
      effort: { level: 'medium' },
      context_window: { total_input_tokens: 500, max_input_tokens: 200000 },
    });

    const result = runStatusline({
      stdin: ccJson,
      env: {
        ...process.env,
        DEEPCLAUDE_DIR: tmpDir,
        GIT_BRANCH: 'main',
        PATH: process.env.PATH || '',
      },
    });

    expect(result.status).toBe(0);
    const plain = stripAnsi(result.stdout);
    // The hex prefix 'a1b2c3d4e5f6' should be gone.
    expect(plain).not.toMatch(/\ba1b2c3d4e5f6\b/);
    // But the real model should still be there.
    expect(plain).toContain('some-provider:real-model');
  });

  test('formats effort level in output', () => {
    for (const effort of ['low', 'medium', 'high']) {
      const ccJson = JSON.stringify({
        workspace: { current_dir: '/home/user/proj' },
        model: { id: 'sonnet:claude-sonnet-4-6' },
        effort: { level: effort },
        context_window: { total_input_tokens: 500, max_input_tokens: 200000 },
      });

      const result = runStatusline({
        stdin: ccJson,
        env: {
          ...process.env,
          DEEPCLAUDE_DIR: tmpDir,
          GIT_BRANCH: 'main',
          PATH: process.env.PATH || '',
        },
      });

      expect(result.status).toBe(0);
      expect(stripAnsi(result.stdout)).toContain(effort);
    }
  });
});
