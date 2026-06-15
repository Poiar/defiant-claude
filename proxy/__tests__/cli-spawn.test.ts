'use strict';

import fs from 'fs';
import path from 'path';

const cliSource = fs.readFileSync(path.resolve(__dirname, '../../scripts/cli.mjs'), 'utf-8');

describe('CLI spawn safety invariants', () => {
  // ── DEP0190: no args array + shell:true on the same spawn ──────────
  test('every spawn/spawnSync with shell:true uses shellSafe', () => {
    const lines = cliSource.split('\n');
    const violations: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].includes('shell: true')) continue;

      let foundSpawn = false;
      let foundShellSafe = false;
      for (let j = i; j >= Math.max(0, i - 10); j--) {
        if (/\bspawn(?:Sync)?\s*\(/.test(lines[j])) foundSpawn = true;
        if (/shellSafe\(/.test(lines[j])) foundShellSafe = true;
        if (foundSpawn) break;
      }

      if (foundSpawn && !foundShellSafe) {
        violations.push(`Line ${i + 1}: spawn with shell:true but no shellSafe() — DEP0190 risk`);
      }
    }

    expect(violations).toEqual([]);
  });

  // ── --dangerously-skip-permissions on every CLAUDE launch ──────────
  test('every CLAUDE spawn/spawnSync includes --dangerously-skip-permissions', () => {
    const violations: string[] = [];

    // Pattern A: ...shellSafe(CLAUDE, [...])
    const reA = /shellSafe\(CLAUDE,\s*\[([\s\S]*?)\]\s*\)/g;
    let match: RegExpExecArray | null;
    while ((match = reA.exec(cliSource)) !== null) {
      if (!match[1].includes("'--dangerously-skip-permissions'")) {
        violations.push(
          `shellSafe(CLAUDE, [...]) missing --dangerously-skip-permissions:\n  ${match[0].slice(0, 150)}`,
        );
      }
    }

    // Pattern B: spawnSync('claude', [...]) — hardcoded command (Unix remote path)
    const reB = /spawnSync\(\s*'claude'\s*,\s*\[([\s\S]*?)\]\s*,/g;
    while ((match = reB.exec(cliSource)) !== null) {
      if (!match[1].includes("'--dangerously-skip-permissions'")) {
        violations.push(
          `spawnSync('claude', [...]) missing --dangerously-skip-permissions:\n  ${match[0].slice(0, 150)}`,
        );
      }
    }

    // Pattern C: const ccArgs = [...] — the variable used in the normal spawn
    const ccMatch = cliSource.match(/const ccArgs = \[([^\]]*)\]/);
    if (ccMatch && !ccMatch[1].includes("'--dangerously-skip-permissions'")) {
      violations.push('ccArgs variable missing --dangerously-skip-permissions');
    }

    expect(violations).toEqual([]);
  });

  // ── AV warning on all Windows launch paths ─────────────────────────
  test('every Windows proxy-launch path calls showAvWarning()', () => {
    const violations: string[] = [];

    // Find every writeAtomic(routesFile, ...) which is the signal that we're
    // about to start a proxy for launch. The next meaningful call should be
    // showAvWarning() (showAvWarning also calls writeFixAv internally).
    // We check: every startProxy() on a launch path is preceded by
    // showAvWarning() within 20 lines, OR the path is a pure-Anthropic
    // launch (no proxy needed).
    const lines = cliSource.split('\n');

    const startProxyCalls: { line: number; hasAvWarning: boolean }[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (/\bstartProxy\(/.test(lines[i])) {
        // Look backward for showAvWarning() or "isAnthropic" guard
        let hasAvWarning = false;
        for (let j = i; j >= Math.max(0, i - 20); j--) {
          if (lines[j].includes('showAvWarning()')) {
            hasAvWarning = true;
            break;
          }
          // If we hit a return/process.exit for the Anthropic-only path,
          // this startProxy is behind a non-Anthropic guard — skip it.
          if (lines[j].includes('if (isAnthropic)') || lines[j].includes('Anthropic direct')) {
            break;
          }
        }
        if (!hasAvWarning) {
          startProxyCalls.push({ line: i + 1, hasAvWarning: false });
        }
      }
    }

    if (startProxyCalls.length > 0) {
      violations.push(
        ...startProxyCalls.map(
          (s) => `Line ${s.line}: startProxy() without preceding showAvWarning() within 20 lines`,
        ),
      );
    }

    expect(violations).toEqual([]);
  });
});
