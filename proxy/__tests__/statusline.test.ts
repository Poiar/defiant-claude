'use strict';

// Test statusline.mjs spend rendering — specifically the session-spend
// fallback bug where a missing cc-spend-<sessionId>.json would show the
// proxy's global total instead of $0.00.
//
// Tests spawn the statusline script with controlled env vars and a
// temp DEEPCLAUDE_DIR, same pattern as launcher.test.ts.

import { spawnSync } from 'child_process';
import { join } from 'path';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';

const STATUSLINE = join(__dirname, '..', '..', 'statusline', 'statusline.mjs');

// ── helpers ────────────────────────────────────────────────────────

/** CC JSON the harness pipes to the statusline on each render. */
const MOCK_CC_JSON = JSON.stringify({
  workspace: { current_dir: '/home/user/test-project' },
  model: { id: 'sonnet:claude-sonnet-4-6', display_name: 'Sonnet 4.6' },
  effort: { level: 'medium' },
  context_window: { total_input_tokens: 12000, max_input_tokens: 200000 },
});

interface SpawnOpts {
  env: Record<string, string>;
  stdin?: string;
  timeout?: number;
}

function runStatusline(opts: SpawnOpts): { stdout: string; stderr: string; status: number } {
  // Pipe CC JSON via stdin — the statusline reads it with its readStdin().
  // .mjs extension tells Node this is ESM; no --input-type flag needed.
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

/** Strip ANSI escape sequences so we can assert on plain text. */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/** Extract all dollar amounts. */
function allDollars(s: string): number[] {
  const matches = s.match(/\$(\d+\.\d{2})/g);
  return (matches || []).map((m) => parseFloat(m.replace('$', '')));
}

/** Today's date key in ISO format (YYYY-MM-DD), matching stats.ts todayISO(). */
const d = new Date();
const todayKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// ── setup / teardown ───────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = join(
    tmpdir(),
    `deepclaude-statusline-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

// ── tests ──────────────────────────────────────────────────────────

describe('statusline spend display', () => {
  // ── scenario A: fresh session, no cc-spend file ──────────────

  test('shows $0.00 for session spend when cc-spend file is missing (no fallback to proxy total)', () => {
    const spendJson = {
      total: 0.1,
      sessions: [{ total: 0.1 }],
      daily: { [todayKey]: { total: 0.05 } },
    };
    writeFileSync(join(tmpDir, 'spend.json'), JSON.stringify(spendJson));

    const result = runStatusline({
      stdin: MOCK_CC_JSON,
      env: {
        ...process.env,
        DEEPCLAUDE_DIR: tmpDir,
        CLAUDE_CODE_SESSION_ID: 'test-session-fresh',
        GIT_BRANCH: 'main',
        PATH: process.env.PATH || '',
      },
    });

    expect(result.status).toBe(0);
    const plain = stripAnsi(result.stdout);

    // Should show $0.00 for session (NOT $0.10 which was the bug).
    const dollars = allDollars(plain);
    expect(dollars).toContain(0.0);
    expect(dollars).not.toContain(0.1);
    // Should show $0.05 for today.
    expect(dollars).toContain(0.05);
  });

  // ── scenario B: session with existing spend ─────────────────

  test('shows actual session spend when cc-spend file exists', () => {
    const spendJson = {
      total: 0.25,
      sessions: [{ total: 0.07 }],
      daily: { [todayKey]: { total: 0.12 } },
    };
    writeFileSync(join(tmpDir, 'spend.json'), JSON.stringify(spendJson));
    writeFileSync(join(tmpDir, 'cc-spend-test-session-active.json'), '0.07');

    const result = runStatusline({
      stdin: MOCK_CC_JSON,
      env: {
        ...process.env,
        DEEPCLAUDE_DIR: tmpDir,
        CLAUDE_CODE_SESSION_ID: 'test-session-active',
        GIT_BRANCH: 'main',
        PATH: process.env.PATH || '',
      },
    });

    expect(result.status).toBe(0);
    const plain = stripAnsi(result.stdout);

    const dollars = allDollars(plain);
    expect(dollars).toContain(0.07); // session
    expect(dollars).toContain(0.12); // today
    expect(dollars).not.toContain(0.25); // NOT proxy total
  });

  // ── scenario C: no CLAUDE_CODE_SESSION_ID env var ───────────

  test('omits session spend when no CLAUDE_CODE_SESSION_ID is set', () => {
    const spendJson = {
      total: 0.1,
      daily: { [todayKey]: { total: 0.08 } },
    };
    writeFileSync(join(tmpDir, 'spend.json'), JSON.stringify(spendJson));

    const result = runStatusline({
      stdin: MOCK_CC_JSON,
      env: {
        ...process.env,
        DEEPCLAUDE_DIR: tmpDir,
        CLAUDE_CODE_SESSION_ID: '', // explicitly unset — no active session
        GIT_BRANCH: 'main',
        PATH: process.env.PATH || '',
      },
    });

    expect(result.status).toBe(0);
    const plain = stripAnsi(result.stdout);

    const dollars = allDollars(plain);
    // Only today's spend, no session spend.
    expect(dollars).toEqual([0.08]);
    expect(dollars).not.toContain(0.1);
  });

  // ── scenario D: no spend data at all ────────────────────────

  test('shows no spend when spend.json is absent', () => {
    const result = runStatusline({
      stdin: MOCK_CC_JSON,
      env: {
        ...process.env,
        DEEPCLAUDE_DIR: tmpDir,
        CLAUDE_CODE_SESSION_ID: 'test-no-spend',
        GIT_BRANCH: 'main',
        PATH: process.env.PATH || '',
      },
    });

    expect(result.status).toBe(0);
    const plain = stripAnsi(result.stdout);

    // No dollar amounts at all.
    expect(allDollars(plain)).toEqual([]);
  });

  // ── scenario E: only today spend, no sessions array ─────────

  test('shows $0.00 session + today when only daily data exists', () => {
    const spendJson = {
      daily: { [todayKey]: { total: 0.03 } },
    };
    writeFileSync(join(tmpDir, 'spend.json'), JSON.stringify(spendJson));

    const result = runStatusline({
      stdin: MOCK_CC_JSON,
      env: {
        ...process.env,
        DEEPCLAUDE_DIR: tmpDir,
        CLAUDE_CODE_SESSION_ID: 'test-session-only-daily',
        GIT_BRANCH: 'main',
        PATH: process.env.PATH || '',
      },
    });

    expect(result.status).toBe(0);
    const plain = stripAnsi(result.stdout);

    const dollars = allDollars(plain);
    expect(dollars).toContain(0.0); // session
    expect(dollars).toContain(0.03); // today
  });
});
