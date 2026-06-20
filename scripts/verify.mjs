#!/usr/bin/env node
'use strict';

// Full verification suite — run before pushing or to validate changes.
// Runs tests + lint in sequence, reports pass/fail clearly.

import { spawnSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { platform } from 'os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const isWin = platform() === 'win32';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

function run(label, cmd, args, opts = {}) {
  process.stdout.write(`${BOLD}${label}${RESET}... `);
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 300_000,
    shell: isWin,
    ...opts,
  });
  if (r.status === 0) {
    console.log(`${GREEN}OK${RESET}`);
    return { ok: true, output: r.stdout, stderr: r.stderr };
  }
  console.log(`${RED}FAILED (exit ${r.status})${RESET}`);
  if (r.stdout?.trim()) console.log(r.stdout);
  if (r.stderr?.trim()) console.error(r.stderr);
  return { ok: false, output: r.stdout, stderr: r.stderr };
}

function countTests() {
  const testDir = resolve(ROOT, 'proxy/__tests__');
  if (!existsSync(testDir)) return { files: 0, tests: 0 };
  let files = 0,
    tests = 0;
  for (const f of readdirSync(testDir)) {
    if (!f.endsWith('.test.ts')) continue;
    files++;
    const content = readFileSync(resolve(testDir, f), 'utf-8');
    tests += (content.match(/^\s*(?:test|it)\(/gm) || []).length;
  }
  return { files, tests };
}

// ─── Main ──────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const skipLint = argv.includes('--no-lint') || argv.includes('--skip-lint');
const skipTests = argv.includes('--no-tests') || argv.includes('--skip-tests');

console.log(`${BOLD}Defiant Claude verification${RESET}\n`);

let failed = false;

// 1. Tests
if (!skipTests) {
  const test = run('Tests (jest)', 'npx', ['jest', 'proxy/__tests__', '--no-coverage'], {
    env: { ...process.env, FORCE_COLOR: '0' },
  });
  if (!test.ok) failed = true;
}

// 2. Lint
if (!skipLint) {
  const eslint = run('ESLint', 'npx', ['eslint', 'proxy/', '--max-warnings', '0']);
  if (!eslint.ok) failed = true;
}

// ─── Summary ──────────────────────────────────────────────────────
const { files, tests } = countTests();
console.log(`\n${BOLD}${files} test files, ~${tests} tests${RESET}`);

if (failed) {
  console.log(`\n${RED}${BOLD}Verification FAILED${RESET}`);
  process.exit(1);
}

console.log(`\n${GREEN}${BOLD}Verification PASSED${RESET}`);
process.exit(0);
