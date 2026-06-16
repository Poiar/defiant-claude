'use strict';

import * as fs from 'fs';
import * as path from 'path';

// ── Extract patterns from the PowerShell hook ────────────────────────────

interface HookPatterns {
  allow: string[];
  block: string[];
}

function extractPatterns(): HookPatterns {
  const script = fs.readFileSync(
    path.resolve(__dirname, '../../.claude/hooks/proxy-guard.ps1'),
    'utf-8',
  );

  function extractArray(name: string): string[] {
    // Find the array start: $NAME = @(
    const startRe = new RegExp('\\$' + name + '\\s*=\\s*@\\(');
    const startM = script.match(startRe);
    if (!startM || startM.index === undefined) {
      throw new Error('Could not find $' + name + ' array in proxy-guard.ps1');
    }
    const startIdx = startM.index + startM[0].length;

    // Find matching close paren — patterns may contain ( ) inside regex groups
    let depth = 1;
    let endIdx = startIdx;
    for (let i = startIdx; i < script.length && depth > 0; i++) {
      if (script[i] === '(') depth++;
      else if (script[i] === ')') depth--;
      if (depth === 0) endIdx = i;
    }

    const body = script.substring(startIdx, endIdx);
    const patterns: string[] = [];
    const strRe = /'([^']*)'/g;
    let sm: RegExpExecArray | null;
    while ((sm = strRe.exec(body)) !== null) {
      if (sm[1].trim()) {
        patterns.push(sm[1]);
      }
    }
    return patterns;
  }

  return {
    allow: extractArray('ALLOW'),
    block: extractArray('BLOCK'),
  };
}

// Simulate the hook's full decision logic: ALLOW-list checked first.
function isBlocked(command: string, p: HookPatterns): boolean {
  const cmd = command.trim();

  // Step 1: check ALLOW list — these commands can't kill the proxy
  // even if their arguments contain blocked words
  for (const pat of p.allow) {
    try {
      if (new RegExp(pat, 'i').test(cmd)) return false;
    } catch {
      // skip invalid regex
    }
  }

  // Step 2: check BLOCK list
  for (const pat of p.block) {
    try {
      if (new RegExp(pat, 'i').test(cmd)) return true;
    } catch {
      // skip invalid regex
    }
  }

  return false;
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('proxy-guard.ps1 hook patterns', () => {
  let p: HookPatterns;

  beforeAll(() => {
    p = extractPatterns();
    if (p.block.length === 0) {
      throw new Error('No BLOCK patterns extracted from proxy-guard.ps1');
    }
  });

  // ── Structural ─────────────────────────────────────────────────────────
  test('hook script exists', () => {
    expect(fs.existsSync(path.resolve(__dirname, '../../.claude/hooks/proxy-guard.ps1'))).toBe(
      true,
    );
  });

  test('has ALLOW patterns', () => {
    expect(p.allow.length).toBeGreaterThan(0);
  });

  test('has BLOCK patterns', () => {
    expect(p.block.length).toBeGreaterThan(0);
  });

  test('all ALLOW patterns are valid regex', () => {
    for (const pat of p.allow) {
      expect(() => new RegExp(pat)).not.toThrow();
    }
  });

  test('all BLOCK patterns are valid regex', () => {
    for (const pat of p.block) {
      expect(() => new RegExp(pat)).not.toThrow();
    }
  });

  // ── Key BLOCK patterns exist ───────────────────────────────────────────
  test('has Stop-Process pattern', () => {
    expect(p.block.some((x) => x.includes('Stop-Process'))).toBe(true);
  });

  test('has taskkill pattern', () => {
    expect(p.block.some((x) => x.includes('taskkill'))).toBe(true);
  });

  test('has restart-proxy pattern', () => {
    expect(p.block.some((x) => x.includes('restart-proxy'))).toBe(true);
  });

  test('has PID kill pattern', () => {
    expect(p.block.some((x) => x.includes('kill'))).toBe(true);
  });

  // ── BLOCK: direct process killing ──────────────────────────────────────
  test('BLOCKS Stop-Process by PID (what killed the session)', () => {
    expect(isBlocked('Stop-Process -Id 41144 -Force', p)).toBe(true);
  });

  test('BLOCKS Stop-Process with -Name node', () => {
    expect(isBlocked('Stop-Process -Name node -Force', p)).toBe(true);
  });

  test('BLOCKS taskkill on node', () => {
    expect(isBlocked('taskkill /F /IM node.exe', p)).toBe(true);
  });

  test('BLOCKS killall node', () => {
    expect(isBlocked('killall node', p)).toBe(true);
  });

  // ── BLOCK: unix signal kills ───────────────────────────────────────────
  test('BLOCKS kill -9 by PID', () => {
    expect(isBlocked('kill -9 12345', p)).toBe(true);
  });

  test('BLOCKS kill with SIGKILL', () => {
    expect(isBlocked('kill -SIGKILL 9999', p)).toBe(true);
  });

  // ── BLOCK: proxy restart commands ──────────────────────────────────────
  test('BLOCKS restart-proxy', () => {
    expect(isBlocked('npm run restart-proxy', p)).toBe(true);
  });

  test('BLOCKS start-proxy', () => {
    expect(isBlocked('npx tsx proxy/start-proxy.ts --port 9999', p)).toBe(true);
  });

  // ── BLOCK: combined find-and-kill patterns ─────────────────────────────
  test('BLOCKS Get-Process + Stop-Process pipeline', () => {
    expect(isBlocked('Get-Process -Name node | Stop-Process -Force', p)).toBe(true);
  });

  test('BLOCKS Get-Process + kill pipeline', () => {
    expect(isBlocked('Get-Process -Name node | kill -9', p)).toBe(true);
  });

  // ── ALLOW: git commit (message may contain blocked words) ──────────────
  test('ALLOWS git commit with blocked words in message', () => {
    expect(
      isBlocked("git commit -m 'fix: harden proxy-guard against Stop-Process and taskkill'", p),
    ).toBe(false);
  });

  test('ALLOWS git add', () => {
    expect(isBlocked('git add proxy/__tests__/proxy-guard.test.ts', p)).toBe(false);
  });

  test('ALLOWS git push', () => {
    expect(isBlocked('git push', p)).toBe(false);
  });

  test('ALLOWS git diff', () => {
    expect(isBlocked('git diff HEAD~1', p)).toBe(false);
  });

  test('ALLOWS git log', () => {
    expect(isBlocked('git log --oneline -5', p)).toBe(false);
  });

  // ── ALLOW: echo with blocked words ─────────────────────────────────────
  test('ALLOWS echo with Stop-Process in text', () => {
    expect(isBlocked("echo 'Stop-Process is blocked'", p)).toBe(false);
  });

  // ── ALLOW: Write-* cmdlets (output, not killing) ───────────────────────
  test('ALLOWS Write-Output with blocked words', () => {
    expect(isBlocked("Write-Output 'taskkill was blocked'", p)).toBe(false);
  });

  test('ALLOWS Write-Host with blocked words', () => {
    expect(isBlocked("Write-Host 'Stop-Process test'", p)).toBe(false);
  });

  // ── ALLOW: safe commands ───────────────────────────────────────────────
  test('ALLOWS npm test', () => {
    expect(isBlocked('npm test', p)).toBe(false);
  });

  test('ALLOWS curl health check', () => {
    expect(isBlocked('curl -s http://127.0.0.1:52711/health', p)).toBe(false);
  });

  test('ALLOWS npx jest', () => {
    expect(isBlocked('npx jest proxy/__tests__/stats.test.ts', p)).toBe(false);
  });

  test('ALLOWS Get-Process without kill', () => {
    expect(isBlocked('Get-Process -Name node', p)).toBe(false);
  });

  test('ALLOWS Get-ChildItem', () => {
    expect(isBlocked('Get-ChildItem .claude/hooks/', p)).toBe(false);
  });

  test('ALLOWS Where-Object', () => {
    expect(isBlocked('Get-Process -Name node | Where-Object { $_.Id -gt 100 }', p)).toBe(false);
  });

  test('ALLOWS ForEach-Object', () => {
    expect(isBlocked('Get-Process -Name node | ForEach-Object { $_.Id }', p)).toBe(false);
  });

  test('ALLOWS Test-Path', () => {
    expect(isBlocked('Test-Path .claude/hooks/proxy-guard.ps1', p)).toBe(false);
  });

  test('ALLOWS Get-Command', () => {
    expect(isBlocked('Get-Command node', p)).toBe(false);
  });
});
