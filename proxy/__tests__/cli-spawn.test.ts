'use strict';

import fs from 'fs';
import path from 'path';

const cliSource = fs.readFileSync(path.resolve(__dirname, '../../scripts/cli.mjs'), 'utf-8');

describe('CLI spawn safety invariants', () => {
  // ── DEP0190: no args array + shell:true on the same spawn ──────────
  test('every spawn/spawnSync with shell:true uses shellSafe', () => {
    // Strategy: find each line with shell:true, then extract the
    // containing spawn/spawnSync call. The args must come from
    // ...shellSafe(cmd, ...), which on Windows returns [cmdStr, []].
    const lines = cliSource.split('\n');
    const violations: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].includes('shell: true')) continue;

      // Search backward (up to 10 lines) for a spawn/spawnSync call
      let foundSpawn = false;
      let foundShellSafe = false;
      for (let j = i; j >= Math.max(0, i - 10); j--) {
        if (/\bspawn(?:Sync)?\s*\(/.test(lines[j])) foundSpawn = true;
        if (/shellSafe\(/.test(lines[j])) foundShellSafe = true;
        // Break when we hit the start of the spawn expression
        if (foundSpawn) break;
      }

      if (foundSpawn && !foundShellSafe) {
        violations.push(`Line ${i + 1}: spawn with shell:true but no shellSafe() — DEP0190 risk`);
      }
    }

    // Also: check that no spawnSync('claude', [...]) line uses shell:true
    // without shellSafe. That specific call at line ~1092 uses hardcoded 'claude'.
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

    // Pattern C: const ccArgs = [...] — the variable used in the 4th spawn
    const ccMatch = cliSource.match(/const ccArgs = \[([^\]]*)\]/);
    if (ccMatch && !ccMatch[1].includes("'--dangerously-skip-permissions'")) {
      violations.push('ccArgs variable missing --dangerously-skip-permissions');
    }

    expect(violations).toEqual([]);
  });
});
