#!/usr/bin/env node
'use strict';

// DeepClaude unified CLI — single Node.js entry point replacing deepclaude.ps1
// and deepclaude.sh. Handles flag parsing, config resolution, subcommands
// (status, stats, doctor, models, cost, etc.), proxy launch, and CC launch.

import { spawn, spawnSync, execSync } from 'child_process';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  chmodSync,
  readdirSync,
  statSync,
  unlinkSync,
  renameSync,
} from 'fs';
import { join, dirname, resolve } from 'path';
import { homedir, platform } from 'os';
import { fileURLToPath } from 'url';
import http from 'http';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, '..');
const PROXY_DIR = join(ROOT, 'proxy');
const PROXY_SCRIPT = join(PROXY_DIR, 'start-proxy.ts');
const LAUNCHER = join(PROXY_DIR, 'launcher.mjs');
const PROVIDERS_PATH = join(PROXY_DIR, 'providers.json');
const DEEPCLAUDE_DIR = join(homedir(), '.deepclaude');
const SLOTS = ['opus', 'sonnet', 'haiku', 'subagent', 'fable'];
const IS_WIN = platform() === 'win32';
const NPX = IS_WIN ? 'npx.cmd' : 'npx';
// Claude Code installs as 'claude.cmd' on Windows, 'claude' on Unix.
const CLAUDE = IS_WIN ? 'claude.cmd' : 'claude';

// ─── Shell-safe spawn helpers (avoid DEP0190 on Windows) ─────────────
// On Windows, .cmd files require shell:true, but passing args with
// shell:true triggers Node.js DEP0190. Join into a single command string.
// NOTE: no per-arg quoting — embedded double quotes break cmd.exe /s parsing.
const shellSafe = (cmd, args) => (IS_WIN ? [`${cmd} ${args.join(' ')}`, []] : [cmd, args]);

// ─── Colors ──────────────────────────────────────────────────────────
const C = {
  R: '\x1b[31m',
  G: '\x1b[32m',
  Y: '\x1b[33m',
  C: '\x1b[36m',
  W: '\x1b[37m',
  B: '\x1b[1m',
  D: '\x1b[2m',
  X: '\x1b[0m',
};

function fail(msg) {
  console.error(`${C.R}ERROR: ${msg}${C.X}`);
  process.exit(1);
}
function warn(msg) {
  console.error(`${C.Y}WARNING: ${msg}${C.X}`);
}

// ─── Helpers ──────────────────────────────────────────────────────────
function launcher(action, ...args) {
  const r = spawnSync('node', [LAUNCHER, action, ...args], {
    cwd: ROOT,
    encoding: 'utf-8',
    timeout: 30000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || 'launcher error').trim());
  try {
    return JSON.parse(r.stdout);
  } catch {
    return r.stdout;
  }
}

function readRegistry(name) {
  if (!IS_WIN) return null;
  try {
    const out = spawnSync('reg', ['query', 'HKCU\\Environment', '/v', name], {
      encoding: 'utf-8',
      timeout: 2000,
      windowsHide: true,
    });
    if (out.status !== 0 || !out.stdout) return null;
    const m = out.stdout.match(/REG_\w+\s+(.+)/);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

function getProviderKey(provKey) {
  const reg = JSON.parse(readFileSync(PROVIDERS_PATH, 'utf-8'));
  const prov = reg.providers[provKey];
  if (!prov) return '';
  return process.env[prov.keyEnv] || readRegistry(prov.keyEnv) || '';
}

function writeAtomic(path, content) {
  const tmp = path + '.tmp';
  const lock = path + '.lock';
  mkdirSync(dirname(path), { recursive: true });
  // Advisory lock
  for (let i = 0; i < 10; i++) {
    try {
      if (existsSync(lock)) {
        const lc = readFileSync(lock, 'utf-8');
        const m = lc.match(/pid=(\d+)/);
        let stale = true;
        if (m) {
          try {
            process.kill(parseInt(m[1]), 0);
            stale = false;
          } catch {}
        }
        if (stale) {
          try {
            rmSync(lock, { force: true });
          } catch {}
        } else {
          const s = Date.now();
          while (Date.now() - s < 50) {
            /* spin */
          }
          continue;
        }
      }
      writeFileSync(lock, `pid=${process.pid}\nts=${new Date().toISOString()}`);
      break;
    } catch {
      /* retry */
    }
  }
  writeFileSync(tmp, content, 'utf-8');
  try {
    rmSync(path, { force: true });
  } catch {}
  writeFileSync(path, content, 'utf-8');
  try {
    rmSync(tmp, { force: true });
  } catch {}
  try {
    rmSync(lock, { force: true });
  } catch {}
  if (!IS_WIN) {
    try {
      chmodSync(path, 0o600);
    } catch {}
  }
}

function healthRequest(port) {
  return new Promise((resolve) => {
    http
      .get(`http://127.0.0.1:${port}/health`, { timeout: 3000 }, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(d));
          } catch {
            resolve(null);
          }
        });
      })
      .on('error', () => resolve(null));
  });
}

function loadProviders() {
  const reg = JSON.parse(readFileSync(PROVIDERS_PATH, 'utf-8'));
  const providers = {};
  for (const [pk, def] of Object.entries(reg.providers)) {
    providers[pk] = {
      name: def.displayName,
      url: def.endpoint,
      key: getProviderKey(pk),
      keyName: def.keyEnv,
      auth: def.authHeader || 'bearer',
      format: def.wireFormat || 'anthropic',
      fallback: def.fallback || null,
      extraHeaders: def.extraHeaders || null,
    };
  }
  return {
    providers,
    configs: reg.configs || {},
    contextLimits: reg.contextLimits || {},
    pricing: reg.pricing || {},
    compactionWindow: reg.compactionWindow || {},
  };
}

function keyDisplay(k) {
  return k ? `set (****${k.slice(-4)})` : 'MISSING';
}

// ─── Flag parsing ─────────────────────────────────────────────────────
function parseArgs(argv) {
  const flags = { specs: [], effort: 'max' };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      flags.help = true;
      i++;
      continue;
    }
    if (a === '-b') {
      flags.backend = argv[i + 1] || '';
      i += 2;
      continue;
    }
    if (a === '--effort' || a === '-e') {
      flags.effort = argv[i + 1] || 'max';
      i += 2;
      continue;
    }
    if (a.startsWith('--effort=')) {
      flags.effort = a.split('=')[1];
      i++;
      continue;
    }
    const boolFlags = [
      '--status',
      '--cost',
      '--benchmark',
      '--help',
      '--lint',
      '--lint-config',
      '--fix-av',
      '--models',
      '--version',
      '--doctor',
      '--stats',
      '--dry-run',
      '--what-if',
      '--dashboard',
      '--open',
      '--log-all',
      '--skip-startup-check',
      '--logs',
      '--tail',
      '--health',
      '--no-thinking',
      '--install-statusline',
      '--remote',
      '--cleanup',
      '-r',
    ];
    if (boolFlags.includes(a)) {
      flags[a.replace(/^-+/, '').replace(/-/g, '')] = true;
      i++;
      continue;
    }
    if (a === '--import-csv') {
      const val = argv[i + 1];
      if (!val || val.startsWith('-')) fail('--import-csv requires a file path');
      flags.importcsv = val;
      i += 2;
      continue;
    }
    if (a === '--set-slot' || a === '--subagent-model') {
      const key = a.replace(/^-+/, '').replace(/-/g, '');
      const val = argv[i + 1];
      if (!val || val.startsWith('-')) {
        flags[key] = '';
        i++;
      } else {
        flags[key] = val;
        i += 2;
      }
      continue;
    }
    if (a === '--thinking-budget') {
      flags.thinkingBudget = parseInt(argv[i + 1]) || 0;
      i += 2;
      continue;
    }
    if (a.startsWith('--thinking-budget=')) {
      flags.thinkingBudget = parseInt(a.split('=')[1]) || 0;
      i++;
      continue;
    }
    if (a === '--probe') {
      const next = argv[i + 1];
      flags.probe = next && !next.startsWith('-') ? next : true;
      i += flags.probe === true ? 1 : 2;
      continue;
    }
    if (a === '--max-spend') {
      flags.maxSpend = parseFloat(argv[i + 1]) || 0;
      i += 2;
      continue;
    }
    if (a === '--cleanup-days') {
      flags.cleanupDays = parseInt(argv[i + 1], 10) || 7;
      i += 2;
      continue;
    }
    if (a.startsWith('--cleanup-days=')) {
      flags.cleanupDays = parseInt(a.split('=')[1], 10) || 7;
      i++;
      continue;
    }
    if (a === '--persist' || a === '--switch' || a === '--stop-proxy') {
      fail(`${a} is removed. Each session runs its own isolated proxy.`);
    }
    if (a.startsWith('-')) {
      fail(`Unknown flag '${a}'. Use --help for available flags.`);
    }
    // Positional spec
    flags.specs.push(a);
    i++;
  }
  return flags;
}

// ─── Subcommands ──────────────────────────────────────────────────────

function cmdVersion() {
  let ver = 'v1.0.0';
  try {
    ver = 'v' + JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')).version;
  } catch {}
  let hash = 'unknown';
  try {
    hash = execSync('git rev-parse --short HEAD', {
      cwd: ROOT,
      encoding: 'utf-8',
      timeout: 3000,
    }).trim();
  } catch {}
  console.log(`deepclaude ${ver} (${hash})`);
  console.log(`Proxy: ${PROXY_SCRIPT}`);
}

function cmdStatus(providers, configs) {
  console.log(`\n  deepclaude - Provider Status`);
  console.log(`  ============================\n`);
  console.log(`  Keys:`);
  for (const [_pk, pv] of Object.entries(providers)) {
    console.log(`    ${pv.keyName.padEnd(28)} ${keyDisplay(pv.key)}`);
  }
  console.log(`\n  Configurations:`);
  for (const [key, cfg] of Object.entries(configs)) {
    console.log(`    ${key.padEnd(7)} ${cfg.name}`);
  }
  console.log();
}

function cmdCost(pricing) {
  console.log(`\n  Model Pricing (per million tokens)`);
  console.log(`  ===================================\n`);
  console.log(`  ${'Model'.padEnd(40)} Input/M     CacheHit/M  CacheMiss/M  Output/M`);
  for (const [model, p] of Object.entries(pricing)) {
    if (model.startsWith('_')) continue;
    const inp = p.input ? `$${p.input.toFixed(3).padStart(7)}` : 'free     ';
    const out = p.output ? `$${p.output.toFixed(2)}` : 'free';
    const hit = p.input_cache_hit
      ? `$${p.input_cache_hit.toFixed(4).padStart(9)}`
      : '—'.padStart(9);
    const miss = p.input_cache_miss
      ? `$${p.input_cache_miss.toFixed(3).padStart(9)}`
      : '—'.padStart(9);
    console.log(`  ${model.slice(0, 37).padEnd(40)} ${inp} ${hit} ${miss} ${out}`);
  }
  console.log();
}

function cmdModels(providers, configs) {
  console.log(`\n  deepclaude - Available Models`);
  console.log(`  ================================\n`);
  const byProvider = {};
  for (const cfg of Object.values(configs)) {
    for (const slot of SLOTS) {
      const val = cfg[slot === 'subagent' ? 'sub' : slot] || cfg[slot];
      if (!val) continue;
      const [provKey, modelId] = val.split(':');
      if (!byProvider[provKey]) byProvider[provKey] = new Set();
      byProvider[provKey].add(modelId);
    }
  }
  for (const [pk, models] of Object.entries(byProvider).sort()) {
    const pv = providers[pk];
    const ks = pv?.key ? 'set' : 'MISSING';
    console.log(`\n  ${pv?.name || pk} (${pk}) [key: ${ks}]:`);
    for (const m of [...models].sort()) console.log(`    ${pk}:${m}`);
  }
  const portFile = join(DEEPCLAUDE_DIR, 'proxy.port');
  if (existsSync(portFile)) {
    console.log(`\n  Proxy: RUNNING on port ${readFileSync(portFile, 'utf-8').trim()}`);
  } else {
    console.log(`\n  Proxy: NOT RUNNING`);
  }
  console.log();
}

async function cmdHealth() {
  const portFile = join(DEEPCLAUDE_DIR, 'proxy.port');
  if (!existsSync(portFile)) {
    console.log('No proxy.port found — is a proxy running?');
    return;
  }
  const port = readFileSync(portFile, 'utf-8').trim();
  const h = await healthRequest(port);
  if (!h) {
    console.log(`Proxy not responding on port ${port}`);
    return;
  }
  const pv = h.providers || {};
  let up = 0,
    down = 0;
  for (const v of Object.values(pv)) {
    v.circuitBreaker === 'OPEN' ? down++ : up++;
  }
  const total = up + down;
  console.log(`${up}/${total} up`);
  if (down > 0) {
    const open = Object.entries(pv)
      .filter(([, v]) => v.circuitBreaker === 'OPEN')
      .map(([k]) => k)
      .join(', ');
    console.log(`  down: ${open}`);
  }
}

function cmdCleanup(flags) {
  const days = flags.cleanupDays || 7;
  const cutoffMs = Date.now() - days * 86400_000;
  const todayISO = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-${String(new Date().getDate()).padStart(2, '0')}`;

  console.log(`\n  deepclaude - Spend Cleanup (>${days} days old)`);
  console.log(`  ${'='.repeat(45)}\n`);

  // ── Per-model spend summary (from spend.json) ─────────────────
  const spendFile = join(DEEPCLAUDE_DIR, 'spend.json');
  if (existsSync(spendFile)) {
    try {
      const spend = JSON.parse(readFileSync(spendFile, 'utf-8'));
      const daily = spend.daily || {};

      // Aggregate per-provider spend from all daily entries
      const byProvider = {};
      let grandTotal = 0;
      for (const [date, entry] of Object.entries(daily)) {
        const e = entry || {};
        grandTotal += e.total || 0;
        for (const [pk, amt] of Object.entries(e.byProvider || {})) {
          byProvider[pk] = (byProvider[pk] || 0) + amt;
        }
      }

      console.log(`  ${'All-time spend by provider'.padEnd(45)}`);
      console.log(`  ${'-'.repeat(45)}`);
      if (Object.keys(byProvider).length === 0) {
        console.log(`  (no provider breakdown data)\n`);
      } else {
        for (const [pk, amt] of Object.entries(byProvider).sort((a, b) => b[1] - a[1])) {
          const bar = '█'.repeat(Math.min(20, Math.round((amt / grandTotal) * 20 || 0)));
          console.log(`  ${pk.padEnd(12)} $${amt.toFixed(2).padStart(8)}  ${bar}`);
        }
        console.log(`  ${'─'.repeat(45)}`);
        console.log(`  ${'TOTAL'.padEnd(12)} $${grandTotal.toFixed(2).padStart(8)}\n`);
      }

      // Show today
      const today = daily[todayISO];
      if (today && today.total > 0) {
        console.log(`  Today (${todayISO}): $${today.total.toFixed(2)}`);
        if (today.byProvider) {
          for (const [pk, amt] of Object.entries(today.byProvider).sort((a, b) => b[1] - a[1])) {
            console.log(`    ${pk}: $${amt.toFixed(2)}`);
          }
        }
        console.log();
      }
    } catch (_) {
      console.log(`  (spend.json unreadable)\n`);
    }
  } else {
    console.log(`  (no spend.json found)\n`);
  }

  // ── Purge stale cc-spend files ────────────────────────────────
  let purged = 0;
  let purgedBytes = 0;
  let kept = 0;
  let staleTotal = 0;
  try {
    for (const f of readdirSync(DEEPCLAUDE_DIR)) {
      if (!f.startsWith('cc-spend-') || !f.endsWith('.json')) continue;
      const filePath = join(DEEPCLAUDE_DIR, f);
      try {
        const stat = statSync(filePath);
        if (stat.mtimeMs < cutoffMs) {
          try {
            staleTotal += parseFloat(readFileSync(filePath, 'utf-8').trim()) || 0;
          } catch (_) {}
          purgedBytes += stat.size;
          unlinkSync(filePath);
          purged++;
        } else {
          kept++;
        }
      } catch (_) {}
    }
  } catch (_) {}

  if (purged > 0) {
    console.log(
      `  Purged ${purged} cc-spend files (>${days} days, ${(purgedBytes / 1024).toFixed(1)} KB)`,
    );
    if (staleTotal > 0) {
      console.log(`  Stale sessions accounted for: $${staleTotal.toFixed(2)}`);
    }
  } else {
    console.log(`  No stale cc-spend files to purge (cutoff: >${days} days)`);
  }
  if (kept > 0) {
    console.log(`  Kept ${kept} recent cc-spend files (≤${days} days)`);
  }
  console.log();
}

function cmdImportCsv(filePath) {
  if (!existsSync(filePath)) fail(`File not found: ${filePath}`);

  // Known model → provider key mapping for billing CSV model names.
  // DeepSeek billing uses "deepseek-v4-pro", "deepseek-v4-flash" etc.
  // OpenRouter uses "deepseek/deepseek-v4-pro", "openai/gpt-5" etc.
  const MODEL_TO_PROVIDER = {
    'deepseek-v4-pro': 'ds',
    'deepseek-v4-flash': 'ds',
    'deepseek-chat': 'ds',
    'deepseek-reasoner': 'ds',
    'claude-opus-4': 'an',
    'claude-opus-4-7': 'an',
    'claude-sonnet-4': 'an',
    'claude-sonnet-4-6': 'an',
    'claude-haiku-4-5': 'an',
    'gpt-5': 'oa',
    'gpt-5-mini': 'oa',
    o4: 'oa',
    'o4-mini': 'oa',
    'gemini-2.5-flash': 'gm',
    'gemini-2.5-pro': 'gm',
  };

  const raw = readFileSync(filePath, 'utf-8');
  const lines = raw.trim().split('\n');

  // Detect format from header
  const header = lines[0];
  const isOpenRouter = header.includes('provider') && header.includes('model');
  const isDeepSeek = header.includes('wallet_type') && header.includes('utc_date');

  // Parse: aggregate { date -> { providerKey:model -> cost } }
  const daily = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = line.split(',');
    if (cols.length < 4) continue;

    let date, model, cost;
    if (isDeepSeek) {
      // user_id, utc_date, model, wallet_type, cost, currency
      date = cols[1];
      model = cols[2];
      cost = parseFloat(cols[4]) || 0;
    } else if (isOpenRouter) {
      // provider, model, date, cost, tokens_prompt, tokens_completion, ...
      date = cols[2];
      model = cols[0] + '/' + cols[1]; // "deepseek/deepseek-v4-pro"
      cost = parseFloat(cols[3]) || 0;
    } else {
      // Generic: try date in col[0] and cost/grandchild columns
      date = cols[0];
      model = cols[1] || 'unknown';
      cost = parseFloat(cols[4] || cols[3] || '0') || 0;
    }

    if (!date || !model || cost <= 0) continue;

    // Map model to provider key prefix
    let pk = '??';
    for (const [name, prov] of Object.entries(MODEL_TO_PROVIDER)) {
      if (model.includes(name)) {
        pk = prov;
        break;
      }
    }

    const key = pk + ':' + model;
    if (!daily[date]) daily[date] = {};
    daily[date][key] = parseFloat(((daily[date][key] || 0) + cost).toFixed(4));
  }

  if (Object.keys(daily).length === 0) fail('No data found in CSV — check format.');

  // Compute CSV totals for reporting
  let csvTotal = 0;
  const byModel = {};
  for (const [date, models] of Object.entries(daily)) {
    for (const [key, cost] of Object.entries(models)) {
      csvTotal += cost;
      byModel[key] = (byModel[key] || 0) + cost;
    }
  }

  console.log(`\n  Importing billing CSV`);
  console.log(`  ${'='.repeat(50)}\n`);
  console.log(`  Format: ${isDeepSeek ? 'DeepSeek' : isOpenRouter ? 'OpenRouter' : 'generic'}`);
  console.log(
    `  Date range: ${Object.keys(daily).sort()[0]} → ${Object.keys(daily).sort().slice(-1)[0]}`,
  );
  console.log(`  Total from CSV: $${csvTotal.toFixed(2)}\n`);

  console.log(`  ${'By model (CSV)'.padEnd(40)}`);
  console.log(`  ${'-'.repeat(40)}`);
  for (const [key, cost] of Object.entries(byModel).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${key.padEnd(35)} $${cost.toFixed(2)}`);
  }
  console.log();

  // Merge into spend.json
  const spendFile = join(DEEPCLAUDE_DIR, 'spend.json');
  let existing = {};
  if (existsSync(spendFile)) {
    try {
      existing = JSON.parse(readFileSync(spendFile, 'utf-8'));
    } catch (_) {}
  }
  const existingDaily = existing.daily || {};

  // For each date in the CSV, wipe matching provider prefixes and replace
  for (const [date, models] of Object.entries(daily)) {
    const oldEntry = existingDaily[date] || { total: 0, byProvider: {} };

    // Build set of provider prefixes present in this CSV date
    const csvProviders = new Set();
    for (const key of Object.keys(models)) {
      const prefix = key.split(':')[0];
      csvProviders.add(prefix);
    }

    // Keep non-matching provider entries from old data
    const cleaned = {};
    for (const [pk, amt] of Object.entries(oldEntry.byProvider || {})) {
      const prefix = pk.split(':')[0];
      if (!csvProviders.has(prefix)) cleaned[pk] = amt;
    }

    // Add CSV ground truth
    for (const [key, cost] of Object.entries(models)) {
      cleaned[key] = cost;
    }

    // Recompute total
    let total = 0;
    for (const amt of Object.values(cleaned)) total += amt;
    existingDaily[date] = { total: parseFloat(total.toFixed(4)), byProvider: cleaned };
  }

  // Recompute grand total
  let grandTotal = 0;
  for (const entry of Object.values(existingDaily)) {
    grandTotal += entry.total || 0;
  }

  const output = {
    total: parseFloat(grandTotal.toFixed(4)),
    daily: existingDaily,
    sessions: existing.sessions || [],
    current_model: existing.current_model || 'deepseek-v4-pro',
  };

  const tmpFile = spendFile + '.tmp';
  writeFileSync(tmpFile, JSON.stringify(output) + '\n');
  renameSync(tmpFile, spendFile);

  // Show before/after delta
  const oldTotal = existing.total || 0;
  const delta = grandTotal - oldTotal;
  console.log(`  Previous spend.json total: $${oldTotal.toFixed(2)}`);
  console.log(`  New spend.json total:      $${grandTotal.toFixed(2)}`);
  if (delta !== 0) {
    console.log(`  Delta:                     ${delta > 0 ? '+' : ''}$${delta.toFixed(2)}`);
  }
  console.log(`\n  Written to ${spendFile}\n`);
}

async function cmdStats() {
  const portFile = join(DEEPCLAUDE_DIR, 'proxy.port');
  if (!existsSync(portFile)) {
    console.log('No proxy.port found — is a proxy running?');
    return;
  }
  const port = readFileSync(portFile, 'utf-8').trim();
  const h = await healthRequest(port);
  if (!h) {
    console.log(`Proxy not responding on port ${port}`);
    return;
  }
  console.log(`\n  Provider    Req  OK  Fail   Rate  Cache  AvgTime`);
  console.log(`  ----------  ---  --- -----  -----  -----  -------`);
  for (const [key, v] of Object.entries(h.providers || {}).sort()) {
    const rate = v.requests > 0 ? `${Math.round((v.successes / v.requests) * 100)}%` : '—';
    const avg = v.avgMs > 0 ? `${v.avgMs}ms` : '—';
    const cache = v.cacheHitRate ? `${v.cacheHitRate}%` : '—';
    console.log(
      `  ${key.padEnd(12)} ${String(v.requests).padStart(3)} ${String(v.successes).padStart(3)} ${String(v.fails).padStart(5)}  ${rate.padStart(5)}  ${cache.padStart(5)}  ${avg.padStart(5)}`,
    );
  }
  console.log();
}

async function cmdDoctor(flags, providers, configs) {
  console.log(`\n  deepclaude System Check`);
  console.log(`  ======================\n`);
  let ok = true;

  // Node
  const nodePath = spawnSync(IS_WIN ? 'where' : 'which', ['node'], {
    encoding: 'utf-8',
  }).stdout.trim();
  const nodeVer = (() => {
    try {
      return execSync('node -v', { encoding: 'utf-8' }).trim();
    } catch {
      return '';
    }
  })();
  console.log(`  Prerequisites:`);
  if (nodeVer) console.log(`    Node.js           ${C.G}PASS${C.X}  ${nodePath} (${nodeVer})`);
  else {
    console.log(`    Node.js           ${C.R}FAIL${C.X}  Not found`);
    ok = false;
  }

  // Proxy script
  if (existsSync(PROXY_SCRIPT))
    console.log(`    Proxy script      ${C.G}PASS${C.X}  ${PROXY_SCRIPT}`);
  else {
    console.log(`    Proxy script      ${C.R}FAIL${C.X}  Not found`);
    ok = false;
  }

  // Stale tmps
  const stale = (() => {
    try {
      return require('fs')
        .readdirSync(DEEPCLAUDE_DIR)
        .filter((f) => f.endsWith('.tmp')).length;
    } catch {
      return 0;
    }
  })();
  if (stale) console.log(`    Stale .tmp files  ${C.Y}WARN${C.X}  ${stale} found (cleaned)`);

  // Keys
  console.log(`\n  API Keys:`);
  let keysOk = 0,
    keysTotal = 0;
  for (const [_pk, pv] of Object.entries(providers)) {
    keysTotal++;
    if (pv.key) {
      console.log(`    ${pv.keyName.padEnd(28)} ${C.G}PASS${C.X}  ${keyDisplay(pv.key)}`);
      keysOk++;
    } else console.log(`    ${pv.keyName.padEnd(28)} ${C.Y}WARN${C.X}  Not set`);
  }
  console.log(`    ${keysOk}/${keysTotal} keys configured`);

  // Slot overrides
  console.log(`\n  Slot Overrides:`);
  const overridesFile = join(DEEPCLAUDE_DIR, 'slot-overrides.json');
  if (existsSync(overridesFile)) {
    try {
      const overrides = JSON.parse(readFileSync(overridesFile, 'utf-8'));
      for (const slot of SLOTS) {
        const val = overrides[slot] || overrides._defaults?.[slot];
        if (val) {
          const [pk] = val.split(':');
          const provOk = providers[pk]?.key;
          console.log(
            `    ${slot.padEnd(12)} ${provOk ? C.G + 'PASS' : C.Y + 'WARN'}${C.X}  ${val}  ->  ${providers[pk]?.name || pk}`,
          );
        } else console.log(`    ${slot.padEnd(12)} ${C.R}FAIL${C.X}  No mapping`);
      }
    } catch {
      console.log(`    ${C.R}FAIL${C.X}  Corrupt JSON`);
    }
  } else console.log(`    ${C.Y}WARN${C.X}  No slot-overrides.json`);

  // Subagent
  const subFile = join(DEEPCLAUDE_DIR, 'subagent-model.json');
  if (existsSync(subFile)) {
    try {
      const sd = JSON.parse(readFileSync(subFile, 'utf-8'));
      console.log(`\n  Subagent model: ${sd.providerKey}:${sd.modelId} (dedicated)`);
    } catch {}
  } else console.log(`\n  Subagent model: config default`);

  // Proxy test
  console.log(`\n  Proxy Test:`);
  const defaultBackend =
    process.env.DEEPCLAUDE_DEFAULT_BACKEND || process.env.CHEAPCLAUDE_DEFAULT_BACKEND || null;
  let doctorCfg = defaultBackend && configs[defaultBackend] ? defaultBackend : null;
  if (!doctorCfg) doctorCfg = Object.keys(configs)[0] || null;
  if (!doctorCfg) {
    console.log(`    ${C.Y}WARN${C.X}  No configs available`);
  } else {
    try {
      const routesJson = launcher('build-routes', `--name=${doctorCfg}`);
      const routesFile = join(DEEPCLAUDE_DIR, 'doctor-test-routes.json');
      writeAtomic(
        routesFile,
        typeof routesJson === 'string' ? routesJson : JSON.stringify(routesJson),
      );
      // Start test proxy
      const proxyProc = spawn(
        ...shellSafe(NPX, [
          'tsx',
          PROXY_SCRIPT,
          '--routes',
          routesFile,
          '--overrides',
          overridesFile,
          '--providers',
          PROVIDERS_PATH,
        ]),
        {
          cwd: ROOT,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env },
          ...(IS_WIN ? { shell: true } : {}),
        },
      );
      const port = await new Promise((resolve, reject) => {
        let out = '';
        const t = setTimeout(() => reject(new Error('timeout')), 25000);
        proxyProc.stdout.on('data', (c) => {
          out += c.toString();
          const m = out.match(/PORT:(\d+)/);
          if (m) {
            clearTimeout(t);
            resolve(parseInt(m[1]));
          }
        });
      });
      const h = await healthRequest(port);
      if (h)
        console.log(
          `    Health endpoint   ${C.G}PASS${C.X}  http://127.0.0.1:${port} (uptime ${h.uptime}ms)`,
        );
      else {
        console.log(`    Health endpoint   ${C.R}FAIL${C.X}`);
        ok = false;
      }
      try {
        proxyProc.kill();
      } catch {}
      try {
        rmSync(routesFile, { force: true });
      } catch {}

      // Key validation via probe
      console.log(`\n  Key Validation (probe each provider):`);
      const probeRoutesJson = launcher('build-routes', `--name=${doctorCfg}`);
      const probeFile = join(DEEPCLAUDE_DIR, 'doctor-probe-routes.json');
      writeAtomic(
        probeFile,
        typeof probeRoutesJson === 'string' ? probeRoutesJson : JSON.stringify(probeRoutesJson),
      );
      const probeResult = spawnSync(NPX, ['tsx', PROXY_SCRIPT, '--probe', probeFile], {
        cwd: ROOT,
        encoding: 'utf-8',
        timeout: 60000,
        stdio: 'pipe',
        shell: IS_WIN,
      });
      if (probeResult.status === 0) console.log(probeResult.stdout);
      else ok = false;
      try {
        rmSync(probeFile, { force: true });
      } catch {}
    } catch (e) {
      if (e.message.includes('not set'))
        console.log(`    ${C.Y}WARN${C.X}  No valid API keys. Skipping proxy test.`);
      else {
        console.log(`    Proxy startup     ${C.R}FAIL${C.X}  ${e.message}`);
        ok = false;
      }
    }
  }

  console.log(
    ok
      ? `\n  ${C.G}Result: All checks passed. Ready to launch.${C.X}\n`
      : `\n  ${C.Y}Result: Some checks failed.${C.X}\n`,
  );
  process.exit(ok ? 0 : 1);
}

async function cmdProbe(flags, providers, configs) {
  let routesFile;
  if (typeof flags.probe === 'string') {
    routesFile = flags.probe;
  } else {
    const specs = resolveSpecs(flags, configs);
    const key = Object.keys(configs).includes(specs[0]) ? 'name' : 'specs';
    const val = key === 'name' ? specs[0] : specs.join(',');
    const routesJson = launcher('build-routes', `--${key}=${val}`);
    routesFile = join(DEEPCLAUDE_DIR, 'probe-routes.json');
    writeAtomic(
      routesFile,
      typeof routesJson === 'string' ? routesJson : JSON.stringify(routesJson),
    );
  }
  const r = spawnSync(NPX, ['tsx', PROXY_SCRIPT, '--probe', routesFile], {
    cwd: ROOT,
    stdio: 'inherit',
    timeout: 120000,
    shell: IS_WIN,
  });
  process.exit(r.status || 0);
}

async function cmdDryRun(flags, configs) {
  const specs = resolveSpecs(flags, configs);
  if (!specs.length) specs.push(process.env.DEEPCLAUDE_DEFAULT_BACKEND || 'ds+oc');
  const key = Object.keys(configs).includes(specs[0]) ? 'name' : 'specs';
  const val = key === 'name' ? specs[0] : specs.join(',');
  const routesJson = launcher('build-routes', `--${key}=${val}`);
  const routesFile = join(DEEPCLAUDE_DIR, 'dryrun-routes.json');
  writeAtomic(routesFile, typeof routesJson === 'string' ? routesJson : JSON.stringify(routesJson));
  const r = spawnSync(NPX, ['tsx', PROXY_SCRIPT, '--dry-run', routesFile], {
    cwd: ROOT,
    stdio: 'inherit',
    timeout: 60000,
    shell: IS_WIN,
  });
  process.exit(r.status || 0);
}

// ─── Config resolution ────────────────────────────────────────────────
function resolveSpecs(flags, _configs) {
  let specs = [...flags.specs];
  if (flags.backend) specs.unshift(flags.backend);
  if (!specs.length) {
    const def = process.env.DEEPCLAUDE_DEFAULT_BACKEND || process.env.CHEAPCLAUDE_DEFAULT_BACKEND;
    if (def) specs = [def];
    else {
      warn(
        'No config specified, defaulting to "ds+oc". Set DEEPCLAUDE_DEFAULT_BACKEND to suppress this.',
      );
      specs = ['ds+oc'];
    }
  }
  return specs;
}

// ─── Write fix-av.cmd ─────────────────────────────────────────────────
function writeFixAv() {
  const fixFile = join(DEEPCLAUDE_DIR, 'fix-av.cmd');
  const nodeExe = (() => {
    try {
      return execSync(IS_WIN ? 'where node' : 'which node', { encoding: 'utf-8', timeout: 2000 })
        .trim()
        .split('\n')[0];
    } catch {
      return 'node.exe';
    }
  })();
  const batch = `@echo off
REM deepclaude Windows Defender Exclusion Helper — run as ADMINISTRATOR
echo.
echo This script adds Windows Defender exclusions for deepclaude.
echo Run it in an ADMIN PowerShell window.
echo.
echo ----- Copy from here -----
echo Add-MpPreference -ExclusionPath "${PROXY_DIR}"
echo Add-MpPreference -ExclusionProcess "${nodeExe}"
echo ----- End copy ---------
echo.
powershell -Command "Add-MpPreference -ExclusionPath '${PROXY_DIR}'; Add-MpPreference -ExclusionProcess '${nodeExe}'; Write-Host 'Exclusions added.' -ForegroundColor Green"
pause
`;
  try {
    writeFileSync(fixFile, batch);
  } catch {}
}

function showAvWarning() {
  if (!IS_WIN) return;
  const fixFile = join(DEEPCLAUDE_DIR, 'fix-av.cmd');
  writeFixAv();
  console.log(
    `${C.Y}  ==============================================================================`,
  );
  console.log(`  WINDOWS DEFENDER MAY BLOCK THE PROXY.`);
  console.log(`  If the proxy fails to start or gets deleted, open an ADMIN PowerShell and run:`);
  console.log(`    ${C.W}${fixFile}${C.Y}`);
  console.log(
    `  (That file was just written — it survives AV deletion of the deepclaude directory.)`,
  );
  console.log(
    `  ==============================================================================${C.X}`,
  );
}

// ─── Launch ───────────────────────────────────────────────────────────

async function startProxy(routesFile, overridesFile, thinkingOverridesFile, flags) {
  const args = [
    'tsx',
    PROXY_SCRIPT,
    '--routes',
    routesFile,
    '--overrides',
    overridesFile,
    '--providers',
    PROVIDERS_PATH,
  ];
  if (existsSync(thinkingOverridesFile)) args.push('--thinking-overrides', thinkingOverridesFile);
  if (flags.logAll || process.env.DEEPCLAUDE_LOG_ALL_REQUESTS === 'true') args.push('--log-all');

  const proc = spawn(...shellSafe(NPX, args), {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ...(flags.skipStartupCheck ? { DEEPCLAUDE_SKIP_STARTUP_CHECK: 'true' } : {}),
    },
    ...(IS_WIN ? { shell: true } : {}),
  });

  const port = await new Promise((resolve, reject) => {
    let out = '';
    const t = setTimeout(() => reject(new Error('Proxy did not start within 30s')), 30000);
    proc.stdout.on('data', (c) => {
      out += c.toString();
      const m = out.match(/PORT:(\d+)/);
      if (m) {
        clearTimeout(t);
        resolve(parseInt(m[1]));
      }
    });
    proc.stderr.on('data', () => {});
  });

  // Verify health
  try {
    await healthRequest(port);
  } catch {}
  return { proc, port };
}

async function launchCC(flags, configs) {
  mkdirSync(DEEPCLAUDE_DIR, { recursive: true });

  // Handle action-only flags
  if (flags.help) {
    cmdHelp(configs);
    return;
  }
  if (flags.version) {
    cmdVersion();
    return;
  }

  const { providers } = loadProviders();
  if (flags.status) {
    cmdStatus(providers, configs);
    return;
  }
  if (flags.cost) {
    cmdCost(loadProviders().pricing);
    return;
  }
  if (flags.models) {
    cmdModels(providers, configs);
    return;
  }
  if (flags.health) {
    await cmdHealth();
    return;
  }
  if (flags.cleanup) {
    cmdCleanup(flags);
    return;
  }
  if (flags.importcsv) {
    cmdImportCsv(flags.importcsv);
    return;
  }
  if (flags.stats) {
    await cmdStats();
    return;
  }
  if (flags.whatif) flags.dryrun = true;
  if (flags.fixav) {
    showAvWarning();
    return;
  }

  // Doctor
  if (flags.doctor) {
    await cmdDoctor(flags, providers, configs);
    return;
  }

  // Probe
  if (flags.probe !== undefined) {
    await cmdProbe(flags, providers, configs);
    return;
  }

  // Dry run
  if (flags.dryrun) {
    await cmdDryRun(flags, configs);
    return;
  }

  // Lint
  if (flags.lint) {
    if (IS_WIN) {
      const r = spawnSync(
        'powershell',
        ['-Command', 'Invoke-ScriptAnalyzer -Path', join(ROOT, 'deepclaude.ps1')],
        { cwd: ROOT, stdio: 'inherit' },
      );
      process.exit(r.status || 0);
    } else {
      const r = spawnSync('shellcheck', [join(ROOT, 'deepclaude.sh')], {
        cwd: ROOT,
        stdio: 'inherit',
      });
      process.exit(r.status || 0);
    }
  }

  // Lint config
  if (flags.lintconfig) {
    const r = spawnSync(NPX, ['tsx', join(PROXY_DIR, 'config-lint.ts')], {
      cwd: ROOT,
      stdio: 'inherit',
      shell: IS_WIN,
    });
    process.exit(r.status || 0);
  }

  // Set slot
  if (flags.setslot !== undefined) {
    const parts = (flags.setslot || '').split(/\s+/, 2);
    const slotName = parts[0];
    const slotModel = parts[1] || '';
    if (!SLOTS.includes(slotName)) fail(`Invalid slot '${slotName}'. Use: ${SLOTS.join(', ')}`);
    try {
      launcher('set-slot', `--slot=${slotName}`, `--value=${slotModel}`);
    } catch (e) {
      fail(e.message);
    }
    if (slotModel) console.log(`\n  Set ${slotName} override: ${slotModel}`);
    else console.log(`\n  Cleared ${slotName} override.`);
    if (existsSync(join(DEEPCLAUDE_DIR, 'proxy.port')))
      console.log('  Proxy is running — change takes effect immediately.\n');
    else console.log('  No proxy running. Override saved for next launch.\n');
    return;
  }

  // Subagent model
  if (flags.subagentmodel !== undefined) {
    if (!flags.subagentmodel) {
      try {
        rmSync(join(DEEPCLAUDE_DIR, 'subagent-model.json'), { force: true });
        console.log(`\n  Cleared dedicated subagent model.\n`);
      } catch {}
      return;
    }
    const [provKey, modelId] = flags.subagentmodel.split(':');
    if (!providers[provKey]) fail(`Unknown provider '${provKey}'.`);
    if (!getProviderKey(provKey)) fail(`No API key for '${provKey}'.`);
    writeAtomic(
      join(DEEPCLAUDE_DIR, 'subagent-model.json'),
      JSON.stringify({ providerKey: provKey, modelId }),
    );
    console.log(`\n  Set dedicated subagent model: ${flags.subagentmodel}\n`);
    return;
  }

  // Thinking overrides
  if (flags.nothinking || flags.thinkingBudget > 0) {
    try {
      launcher(
        'thinking-overrides',
        `--no-thinking=${flags.nothinking}`,
        `--budget=${flags.thinkingBudget || 0}`,
      );
      console.log(`  Thinking config updated.`);
    } catch (e) {
      fail(e.message);
    }
  }

  // Install statusline
  if (flags.installstatusline) {
    const src = join(ROOT, 'statusline', 'statusline.mjs');
    const dest = join(homedir(), '.claude', 'statusline.mjs');
    if (!existsSync(dirname(dest))) mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, readFileSync(src, 'utf-8'));
    console.log(`  Statusline installed to ${dest}`);
    console.log(
      `  Add to ~/.claude/settings.json: { "statusLine": { "type": "command", "command": "node ${dest}" } }`,
    );
    return;
  }

  // Logs
  if (flags.logs || flags.tail) {
    const logPath = join(DEEPCLAUDE_DIR, 'proxy.log');
    if (!existsSync(logPath)) {
      warn('No proxy log found.');
      return;
    }
    spawn(
      IS_WIN ? 'powershell' : 'tail',
      IS_WIN
        ? ['-Command', `Get-Content "${logPath}" -Tail 50 -Wait`]
        : ['-n', '50', '-f', logPath],
      { stdio: 'inherit' },
    );
    await new Promise(() => {}); // wait forever
    return;
  }

  // Dashboard
  if (flags.dashboard) {
    // Start proxy with current config
    const specs = resolveSpecs(flags, configs);
    const isAnthropic = specs.length === 1 && specs[0] === 'anthropic';
    if (isAnthropic) fail('--dashboard requires a non-anthropic config.');
    const key = Object.keys(configs).includes(specs[0]) ? 'name' : 'specs';
    const val = key === 'name' ? specs[0] : specs.join(',');
    const routesJson = launcher('build-routes', `--${key}=${val}`);
    launcher('init-overrides', `--${key}=${val}`);
    const routesFile = join(DEEPCLAUDE_DIR, 'current-routes.json');
    const overridesFile = join(DEEPCLAUDE_DIR, 'slot-overrides.json');
    writeAtomic(
      routesFile,
      typeof routesJson === 'string' ? routesJson : JSON.stringify(routesJson),
    );
    showAvWarning();
    const { port } = await startProxy(
      routesFile,
      overridesFile,
      join(DEEPCLAUDE_DIR, 'thinking-overrides.json'),
      flags,
    );
    const url = `http://127.0.0.1:${port}/dashboard`;
    console.log(`\n  Dashboard: ${url}`);
    if (flags.open) {
      spawn(IS_WIN ? 'cmd' : 'open', IS_WIN ? ['/c', 'start', '', url] : [url], {
        stdio: 'ignore',
        detached: true,
      }).unref();
    }
    // Keep running until Ctrl+C
    await new Promise(() => {});
    return;
  }

  // Benchmark
  if (flags.benchmark) {
    console.log(`\n  Latency Benchmark`);
    console.log(`  ==================\n`);
    const results = [];
    for (const id of Object.keys(configs)) {
      try {
        const resolved = launcher('resolve-config', `--name=${id}`);
        const opus = resolved.slots.opus;
        const prov = resolved.providers[opus.provider];
        if (!prov.key) continue;
        const url = prov.url.replace(/\/+$/, '') + '/v1/messages';
        const headers =
          prov.auth === 'bearer'
            ? {
                Authorization: `Bearer ${prov.key}`,
                'Content-Type': 'application/json',
                'anthropic-version': '2023-06-01',
              }
            : {
                'x-api-key': prov.key,
                'Content-Type': 'application/json',
                'anthropic-version': '2023-06-01',
              };
        const body = JSON.stringify({
          model: opus.model,
          max_tokens: 32,
          messages: [{ role: 'user', content: 'Reply: ok' }],
        });
        const start = Date.now();
        try {
          await new Promise((resolve, reject) => {
            const req = (url.startsWith('https') ? require('https') : require('http')).request(
              url,
              { method: 'POST', headers, timeout: 30000 },
              (res) => {
                let d = '';
                res.on('data', (c) => (d += c));
                res.on('end', () => resolve(d));
              },
            );
            req.on('error', reject);
            req.write(body);
            req.end();
          });
          results.push({ id, name: resolved.name, ok: true, ms: Date.now() - start });
        } catch (e) {
          results.push({
            id,
            name: resolved.name,
            ok: false,
            code: e.code || 'timeout',
            ms: Date.now() - start,
          });
        }
      } catch {
        /* skip unavailable */
      }
    }
    for (const r of results) {
      console.log(
        `  ${r.name} ${r.ok ? `${C.G}OK${C.X} (${r.ms}ms)` : `${C.R}FAIL${C.X} (${r.code}, ${r.ms}ms)`}`,
      );
    }
    console.log();
    return;
  }

  // ─── Launch CC ───────────────────────────────────────────────────────
  const specs = resolveSpecs(flags, configs);
  const isAnthropic = specs.length === 1 && specs[0] === 'anthropic';

  // Set effort
  process.env.CLAUDE_CODE_EFFORT_LEVEL = flags.effort;

  if (flags.remote) {
    if (isAnthropic) {
      const r = spawnSync(
        ...shellSafe(CLAUDE, [
          '--effort',
          flags.effort,
          '--dangerously-skip-permissions',
          'remote-control',
          ...flags.specs,
        ]),
        { stdio: 'inherit', ...(IS_WIN ? { shell: true } : {}) },
      );
      process.exit(r.status || 0);
    }
    // Start proxy for remote
    const key = Object.keys(configs).includes(specs[0]) ? 'name' : 'specs';
    const val = key === 'name' ? specs[0] : specs.join(',');
    const routesJson = launcher('build-routes', `--${key}=${val}`);
    launcher('init-overrides', `--${key}=${val}`);
    const routesFile = join(DEEPCLAUDE_DIR, 'current-routes.json');
    const overridesFile = join(DEEPCLAUDE_DIR, 'slot-overrides.json');
    writeAtomic(
      routesFile,
      typeof routesJson === 'string' ? routesJson : JSON.stringify(routesJson),
    );
    showAvWarning();
    const { port } = await startProxy(
      routesFile,
      overridesFile,
      join(DEEPCLAUDE_DIR, 'thinking-overrides.json'),
      flags,
    );
    console.log(`  Proxy on :${port}`);

    // Set env vars
    const resolved = launcher('resolve-config', `--${key}=${val}`);
    const envVars = launcher(
      'env-vars',
      `--port=${port}`,
      `--opus=${resolved.slots.opus.model}`,
      `--sonnet=${resolved.slots.sonnet.model}`,
      `--haiku=${resolved.slots.haiku.model}`,
      `--subagent=${resolved.slots.subagent.model}`,
      `--fable=${resolved.slots.fable.model}`,
    );
    for (const [k, v] of Object.entries(envVars)) {
      if (k === '_unset') continue;
      process.env[k] = v;
    }
    for (const uk of envVars._unset || []) delete process.env[uk];

    const r = spawnSync(
      'claude',
      [
        '--effort',
        flags.effort,
        '--dangerously-skip-permissions',
        'remote-control',
        ...flags.specs,
      ],
      { stdio: 'inherit' },
    );
    process.exit(r.status || 0);
  }

  // Normal (non-remote) launch
  if (isAnthropic) {
    // Anthropic direct — just launch CC
    const r = spawnSync(
      ...shellSafe(CLAUDE, [
        '--effort',
        flags.effort,
        '--dangerously-skip-permissions',
        ...flags.specs,
      ]),
      {
        stdio: 'inherit',
        env: { ...process.env },
        ...(IS_WIN ? { shell: true } : {}),
      },
    );
    process.exit(r.status || 0);
  }

  // Build routes and start proxy for normal launch
  const key = Object.keys(configs).includes(specs[0]) ? 'name' : 'specs';
  const val = key === 'name' ? specs[0] : specs.join(',');
  const resolved = launcher('resolve-config', `--${key}=${val}`);
  const routesJson = launcher('build-routes', `--${key}=${val}`);
  launcher('init-overrides', `--${key}=${val}`);
  const routesFile = join(DEEPCLAUDE_DIR, 'current-routes.json');
  const overridesFile = join(DEEPCLAUDE_DIR, 'slot-overrides.json');
  writeAtomic(routesFile, typeof routesJson === 'string' ? routesJson : JSON.stringify(routesJson));
  showAvWarning();

  const { port, proc: proxyProc } = await startProxy(
    routesFile,
    overridesFile,
    join(DEEPCLAUDE_DIR, 'thinking-overrides.json'),
    flags,
  );
  console.log(`  Proxy on :${port}`);

  // Set env vars
  const envVars = launcher(
    'env-vars',
    `--port=${port}`,
    `--opus=${resolved.slots.opus.model}`,
    `--sonnet=${resolved.slots.sonnet.model}`,
    `--haiku=${resolved.slots.haiku.model}`,
    `--subagent=${resolved.slots.subagent.model}`,
    `--fable=${resolved.slots.fable.model}`,
  );
  for (const [k, v] of Object.entries(envVars)) {
    if (k === '_unset') continue;
    process.env[k] = v;
  }
  for (const uk of envVars._unset || []) delete process.env[uk];

  // Launch CC
  const ccArgs = ['--effort', flags.effort, '--dangerously-skip-permissions', ...flags.specs];
  const ccProc = spawn(...shellSafe(CLAUDE, ccArgs), {
    stdio: 'inherit',
    env: { ...process.env },
    ...(IS_WIN ? { shell: true } : {}),
  });

  // Cleanup on CC exit
  ccProc.on('exit', () => {
    try {
      if (IS_WIN) execSync(`taskkill /PID ${proxyProc.pid} /T /F`, { stdio: 'ignore' });
      else proxyProc.kill('SIGKILL');
    } catch {}
    process.exit(ccProc.exitCode || 0);
  });

  process.on('SIGINT', () => {
    try {
      ccProc.kill('SIGINT');
    } catch {}
  });
  process.on('SIGTERM', () => {
    try {
      ccProc.kill('SIGTERM');
    } catch {}
  });
}

// ─── Help ──────────────────────────────────────────────────────────────
function cmdHelp(configs) {
  const names = Object.keys(configs).join(', ');
  console.log(`deepclaude — Provider-agnostic Claude Code wrapper
Usage: deepclaude [spec1] [spec2] [spec3] [spec4] [spec5]   (positional mode)
       deepclaude [-b backend] [--status] [--doctor] [--version]

  Each positional arg is providerKey:modelId, mapping to opus/sonnet/haiku/subagent/fable.
  Fewer than 5 specs repeats the last one for remaining slots.

  Examples:
    deepclaude ds:deepseek-v4-pro oc:big-pickle or:z-ai/glm-4.5-air:free
    deepclaude ds:deepseek-v4-pro oc:big-pickle    (opus/sonnet/haiku=DS, sub/fable=OC)
    deepclaude ds:deepseek-v4-pro                  (all 5 slots use DS)
    deepclaude -b ds                               (named config)
    deepclaude -b anthropic                        (Anthropic direct)

  Named configs: ${names}, anthropic
  --status        Show keys and configurations
  --stats         Show proxy request stats and health
  --cost          Pricing comparison
  --benchmark     Latency test across all configs
  --remote        Browser-based remote control
  --models        List all available models
  --set-slot SLOT MODEL  Override a slot (opus/sonnet/haiku/subagent/fable)
  --subagent-model MODEL  Set a dedicated subagent model
  --lint          Self-lint (PSScriptAnalyzer on .ps1, shellcheck on .sh)
  --lint-config   Validate providers.json
  --log-all       Log all requests
  --skip-startup-check  Skip provider health check on proxy startup
  --no-thinking   Disable extended thinking for all models
  --thinking-budget N   Set thinking budget in tokens
  --logs, --tail   Tail proxy log
  --health         Quick health check
  --cleanup        Purge old cc-spend files and show provider spend
  --cleanup-days N Days to keep (default: 7)
  --import-csv FILE  Import billing CSV (DeepSeek/OpenRouter) into spend.json
  --version       Print version
  --effort LEVEL  Set CC effort level (default: max)
  --fix-av        Print AV exclusion commands
  --probe [FILE]  Test each provider with a minimal prompt
  --dry-run [FILE] Show resolved routing table without starting proxy
  --dashboard     Start proxy and print health dashboard URL
  --open          Open dashboard in browser (use with --dashboard)
  --doctor        Run system health check
  --install-statusline  Install status bar (model, effort, context)

  Each session gets its own isolated proxy — no shared state.
`);
}

// ─── Main ──────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const flags = parseArgs(args);
  const { configs } = loadProviders();

  await launchCC(flags, configs);
}

main().catch((err) => {
  fail(err.message);
});
