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

function allDollars(s: string): number[] {
  const matches = s.match(/\$(\d+\.\d{2})/g);
  return (matches || []).map((m) => parseFloat(m.replace('$', '')));
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
  // Helper: write current-routes.json so ctxMap is populated for milestone checks.
  function writeRoutes(contextLimits: Record<string, number>): void {
    writeFileSync(join(tmpDir, 'current-routes.json'), JSON.stringify({ contextLimits }));
  }

  test('shows FBR tag at 400K+ tokens for deepseek-v4-pro', () => {
    writeRoutes({ 'deepseek-v4-pro': 1048576 });
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
    // FBR tagged red: fg(255, 80, 80)
    expect(result.stdout).toContain('38;2;255;80;80mFBR');
  });

  test('shows SR tag at 300K-399K tokens for deepseek-v4-pro', () => {
    writeRoutes({ 'deepseek-v4-pro': 1048576 });
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
    // SR uses orange: fg(255, 180, 50)
    expect(result.stdout).toContain('38;2;255;180;50mSR');
  });

  test('shows no milestone tag below 300K tokens', () => {
    writeRoutes({ 'deepseek-v4-pro': 1048576 });
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
    expect(plain).not.toContain('FR');
  });

  test('shows no milestone tag for models with <1M context even at high tokens', () => {
    writeRoutes({ 'claude-opus-4-7': 200000 });
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
    expect(plain).not.toContain('FR');
  });

  test('shows FBR tag at 400K+ tokens for deepseek-v4-flash', () => {
    writeRoutes({ 'deepseek-v4-flash': 1048576 });
    const ccJson = JSON.stringify({
      workspace: { current_dir: '/home/user/proj' },
      model: { id: 'ds:deepseek-v4-flash' },
      effort: { level: 'medium' },
      context_window: { total_input_tokens: 420000, max_input_tokens: 1000000 },
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
    expect(result.stdout).toContain('38;2;255;80;80mFBR');
  });

  test('shows SR tag at 300K-399K tokens for deepseek-v4-flash', () => {
    writeRoutes({ 'deepseek-v4-flash': 1048576 });
    const ccJson = JSON.stringify({
      workspace: { current_dir: '/home/user/proj' },
      model: { id: 'ds:deepseek-v4-flash' },
      effort: { level: 'medium' },
      context_window: { total_input_tokens: 310000, max_input_tokens: 1000000 },
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

  test('shows FBR tag at 400K+ tokens for gemini-2.5-flash', () => {
    writeRoutes({ 'gemini-2.5-flash': 1048576 });
    const ccJson = JSON.stringify({
      workspace: { current_dir: '/home/user/proj' },
      model: { id: 'gm:gemini-2.5-flash' },
      effort: { level: 'medium' },
      context_window: { total_input_tokens: 500000, max_input_tokens: 1000000 },
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

  test('no milestone tag when modelLookup is missing from ctxMap', () => {
    // Model not in ctxMap → ctxMap[modelLookup] is undefined → no tags.
    writeRoutes({ 'some-other-model': 1048576 });
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
    expect(plain).not.toContain('FBR');
    expect(plain).not.toContain('SR');
  });
});

describe('statusline proxy port', () => {
  test('shows proxy port from ANTHROPIC_BASE_URL', () => {
    writeFileSync(join(tmpDir, 'spend.json'), JSON.stringify({}));

    const result = runStatusline({
      stdin: makeCcJson(),
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:49999',
        DEEPCLAUDE_DIR: tmpDir,
        GIT_BRANCH: 'main',
        PATH: process.env.PATH || '',
      },
    });

    expect(result.status).toBe(0);
    const plain = stripAnsi(result.stdout);
    expect(plain).toContain('49999');
  });

  test('shows proxy port from DEEPCLAUDE_PROXY_PORT fallback', () => {
    writeFileSync(join(tmpDir, 'spend.json'), JSON.stringify({}));

    const result = runStatusline({
      stdin: makeCcJson(),
      env: {
        ...process.env,
        DEEPCLAUDE_PROXY_PORT: '50123',
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
    writeFileSync(join(tmpDir, 'spend.json'), JSON.stringify({ daily: {} }));

    const result = runStatusline({
      stdin: makeCcJson(),
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:51000',
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

describe('statusline output format', () => {
  test('all group separators are single spaces — no consecutive spaces', () => {
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
    // CC renders 2+ consecutive spaces as · (visible dot).
    expect(stripAnsi(result.stdout)).not.toMatch(/\s{2,}/);
  });

  test('output follows deepclaude <branch> <slot> <model> <effort> <context> <$session> <$today> <port>', () => {
    const d2 = new Date();
    const todayKey = `${d2.getFullYear()}-${String(d2.getMonth() + 1).padStart(2, '0')}-${String(d2.getDate()).padStart(2, '0')}`;
    const spendJson = {
      daily: {
        [todayKey]: {
          total: 1.23,
          byProvider: { ds: 1.23 },
        },
      },
    };
    writeFileSync(join(tmpDir, 'spend.json'), JSON.stringify(spendJson));
    writeFileSync(
      join(tmpDir, 'slot-overrides.json'),
      JSON.stringify({ fable: 'ds:deepseek-v4-pro' }),
    );
    writeFileSync(join(tmpDir, 'cc-spend-test-fmt.json'), '0.45');

    const ccJson = JSON.stringify({
      workspace: { current_dir: '/home/user/deepclaude' },
      model: { id: 'fable:deepseek-v4-pro' },
      effort: { level: 'max' },
      context_window: { total_input_tokens: 91000, max_input_tokens: 1000000 },
    });

    const result = runStatusline({
      stdin: ccJson,
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:50000',
        DEEPCLAUDE_DIR: tmpDir,
        CLAUDE_CODE_SESSION_ID: 'test-fmt',
        GIT_BRANCH: 'main',
        PATH: process.env.PATH || '',
      },
    });

    expect(result.status).toBe(0);
    const plain = stripAnsi(result.stdout);
    // Rough structure: dir branch slot model effort context $session $today port
    // Exact match: deepclaude main f ds:deepseek-v4-pro max 91k/9% $0.45 $1.23 50000
    expect(plain).toBe('deepclaude main f ds:deepseek-v4-pro max 91k/9% $0.45 $1.23 50000');
  });

  test('no doubled spaces when spend group has only session (today is 0)', () => {
    const d2 = new Date();
    const todayKey = `${d2.getFullYear()}-${String(d2.getMonth() + 1).padStart(2, '0')}-${String(d2.getDate()).padStart(2, '0')}`;
    writeFileSync(
      join(tmpDir, 'spend.json'),
      JSON.stringify({ daily: { [todayKey]: { total: 0 } } }),
    );
    writeFileSync(join(tmpDir, 'cc-spend-test-no-today.json'), '0.45');

    const result = runStatusline({
      stdin: makeCcJson(),
      env: {
        ...process.env,
        DEEPCLAUDE_DIR: tmpDir,
        CLAUDE_CODE_SESSION_ID: 'test-no-today',
        GIT_BRANCH: 'main',
        PATH: process.env.PATH || '',
      },
    });

    expect(result.status).toBe(0);
    // No doubled spaces.
    expect(stripAnsi(result.stdout)).not.toMatch(/\s{2,}/);
  });

  test('no doubled spaces when only proxy port (no spend data at all)', () => {
    // No spend.json — spend group should have only the port.

    const result = runStatusline({
      stdin: makeCcJson(),
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:50000',
        DEEPCLAUDE_DIR: tmpDir,
        GIT_BRANCH: 'main',
        PATH: process.env.PATH || '',
      },
    });

    expect(result.status).toBe(0);
    expect(stripAnsi(result.stdout)).not.toMatch(/\s{2,}/);
    // Port should appear in output even without spend.json
    expect(stripAnsi(result.stdout)).toContain('50000');
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

  test('effort level colors: max/high=red, medium=yellow, low=blue', () => {
    const cases: [string, string][] = [
      ['max', '38;2;255;80;80'],
      ['high', '38;2;255;80;80'],
      ['medium', '38;2;255;180;50'],
      ['low', '38;2;100;160;255'],
    ];
    for (const [level, color] of cases) {
      const ccJson = JSON.stringify({
        workspace: { current_dir: '/home/user/proj' },
        model: { id: 'an:claude-opus-4-7' },
        effort: { level },
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
      expect(result.stdout).toContain(color + 'm' + level);
    }
  });
});

describe('statusline model display_name fallback', () => {
  test('falls back to display_name when model.id is absent', () => {
    const ccJson = JSON.stringify({
      workspace: { current_dir: '/home/user/proj' },
      model: { display_name: 'Fancy Display Model' },
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
    expect(stripAnsi(result.stdout)).toContain('Fancy Display Model');
  });

  test('no model slot label when model does not match a known slot prefix', () => {
    const ccJson = JSON.stringify({
      workspace: { current_dir: '/home/user/proj' },
      model: { id: 'ds:deepseek-v4-pro' },
      effort: { level: 'medium' },
      context_window: { total_input_tokens: 500, max_input_tokens: 200000 },
    });

    // slot-overrides.json exists but "ds:deepseek-v4-pro" doesn't start with a slot prefix
    // like "sonnet:", "opus:", etc. — so no slotLabel is added.
    writeFileSync(
      join(tmpDir, 'slot-overrides.json'),
      JSON.stringify({ sonnet: 'an:claude-sonnet-4-6' }),
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
    // Shows the model id as-is, no "s " or "f " prefix.
    expect(plain).toContain('ds:deepseek-v4-pro');
  });
});

describe('statusline slot variants', () => {
  test('shows "o " label for opus slot', () => {
    writeFileSync(
      join(tmpDir, 'slot-overrides.json'),
      JSON.stringify({ opus: 'an:claude-opus-4-7' }),
    );
    const ccJson = JSON.stringify({
      workspace: { current_dir: '/home/user/proj' },
      model: { id: 'opus:claude-opus-4-7' },
      effort: { level: 'high' },
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
    expect(plain).toContain('an:claude-opus-4-7');
  });

  test('shows "h " label for haiku slot', () => {
    writeFileSync(
      join(tmpDir, 'slot-overrides.json'),
      JSON.stringify({ haiku: 'an:claude-haiku-4-5' }),
    );
    const ccJson = JSON.stringify({
      workspace: { current_dir: '/home/user/proj' },
      model: { id: 'haiku:claude-haiku-4-5' },
      effort: { level: 'low' },
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
    expect(plain).toContain('an:claude-haiku-4-5');
  });

  test('subagent slot without override and without subagent-model.json keeps fallback', () => {
    // slot-overrides.json has no sub/subagent key, and subagent-model.json doesn't exist.
    writeFileSync(
      join(tmpDir, 'slot-overrides.json'),
      JSON.stringify({ sonnet: 'ds:deepseek-v4-pro' }),
    );

    const ccJson = JSON.stringify({
      workspace: { current_dir: '/home/user/proj' },
      model: { id: 'sub:claude-haiku-4-5' },
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
    // The fallback from the slot match is "claude-haiku-4-5" (the part after "sub:").
    const plain = stripAnsi(result.stdout);
    expect(plain).toContain('claude-haiku-4-5');
  });

  test('subagent-model.json without providerKey does not override', () => {
    writeFileSync(join(tmpDir, 'slot-overrides.json'), JSON.stringify({}));
    writeFileSync(join(tmpDir, 'subagent-model.json'), JSON.stringify({ modelId: 'some-model' }));

    const ccJson = JSON.stringify({
      workspace: { current_dir: '/home/user/proj' },
      model: { id: 'sub:claude-haiku-4-5' },
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
    // Falls back to the original model from the slot match, not subagent-model.json.
    expect(plain).toContain('claude-haiku-4-5');
  });
});

describe('statusline context window edge cases', () => {
  test('shows red color at >= 80% context', () => {
    const ccJson = JSON.stringify({
      workspace: { current_dir: '/home/user/proj' },
      model: { id: 'sonnet:claude-sonnet-4-6' },
      effort: { level: 'medium' },
      context_window: { total_input_tokens: 170000, max_input_tokens: 200000 },
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
    // 85% → red
    expect(result.stdout).toContain('38;2;255;80;80');
  });

  test('shows yellow color at 50%-79% context', () => {
    const ccJson = JSON.stringify({
      workspace: { current_dir: '/home/user/proj' },
      model: { id: 'sonnet:claude-sonnet-4-6' },
      effort: { level: 'medium' },
      context_window: { total_input_tokens: 120000, max_input_tokens: 200000 },
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
    // 60% → yellow
    expect(result.stdout).toContain('38;2;255;180;50');
  });

  test('shows green color at < 50% context', () => {
    const ccJson = JSON.stringify({
      workspace: { current_dir: '/home/user/proj' },
      model: { id: 'sonnet:claude-sonnet-4-6' },
      effort: { level: 'medium' },
      context_window: { total_input_tokens: 40000, max_input_tokens: 200000 },
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
    // 20% → green
    expect(result.stdout).toContain('38;2;80;200;120');
  });

  test('no percentage when max_input_tokens is 0', () => {
    const ccJson = JSON.stringify({
      workspace: { current_dir: '/home/user/proj' },
      model: { id: 'sonnet:claude-sonnet-4-6' },
      effort: { level: 'medium' },
      context_window: { total_input_tokens: 5000, max_input_tokens: 0 },
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
    // Tokens shown but no percentage.
    expect(plain).toContain('5k');
    expect(plain).not.toMatch(/\d+%/);
  });

  test('no percentage when tokens exceed max_tokens (subagent / fallback model mismatch)', () => {
    // When a subagent or fallback model has a smaller context window than
    // the accumulated conversation, CC may report max_input_tokens smaller
    // than total_input_tokens. The raw percentage would be >100% — nonsense.
    // The statusline should suppress the percentage and show only token count.
    const ccJson = JSON.stringify({
      workspace: { current_dir: '/home/user/proj' },
      model: { id: 'sub:some-small-model' },
      effort: { level: 'medium' },
      context_window: { total_input_tokens: 230000, max_input_tokens: 80000 },
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
    // Token count should appear.
    expect(plain).toContain('230k');
    // But NO percentage — 230K / 80K = 288%, suppressed.
    expect(plain).not.toMatch(/\d+%/);
  });
});

describe('statusline modelLookup [1m] suffix stripping', () => {
  test('strips [1m] suffix for DS milestone matching', () => {
    // When the model has a [1m] flag, modelLookup should strip it so
    // 'deepseek-v4-pro[1m]' → 'deepseek-v4-pro' for milestone tag matching.
    writeFileSync(
      join(tmpDir, 'current-routes.json'),
      JSON.stringify({ contextLimits: { 'deepseek-v4-pro': 1048576 } }),
    );
    const ccJson = JSON.stringify({
      workspace: { current_dir: '/home/user/proj' },
      model: { id: 'ds:deepseek-v4-pro[1m]' },
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
    // 450K with [1m] model should still trigger FBR.
    expect(plain).toContain('FBR');
  });

  test('OR path models now match via ctxMap (not literal string comparison)', () => {
    // With the old literal 'deepseek-v4-pro' comparison, OR paths like
    // 'deepseek/deepseek-v4-pro' wouldn't match. The new ctxMap-based check
    // looks up the context limit, so OR models with ≥1M context get tags too.
    writeFileSync(
      join(tmpDir, 'current-routes.json'),
      JSON.stringify({ contextLimits: { 'deepseek/deepseek-v4-pro': 1048576 } }),
    );
    const ccJson = JSON.stringify({
      workspace: { current_dir: '/home/user/proj' },
      model: { id: 'or:deepseek/deepseek-v4-pro[500k]' },
      effort: { level: 'medium' },
      context_window: { total_input_tokens: 350000, max_input_tokens: 500000 },
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
    // [500k] is stripped from modelLookup → 'deepseek/deepseek-v4-pro'
    // ctxMap lookup finds 1048576 ≥ 1M → milestone active → SR at 350K.
    expect(plain).toContain('SR');
  });
});

describe('statusline malformed / missing file resilience', () => {
  test('survives malformed spend.json without crashing', () => {
    writeFileSync(join(tmpDir, 'spend.json'), 'not valid json {{{');

    const result = runStatusline({
      stdin: makeCcJson(),
      env: {
        ...process.env,
        DEEPCLAUDE_DIR: tmpDir,
        CLAUDE_CODE_SESSION_ID: 'test-malformed',
        GIT_BRANCH: 'main',
        PATH: process.env.PATH || '',
      },
    });

    expect(result.status).toBe(0);
    // No spend shown.
    expect(allDollars(stripAnsi(result.stdout))).toEqual([]);
  });

  test('survives malformed slot-overrides.json without crashing', () => {
    writeFileSync(join(tmpDir, 'slot-overrides.json'), 'garbage');

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
    // Still renders normally, just without slot label.
    expect(stripAnsi(result.stdout)).toContain('sonnet:claude-sonnet-4-6');
  });

  test('survives malformed current-routes.json without crashing', () => {
    writeFileSync(join(tmpDir, 'current-routes.json'), '{bad');

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
    expect(stripAnsi(result.stdout)).toContain('500/0%');
  });

  test('survives missing slot-overrides.json gracefully', () => {
    // No slot-overrides.json at all — model should be shown as-is.
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
    expect(stripAnsi(result.stdout)).toContain('sonnet:claude-sonnet-4-6');
  });

  test('cc-spend file with garbage content falls back to 0', () => {
    const d2 = new Date();
    const todayKey = `${d2.getFullYear()}-${String(d2.getMonth() + 1).padStart(2, '0')}-${String(d2.getDate()).padStart(2, '0')}`;
    const spendJson = { daily: { [todayKey]: { total: 0.05 } } };
    writeFileSync(join(tmpDir, 'spend.json'), JSON.stringify(spendJson));
    writeFileSync(join(tmpDir, 'cc-spend-test-garbage.json'), 'not-a-number');

    const result = runStatusline({
      stdin: makeCcJson(),
      env: {
        ...process.env,
        DEEPCLAUDE_DIR: tmpDir,
        CLAUDE_CODE_SESSION_ID: 'test-garbage',
        GIT_BRANCH: 'main',
        PATH: process.env.PATH || '',
      },
    });

    expect(result.status).toBe(0);
    const dollars = allDollars(stripAnsi(result.stdout));
    // garbage → parseFloat(NaN) → || 0 → $0.00 session + $0.05 today
    expect(dollars).toContain(0.0);
    expect(dollars).toContain(0.05);
  });

  test('today spend of exactly 0 is not shown', () => {
    const d2 = new Date();
    const todayKey = `${d2.getFullYear()}-${String(d2.getMonth() + 1).padStart(2, '0')}-${String(d2.getDate()).padStart(2, '0')}`;
    const spendJson = { daily: { [todayKey]: { total: 0 } } };
    writeFileSync(join(tmpDir, 'spend.json'), JSON.stringify(spendJson));

    const result = runStatusline({
      stdin: makeCcJson(),
      env: {
        ...process.env,
        DEEPCLAUDE_DIR: tmpDir,
        CLAUDE_CODE_SESSION_ID: 'test-zero-today',
        GIT_BRANCH: 'main',
        PATH: process.env.PATH || '',
      },
    });

    expect(result.status).toBe(0);
    const dollars = allDollars(stripAnsi(result.stdout));
    // Only $0.00 session spend, no $0.00 for today.
    expect(dollars).toEqual([0.0]);
  });
});

describe('statusline stdin edge cases', () => {
  test('empty stdin produces no output', () => {
    const result = runStatusline({
      stdin: '',
      env: {
        ...process.env,
        DEEPCLAUDE_DIR: tmpDir,
        GIT_BRANCH: 'main',
        PATH: process.env.PATH || '',
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });

  test('invalid JSON on stdin produces no output', () => {
    const result = runStatusline({
      stdin: 'not json at all {{{',
      env: {
        ...process.env,
        DEEPCLAUDE_DIR: tmpDir,
        GIT_BRANCH: 'main',
        PATH: process.env.PATH || '',
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });
});

describe('statusline proxy config edge cases', () => {
  test('missing ANTHROPIC_BASE_URL shows no proxy port', () => {
    writeFileSync(join(tmpDir, 'spend.json'), JSON.stringify({}));

    const {
      ANTHROPIC_BASE_URL: _u1,
      ANTHROPIC_DEFAULT_OPUS_MODEL: _u2,
      CLAUDE_CODE_SUBAGENT_MODEL: _u3,
      ANTHROPIC_AUTH_TOKEN: _u4,
      ANTHROPIC_MODEL: _u5,
      ...cleanEnv
    } = process.env;
    const result = runStatusline({
      stdin: makeCcJson(),
      env: {
        ...cleanEnv,
        DEEPCLAUDE_DIR: tmpDir,
        GIT_BRANCH: 'main',
        PATH: process.env.PATH || '',
      },
    });

    expect(result.status).toBe(0);
    const plain = stripAnsi(result.stdout);
    expect(plain).not.toMatch(/\b\d{5}\b/); // no port number
  });

  test('ANTHROPIC_BASE_URL without port is ignored', () => {
    writeFileSync(join(tmpDir, 'spend.json'), JSON.stringify({}));

    const result = runStatusline({
      stdin: makeCcJson(),
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: 'http://127.0.0.1',
        DEEPCLAUDE_DIR: tmpDir,
        GIT_BRANCH: 'main',
        PATH: process.env.PATH || '',
      },
    });

    expect(result.status).toBe(0);
    const plain = stripAnsi(result.stdout);
    expect(plain).not.toMatch(/\b\d{5}\b/);
  });

  test('ANTHROPIC_BASE_URL with port 0 does not trigger health check or show port', () => {
    writeFileSync(join(tmpDir, 'spend.json'), JSON.stringify({}));

    const result = runStatusline({
      stdin: makeCcJson(),
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:0',
        DEEPCLAUDE_DIR: tmpDir,
        GIT_BRANCH: 'main',
        PATH: process.env.PATH || '',
      },
    });

    expect(result.status).toBe(0);
    const plain = stripAnsi(result.stdout);
    // No 5-digit port shown (session $0.00 is expected).
    expect(plain).not.toMatch(/\s\d{5}\b/);
  });

  test('ANTHROPIC_BASE_URL with valid port shows correctly', () => {
    writeFileSync(join(tmpDir, 'spend.json'), JSON.stringify({}));

    const result = runStatusline({
      stdin: makeCcJson(),
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:50999',
        DEEPCLAUDE_DIR: tmpDir,
        GIT_BRANCH: 'main',
        PATH: process.env.PATH || '',
      },
    });

    expect(result.status).toBe(0);
    const plain = stripAnsi(result.stdout);
    expect(plain).toContain('50999');
  });
});

describe('statusline cc-spend file edge cases', () => {
  test('cc-spend file that is empty string falls back to 0', () => {
    const d2 = new Date();
    const todayKey = `${d2.getFullYear()}-${String(d2.getMonth() + 1).padStart(2, '0')}-${String(d2.getDate()).padStart(2, '0')}`;
    const spendJson = { daily: { [todayKey]: { total: 0.05 } } };
    writeFileSync(join(tmpDir, 'spend.json'), JSON.stringify(spendJson));
    writeFileSync(join(tmpDir, 'cc-spend-test-empty.json'), '');

    const result = runStatusline({
      stdin: makeCcJson(),
      env: {
        ...process.env,
        DEEPCLAUDE_DIR: tmpDir,
        CLAUDE_CODE_SESSION_ID: 'test-empty',
        GIT_BRANCH: 'main',
        PATH: process.env.PATH || '',
      },
    });

    expect(result.status).toBe(0);
    const dollars = allDollars(stripAnsi(result.stdout));
    // empty → parseFloat('') → NaN → || 0 → $0.00
    expect(dollars).toContain(0.0);
    expect(dollars).toContain(0.05);
  });
});

describe('statusline missing optional fields in CC JSON', () => {
  test('missing model.id and display_name shows no model', () => {
    const ccJson = JSON.stringify({
      workspace: { current_dir: '/home/user/proj' },
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
    // Has location, effort, context, but no model string.
    expect(plain).toContain('proj');
    expect(plain).toContain('medium');
    expect(plain).toContain('500');
  });

  test('missing effort level shows no effort', () => {
    const ccJson = JSON.stringify({
      workspace: { current_dir: '/home/user/proj' },
      model: { id: 'sonnet:claude-sonnet-4-6' },
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
    expect(plain).not.toContain('medium');
    expect(plain).not.toContain('high');
    expect(plain).not.toContain('low');
  });
});
