'use strict';

/**
 * Admin API — runtime configuration endpoints for Defiant Claude.
 *
 * Provides:
 *   GET /admin          — Admin web UI (HTML)
 *   GET /admin/config   — Full current config as JSON
 *   POST /admin/set-slot     — Set a slot override { slot, spec }
 *   POST /admin/set-budget   — Set daily budget { budget }
 *   POST /admin/set-thinking — Set thinking override { model, type, budget_tokens }
 *   POST /admin/reset-slot   — Remove a slot override { slot }
 *   GET  /admin/logs   — Tail recent request log entries ?lines=100
 *   POST /admin/test-provider — Test a provider connection { provider }
 *   POST /admin/switch-config — Switch to a named preset { name }
 */

import crypto from 'node:crypto';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { setDailyBudget } from './stats';
import { createLogger } from './log';

const log = createLogger('admin');

// --- Auth ---
// Reuse the dashboard key mechanism from dashboard.ts
let _adminKey: string | null = null;

export function getAdminKey(): string {
  if (!_adminKey) {
    _adminKey = process.env.DEFIANT_DASHBOARD_KEY || crypto.randomBytes(16).toString('hex');
  }
  return _adminKey;
}

function checkAdminAuth(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const key = getAdminKey();
  const provided = req.headers['x-dashboard-key'];

  if (typeof provided !== 'string' || provided.length !== key.length) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return false;
  }

  const match = crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(key));
  if (!match) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return false;
  }
  return true;
}

// --- Helpers ---

function readJsonFile(filePath: string): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeJsonFile(filePath: string, data: unknown): boolean {
  try {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    return true;
  } catch (e) {
    log.error(null, 'Failed to write ' + filePath + ': ' + (e as Error).message);
    return false;
  }
}

function maskKey(key: string | undefined | null): string {
  if (!key || key.length < 8) return '********';
  return key.slice(0, 4) + '****' + key.slice(-4);
}

/** Get the defined config directory. */
function getConfigDir(): string {
  return (
    process.env.DEFIANT_DIR || (process.env.HOME || process.env.USERPROFILE || '.') + '/.defiant'
  );
}

// ============================================================================
// Admin Endpoints
// ============================================================================

export interface AdminDeps {
  overridesFile: string | null;
  thinkingOverridesFile: string | null;
  providersFile: string | null;
  routing: Record<string, unknown> | null;
  slotOverrides: Record<string, string>;
  concurrencyStatus: unknown;
  rateLimiterStatus: unknown;
  port: number;
  providerDisplayNames?: Record<string, string>;
}

/** GET /admin/config — return full current config as JSON. */
function getConfigJson(deps: AdminDeps): Record<string, unknown> {
  const configDir = getConfigDir();
  const providersData = deps.providersFile ? readJsonFile(deps.providersFile) : null;
  const configs = (providersData && (providersData as Record<string, unknown>).configs) || {};
  const providerDefs =
    (providersData && (providersData as Record<string, unknown>).providers) || {};

  // Mask API keys from env vars for display
  const maskedEnvKeys: Record<string, string> = {};
  const keysToMask = [
    'DEEPSEEK_API_KEY',
    'OPENROUTER_API_KEY',
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'GEMINI_API_KEY',
    'FIREWORKS_API_KEY',
    'OPENCODE_API_KEY',
    'KIMI_API_KEY',
    'MIMO_API_KEY',
    'UMANS_API_KEY',
    'GROQ_API_KEY',
    'MISTRAL_API_KEY',
    'MINIMAX_API_KEY',
    'ZAI_API_KEY',
    'BYTEPLUS_API_KEY',
    'SILICONFLOW_API_KEY',
    'NOVITA_API_KEY',
    'XAI_API_KEY',
    'DEFIANT_BRAVE_API_KEY',
    'ALIBABA_DASHSCOPE_API_KEY',
  ];
  for (const k of keysToMask) {
    if (process.env[k]) maskedEnvKeys[k] = maskKey(process.env[k]);
  }

  // Enumerate providers with key status
  type ProviderEntry = {
    key: string;
    displayName: string;
    hasKey: boolean;
    healthy: boolean;
    wireFormat: string;
  };
  const providers: ProviderEntry[] = [];
  for (const [key, def] of Object.entries(
    providerDefs as Record<string, Record<string, unknown>>,
  )) {
    const keyEnv = def.keyEnv as string | undefined;
    const hasKey = keyEnv
      ? !!process.env[keyEnv]
      : (def as Record<string, unknown>).noAuth === true;
    providers.push({
      key,
      displayName: (def.displayName as string) || key,
      hasKey,
      healthy: false, // populated by health data on the frontend
      wireFormat: (def.wireFormat as string) || 'unknown',
    });
  }

  return {
    slotOverrides: deps.slotOverrides,
    availableConfigs: configs,
    availableProviders: providers,
    maskedEnvKeys,
    dailyBudget: process.env.DEFIANT_DAILY_BUDGET || '0',
    budgetWarning: process.env.DEFIANT_BUDGET_WARNING || '',
    configDir,
    port: deps.port,
    thinkingOverridesFile: deps.thinkingOverridesFile,
    thinkingConfig: providersData ? (providersData as Record<string, unknown>).thinking : {},
  };
}

/** POST /admin/set-slot — set a slot override. */
function handleSetSlot(
  body: Record<string, unknown>,
  deps: AdminDeps,
): { ok: boolean; message: string } {
  const slot = String(body.slot || '');
  const spec = String(body.spec || '');
  const validSlots = ['opus', 'sonnet', 'haiku', 'subagent', 'fable'];

  if (!validSlots.includes(slot)) {
    return { ok: false, message: 'Invalid slot. Valid slots: ' + validSlots.join(', ') };
  }
  if (!spec.includes(':') && spec !== '') {
    return {
      ok: false,
      message: 'Spec must be in format "provider:model" (e.g. "ds:deepseek-v4-pro")',
    };
  }

  const overridesFile = deps.overridesFile;
  if (!overridesFile) {
    return { ok: false, message: 'No overrides file configured. Cannot persist slot override.' };
  }

  // Read existing overrides
  const current = (readJsonFile(overridesFile) as Record<string, string> | null) || {};

  if (spec === '') {
    delete current[slot];
  } else {
    current[slot] = spec;
  }

  if (writeJsonFile(overridesFile, current)) {
    return {
      ok: true,
      message:
        'Slot "' +
        slot +
        '" set to "' +
        spec +
        '". Takes effect on next request. Hot-reload will pick it up.',
    };
  }
  return { ok: false, message: 'Failed to write overrides file.' };
}

/** POST /admin/set-budget — set daily budget. */
function handleSetBudget(body: Record<string, unknown>): { ok: boolean; message: string } {
  const raw = body.budget;
  const budget = typeof raw === 'number' ? raw : parseFloat(String(raw || ''));
  if (isNaN(budget) || budget < 0) {
    return { ok: false, message: 'Budget must be a non-negative number.' };
  }

  setDailyBudget(budget);
  // Also update process.env so hot-path checks in start-proxy.ts see it
  process.env.DEFIANT_DAILY_BUDGET = String(budget);

  return {
    ok: true,
    message: 'Daily budget set to $' + budget.toFixed(2) + '. Takes effect immediately.',
  };
}

/** POST /admin/set-thinking — set a thinking override. */
function handleSetThinking(
  body: Record<string, unknown>,
  deps: AdminDeps,
): { ok: boolean; message: string } {
  const model = String(body.model || '');
  const type = String(body.type || '');
  const rawTokens = body.budget_tokens;
  const budgetTokens =
    typeof rawTokens === 'number' ? rawTokens : parseInt(String(rawTokens || '0'), 10);

  if (!model) {
    return { ok: false, message: 'Model is required.' };
  }
  if (type !== 'enabled' && type !== 'disabled') {
    return { ok: false, message: 'Type must be "enabled" or "disabled".' };
  }
  if (type === 'enabled' && (!budgetTokens || budgetTokens < 1024)) {
    return { ok: false, message: 'Budget tokens must be >= 1024 for enabled thinking.' };
  }

  const thinkingFile = deps.thinkingOverridesFile;
  if (!thinkingFile) {
    return { ok: false, message: 'No thinking overrides file configured.' };
  }

  const current = (readJsonFile(thinkingFile) as Record<string, unknown>) || {};
  if (type === 'disabled') {
    current[model] = null;
  } else {
    current[model] = { type: 'enabled', budget_tokens: budgetTokens };
  }

  if (writeJsonFile(thinkingFile, current)) {
    return {
      ok: true,
      message:
        'Thinking for "' +
        model +
        '" set to ' +
        type +
        (type === 'enabled' ? ' (' + budgetTokens + ' tokens)' : ''),
    };
  }
  return { ok: false, message: 'Failed to write thinking overrides file.' };
}

/** POST /admin/reset-slot — remove a slot override. */
function handleResetSlot(
  body: Record<string, unknown>,
  deps: AdminDeps,
): { ok: boolean; message: string } {
  return handleSetSlot({ slot: body.slot, spec: '' }, deps);
}

/** GET /admin/logs — tail recent request log entries. */
function getLogs(url: string): { entries: string[]; ok: boolean } {
  const linesParam = (url.match(/lines=(\d+)/) || [])[1];
  const maxLines = Math.min(Math.max(parseInt(linesParam || '100', 10) || 100, 1), 5000);
  const logFile = path.join(getConfigDir(), 'requests.log');

  try {
    if (!fs.existsSync(logFile)) {
      return { entries: ['No request log file found at: ' + logFile], ok: true };
    }
    const raw = fs.readFileSync(logFile, 'utf-8');
    const allLines = raw.trim().split('\n').filter(Boolean);
    const recent = allLines.slice(-maxLines);
    return { entries: recent, ok: true };
  } catch (e) {
    return { entries: ['Error reading log: ' + (e as Error).message], ok: false };
  }
}

/** POST /admin/switch-config — write a new routes file from a named preset. */
function handleSwitchConfig(
  body: Record<string, unknown>,
  deps: AdminDeps,
): { ok: boolean; message: string } {
  const name = String(body.name || '');
  if (!name) {
    return { ok: false, message: 'Config name is required.' };
  }

  // Read providers.json to get the config
  const providersFile = deps.providersFile;
  if (!providersFile) {
    return { ok: false, message: 'No providers file configured.' };
  }

  const providersData = readJsonFile(providersFile) as Record<string, unknown> | null;
  if (!providersData) {
    return { ok: false, message: 'Failed to read providers file.' };
  }

  const configs = (providersData as Record<string, unknown>).configs as Record<string, unknown>;
  if (!configs || !configs[name]) {
    return {
      ok: false,
      message: 'Unknown config "' + name + '". Available: ' + Object.keys(configs || {}).join(', '),
    };
  }

  const cfg = configs[name] as Record<string, string>;
  const routesFile = path.join(getConfigDir(), 'current-routes.json');

  // Read current routes to merge in the new config
  const currentRoutes = (readJsonFile(routesFile) as Record<string, unknown>) || {};
  currentRoutes.defaultProvider = name;

  // Build slot mappings from config + existing provider defs
  const slots: Record<string, string> = {};
  for (const slot of ['opus', 'sonnet', 'haiku', 'subagent', 'fable']) {
    const spec = cfg[slot];
    if (spec) slots[slot] = spec;
  }

  currentRoutes.slots = slots;

  if (writeJsonFile(routesFile, currentRoutes)) {
    return {
      ok: true,
      message: 'Switched to config "' + name + '". Changes take effect on next request.',
    };
  }
  return { ok: false, message: 'Failed to write routes file.' };
}

// ============================================================================
// Request Router
// ============================================================================

/** Handle an admin request. Returns true if handled. */
export function handleAdminRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: AdminDeps,
): boolean {
  const url = req.url || '';
  const method = req.method || 'GET';

  // All admin endpoints require auth except the admin HTML page itself
  // (the HTML page already authenticates at the /dashboard level)
  if (url.startsWith('/admin/api/') && !checkAdminAuth(req, res)) return true;

  // GET /admin — admin HTML page
  if (method === 'GET' && url === '/admin') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(buildAdminHtml(deps));
    return true;
  }

  // GET /admin/api/config
  if (method === 'GET' && url === '/admin/api/config') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(getConfigJson(deps)));
    return true;
  }

  // POST /admin/api/set-slot
  if (method === 'POST' && url === '/admin/api/set-slot') {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        const result = handleSetSlot(parsed, deps);
        res.writeHead(result.ok ? 200 : 400, { 'content-type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, message: 'Invalid JSON: ' + (e as Error).message }));
      }
    });
    return true;
  }

  // POST /admin/api/reset-slot
  if (method === 'POST' && url === '/admin/api/reset-slot') {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        const result = handleResetSlot(parsed, deps);
        res.writeHead(result.ok ? 200 : 400, { 'content-type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (_e) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, message: 'Invalid JSON' }));
      }
    });
    return true;
  }

  // POST /admin/api/set-budget
  if (method === 'POST' && url === '/admin/api/set-budget') {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        const result = handleSetBudget(parsed);
        res.writeHead(result.ok ? 200 : 400, { 'content-type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (_e) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, message: 'Invalid JSON' }));
      }
    });
    return true;
  }

  // POST /admin/api/set-thinking
  if (method === 'POST' && url === '/admin/api/set-thinking') {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        const result = handleSetThinking(parsed, deps);
        res.writeHead(result.ok ? 200 : 400, { 'content-type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (_e) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, message: 'Invalid JSON' }));
      }
    });
    return true;
  }

  // GET /admin/api/logs
  if (method === 'GET' && url.startsWith('/admin/api/logs')) {
    const result = getLogs(url);
    res.writeHead(result.ok ? 200 : 500, { 'content-type': 'application/json' });
    res.end(JSON.stringify(result));
    return true;
  }

  // POST /admin/api/switch-config
  if (method === 'POST' && url === '/admin/api/switch-config') {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        const result = handleSwitchConfig(parsed, deps);
        res.writeHead(result.ok ? 200 : 400, { 'content-type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (_e) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, message: 'Invalid JSON' }));
      }
    });
    return true;
  }

  return false;
}

// ============================================================================
// Admin UI HTML
// ============================================================================

function buildAdminHtml(_deps: AdminDeps): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Defiant Claude Admin</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0d1117;color:#c9d1d9;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;font-size:14px;padding:20px}
h1{font-size:20px;font-weight:600;color:#58a6ff;margin-bottom:16px}
.tabs{display:flex;gap:4px;margin-bottom:20px;border-bottom:1px solid #30363d;padding-bottom:0}
.tab{padding:10px 18px;background:#161b22;border:1px solid #30363d;border-bottom:none;border-radius:8px 8px 0 0;cursor:pointer;color:#8b949e;font-size:13px;font-weight:500}
.tab:hover{color:#c9d1d9;background:#1c2128}
.tab.active{background:#0d1117;color:#58a6ff;border-color:#58a6ff;position:relative}
.tab-panel{display:none;margin-top:16px}
.tab-panel.active{display:block}
.card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:20px;margin-bottom:16px}
.card h2{font-size:15px;font-weight:600;margin-bottom:12px;color:#c9d1d9}
.card h3{font-size:13px;font-weight:600;margin-bottom:8px;color:#8b949e}
.form-group{margin-bottom:14px}
label{display:block;font-size:12px;color:#8b949e;margin-bottom:4px}
input,select,textarea{width:100%;padding:8px 12px;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px}
input:focus,select:focus{outline:none;border-color:#58a6ff}
select option{background:#0d1117;color:#c9d1d9}
button{padding:8px 20px;background:#238636;border:1px solid #2ea043;border-radius:6px;color:#fff;font-size:13px;font-weight:500;cursor:pointer}
button:hover{background:#2ea043}
button.danger{background:#3d141b;border-color:#f85149}
button.danger:hover{background:#5c1a24}
button.secondary{background:#21262d;border-color:#30363d;color:#c9d1d9}
button.secondary:hover{background:#30363d}
.msg{padding:8px 14px;border-radius:6px;margin-bottom:12px;font-size:13px;display:none}
.msg-ok{background:#1b4721;color:#3fb950;border:1px solid #3fb950;display:block}
.msg-err{background:#3d141b;color:#f85149;border:1px solid #f85149;display:block}
.status-row{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px}
.status-label{color:#8b949e;font-size:11px}
.status-value{color:#c9d1d9;font-weight:500}
.grid-2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.slot-row{display:flex;gap:8px;align-items:center;margin-bottom:10px}
.slot-row label{width:80px;margin:0;padding-top:6px}
.slot-row select{flex:2}
.slot-row input[name="spec"]{flex:3}
.slot-row button{width:auto;white-space:nowrap}
.logs-area{background:#0d1117;border:1px solid #30363d;border-radius:6px;padding:12px;font-family:monospace;font-size:11px;max-height:400px;overflow:auto;white-space:pre-wrap;color:#8b949e}
.loading{color:#8b949e;text-align:center;padding:20px}
@media(max-width:800px){.grid-2,.status-row{grid-template-columns:1fr}}
</style>
</head>
<body>
<h1>Defiant Claude Admin</h1>
<div id="msg" class="msg"></div>

<div class="tabs">
<div class="tab active" data-tab="slots" onclick="switchTab('slots')">Slots</div>
<div class="tab" data-tab="budget" onclick="switchTab('budget')">Budget</div>
<div class="tab" data-tab="thinking" onclick="switchTab('thinking')">Thinking</div>
<div class="tab" data-tab="config" onclick="switchTab('config')">Config</div>
<div class="tab" data-tab="logs" onclick="switchTab('logs')">Logs</div>
</div>

<!-- Slots -->
<div id="panel-slots" class="tab-panel active">
<div class="card">
<h2>Slot Overrides</h2>
<p style="color:#8b949e;margin-bottom:14px;font-size:12px">Route each model slot to a specific provider:model pair. Takes effect on the next request.</p>
<div id="slot-list"></div>
<button onclick="addSlotRow()" class="secondary" style="margin-top:8px">+ Add Slot Override</button>
</div>
</div>

<!-- Budget -->
<div id="panel-budget" class="tab-panel">
<div class="card">
<h2>Daily Budget</h2>
<div class="form-group">
<label for="budget-input">Daily spending cap (USD, 0 = unlimited)</label>
<input id="budget-input" type="number" step="0.01" min="0" value="0">
</div>
<button onclick="saveBudget()">Save Budget</button>
</div>
<div class="card">
<h2>Current Spend</h2>
<div id="budget-status" class="loading">Loading...</div>
</div>
</div>

<!-- Thinking -->
<div id="panel-thinking" class="tab-panel">
<div class="card">
<h2>Thinking Overrides</h2>
<p style="color:#8b949e;margin-bottom:14px;font-size:12px">Configure extended thinking per model (DeepSeek V4 supports thinking mode).</p>
<div class="form-group">
<label for="think-model">Model ID</label>
<input id="think-model" placeholder="e.g. deepseek-v4-pro">
</div>
<div class="grid-2">
<div class="form-group">
<label for="think-type">Type</label>
<select id="think-type"><option value="enabled">Enabled</option><option value="disabled">Disabled</option></select>
</div>
<div class="form-group">
<label for="think-tokens">Budget Tokens</label>
<input id="think-tokens" type="number" min="1024" value="32000" step="1024">
</div>
</div>
<button onclick="saveThinking()">Save Thinking Override</button>
</div>
</div>

<!-- Config -->
<div id="panel-config" class="tab-panel">
<div class="card">
<h2>Switch Config Preset</h2>
<div class="form-group">
<label for="config-select">Config</label>
<select id="config-select"></select>
</div>
<button onclick="switchConfig()">Switch Config</button>
</div>
<div class="card">
<h2>Current Config</h2>
<div id="config-status" class="loading">Loading...</div>
</div>
</div>

<!-- Logs -->
<div id="panel-logs" class="tab-panel">
<div class="card">
<h2>Request Log</h2>
<div style="display:flex;gap:8px;margin-bottom:12px;align-items:center">
<label for="log-lines" style="margin:0;width:auto">Lines:</label>
<select id="log-lines" style="width:80px">
<option value="50">50</option>
<option value="100" selected>100</option>
<option value="500">500</option>
</select>
<button onclick="loadLogs()" style="width:auto">Refresh</button>
</div>
<div id="logs-content" class="loading">Click "Refresh" to load logs.</div>
</div>
</div>

<script>
var configData = null;
var SLOTS = ['opus','sonnet','haiku','subagent','fable'];

function msg(text, isErr) {
  var el = document.getElementById('msg');
  el.textContent = text;
  el.className = 'msg ' + (isErr ? 'msg-err' : 'msg-ok');
  setTimeout(function(){ el.style.display = 'none' }, 5000);
}

function switchTab(name) {
  document.querySelectorAll('.tab').forEach(function(t){ t.classList.remove('active') });
  document.querySelectorAll('.tab-panel').forEach(function(p){ p.classList.remove('active') });
  document.querySelector('.tab[data-tab="' + name + '"]').classList.add('active');
  document.getElementById('panel-' + name).classList.add('active');
}

function api(method, path, body, cb) {
  var x = new XMLHttpRequest();
  x.open(method, path);
  x.setRequestHeader('Content-Type', 'application/json');
  x.setRequestHeader('X-Dashboard-Key', getKey());
  x.onload = function() {
    try { cb(JSON.parse(x.responseText)); } catch(e) { cb({ ok: false, message: x.responseText }) }
  };
  x.onerror = function() { cb({ ok: false, message: 'Network error' }) };
  x.send(body ? JSON.stringify(body) : null);
}

function getKey() {
  var k = sessionStorage.getItem('dashboardKey');
  if (!k) {
    k = prompt('Enter dashboard key:');
    if (k) sessionStorage.setItem('dashboardKey', k);
  }
  return k || '';
}

// --- Slots ---
function renderSlots() {
  var list = document.getElementById('slot-list');
  list.innerHTML = '';
  var hasOverrides = false;
  for (var i = 0; i < SLOTS.length; i++) {
    var s = SLOTS[i];
    var val = configData && configData.slotOverrides ? (configData.slotOverrides[s] || '') : '';
    if (val) hasOverrides = true;
    var row = document.createElement('div');
    row.className = 'slot-row';

    var label = document.createElement('label');
    label.textContent = s;
    row.appendChild(label);

    var input = document.createElement('input');
    input.name = 'spec';
    input.placeholder = 'provider:model (e.g. ds:deepseek-v4-pro)';
    input.value = val;
    row.appendChild(input);

    var btn = document.createElement('button');
    btn.textContent = val ? 'Remove' : 'Set';
    btn.className = val ? 'danger' : '';
    btn.onclick = function(slot, inp) {
      return function() {
        var spec = inp.value.trim();
        if (spec) {
          api('POST', '/admin/api/set-slot', { slot: slot, spec: spec }, function(r) {
            msg(r.message, !r.ok);
            if (r.ok) loadConfig();
          });
        } else {
          api('POST', '/admin/api/reset-slot', { slot: slot }, function(r) {
            msg(r.message, !r.ok);
            if (r.ok) loadConfig();
          });
        }
      };
    }(s, input);
    row.appendChild(btn);
    list.appendChild(row);
  }
  if (!hasOverrides) {
    var note = document.createElement('p');
    note.style.cssText = 'color:#8b949e;font-size:12px;margin-top:8px';
    note.textContent = 'No slot overrides set. Claude Code will use the default config providers.';
    list.appendChild(note);
  }
}

// --- Budget ---
function saveBudget() {
  var v = parseFloat(document.getElementById('budget-input').value) || 0;
  api('POST', '/admin/api/set-budget', { budget: v }, function(r) {
    msg(r.message, !r.ok);
    if (r.ok) loadConfig();
  });
}

// --- Thinking ---
function saveThinking() {
  var model = document.getElementById('think-model').value.trim();
  var type = document.getElementById('think-type').value;
  var tokens = parseInt(document.getElementById('think-tokens').value) || 32000;
  if (!model) { msg('Model ID is required', true); return; }
  api('POST', '/admin/api/set-thinking', { model: model, type: type, budget_tokens: tokens }, function(r) {
    msg(r.message, !r.ok);
  });
}

// --- Config ---
function switchConfig() {
  var sel = document.getElementById('config-select');
  var name = sel.value;
  if (!name) return;
  api('POST', '/admin/api/switch-config', { name: name }, function(r) {
    msg(r.message, !r.ok);
  });
}

// --- Logs ---
function loadLogs() {
  var lines = document.getElementById('log-lines').value;
  var el = document.getElementById('logs-content');
  el.textContent = 'Loading...';
  el.className = 'loading';
  api('GET', '/admin/api/logs?lines=' + lines, null, function(r) {
    el.className = 'logs-area';
    if (r.ok && r.entries) {
      el.textContent = r.entries.join('\\n');
    } else {
      el.textContent = r.message || 'Failed to load logs';
    }
  });
}

// --- Load initial config ---
function loadConfig() {
  api('GET', '/admin/api/config', null, function(data) {
    configData = data;
    // Slots
    renderSlots();
    // Budget
    if (data.dailyBudget) document.getElementById('budget-input').value = data.dailyBudget;
    // Config selector
    var sel = document.getElementById('config-select');
    if (data.availableConfigs) {
      var keys = Object.keys(data.availableConfigs);
      sel.innerHTML = '';
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        var cfg = data.availableConfigs[k];
        var opt = document.createElement('option');
        opt.value = k;
        opt.textContent = (cfg.name || k) + ' (' + k + ')';
        sel.appendChild(opt);
      }
    }
  });
}
loadConfig();

// Auto-refresh every 10s
setInterval(function() { api('GET', '/admin/api/config', null, function(d) { configData = d }) }, 10000);
</script>
</body>
</html>`;
}
