#!/usr/bin/env node
'use strict';
// Defiant Claude unified launcher engine — single source of truth for config
// resolution, routes JSON, slot overrides, thinking overrides, env vars,
// and display data. Invoked by both defiant.ps1 and defiant.sh.

import {
  readFileSync,
  existsSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  chmodSync,
  readdirSync,
} from 'fs';
import { join, dirname, resolve } from 'path';
import { homedir, platform } from 'os';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

// --- Paths ---
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const HOME = homedir();
const DEFIANT_DIR = join(HOME, '.defiant');
const SLOT_OVERRIDES_FILE = join(DEFIANT_DIR, 'slot-overrides.json');
const THINKING_OVERRIDES_FILE = join(DEFIANT_DIR, 'thinking-overrides.json');
const SUBMODEL_FILE = join(DEFIANT_DIR, 'subagent-model.json');
const REGISTRY_FILE = join(SCRIPT_DIR, 'providers.json');
const SLOTS = ['opus', 'sonnet', 'haiku', 'subagent', 'fable'];

// --- Lazy-loaded registry ---
let _registry;
function registry() {
  if (!_registry) {
    const raw = readFileSync(REGISTRY_FILE, 'utf-8');
    _registry = JSON.parse(raw);
  }
  return _registry;
}

// --- Helpers ---
export function keyEnvToShortName(keyEnv) {
  const map = {
    DEEPSEEK_API_KEY: 'ds',
    OPENROUTER_API_KEY: 'or',
    FIREWORKS_API_KEY: 'fw',
    OPENCODE_API_KEY: 'oc',
    ALIBABA_DASHSCOPE_API_KEY: 'al',
    KIMI_API_KEY: 'km',
    MIMO_API_KEY: 'mm',
    UMANS_API_KEY: 'um',
    GROQ_API_KEY: 'gr',
    MISTRAL_API_KEY: 'mt',
    MINIMAX_API_KEY: 'mx',
    ZAI_API_KEY: 'za',
    BYTEPLUS_API_KEY: 'bp',
    SILICONFLOW_API_KEY: 'sf',
    NOVITA_API_KEY: 'nv',
    GROK_API_KEY: 'gk',
  };
  return map[keyEnv] || '';
}

function readWinReg(name) {
  if (platform() !== 'win32') return null;
  try {
    const out = spawnSync('reg', ['query', 'HKCU\\Environment', '/v', name], {
      encoding: 'utf8',
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

export function getKey(pk) {
  const reg = registry();
  const prov = reg.providers[pk];
  if (!prov) return '';
  // noAuth providers skip key resolution entirely
  if (prov.noAuth) return '';
  // Try process.env first, then Windows registry (for detached proxy starts)
  return process.env[prov.keyEnv] || readWinReg(prov.keyEnv) || '';
}

export function maskKey(k) {
  if (!k) return 'MISSING';
  return 'set (****' + k.slice(-4) + ')';
}

export function parseSpec(spec) {
  const m = spec.match(/^([a-z][a-z0-9_-]*):(.+)$/);
  if (!m)
    throw new Error(
      `Invalid model spec '${spec}': expected providerKey:modelId (e.g. ds:deepseek-v4-pro)`,
    );
  return { provKey: m[1], modelId: m[2] };
}

export function stripSlotPrefix(val) {
  // Slot-override values may be stored with a slot prefix
  // (e.g. "haiku:ds:deepseek-v4-flash" as the value for key "haiku").
  // Strip the prefix so comparisons against _defaults (which stores
  // unprefixed "providerKey:modelId" like "ds:deepseek-v4-flash") work correctly.
  const m = val.match(/^(opus|sonnet|haiku|subagent|fable):(.+)$/);
  return m ? m[2] : val;
}

export function adhocSlotIndex(specCount, slotIndex) {
  // 1 spec:  [0, 0, 0, 0, 0]
  // 2 specs: [0, 0, 0, 1, 1]
  // 3 specs: [0, 1, 1, 2, 2]
  // 4 specs: [0, 1, 2, 3, 3]
  // 5 specs: [0, 1, 2, 3, 4]
  switch (specCount) {
    case 1:
      return 0;
    case 2:
      return slotIndex < 3 ? 0 : 1;
    case 3:
      return slotIndex === 0 ? 0 : slotIndex <= 2 ? 1 : 2;
    case 4:
      return slotIndex < 3 ? slotIndex : 3;
    default:
      return slotIndex;
  }
}

export function validateProvider(provKey, modelId, spec) {
  const reg = registry();
  const prov = reg.providers[provKey];
  if (!prov)
    throw new Error(
      `Unknown provider '${provKey}' in spec '${spec}'. Known: ${Object.keys(reg.providers).join(', ')}`,
    );
  const key = getKey(provKey);
  if (!key) {
    let msg = `${prov.keyEnv} not set (needed for spec '${spec}')`;
    if (prov.setupUrl)
      msg += `\n  Get a key: ${prov.setupUrl}\n  Then run: export ${prov.keyEnv}="sk-..."`;
    throw new Error(msg);
  }
  return prov;
}

// --- Config resolution ---
export function resolveConfig(configName) {
  const reg = registry();
  const cfg = reg.configs[configName];
  if (!cfg)
    throw new Error(
      `Unknown config '${configName}'. Known: ${Object.keys(reg.configs).join(', ')}`,
    );

  const resolved = {
    name: cfg.name,
    slots: {},
    modelProviders: {},
    providers: {},
    defaultProvider: '',
  };
  for (const slot of SLOTS) {
    const val = cfg[slot === 'subagent' ? 'sub' : slot] || cfg[slot];
    const { provKey, modelId } = parseSpec(val);
    validateProvider(provKey, modelId, val);
    resolved.slots[slot] = { provider: provKey, model: modelId };
    resolved.modelProviders[modelId] = provKey;
    if (!resolved.providers[provKey]) {
      const prov = reg.providers[provKey];
      resolved.providers[provKey] = {
        name: prov.displayName,
        url: prov.endpoint,
        keyEnv: prov.keyEnv,
        auth: prov.authHeader || 'bearer',
        format: prov.wireFormat || 'anthropic',
        key: getKey(provKey),
      };
      if (prov.fallback) resolved.providers[provKey].fallback = prov.fallback;
      if (prov.extraHeaders) resolved.providers[provKey].extraHeaders = prov.extraHeaders;
      if (prov.streamUsageReporting)
        resolved.providers[provKey].streamUsageReporting = prov.streamUsageReporting;
    }
  }
  resolved.defaultProvider = resolved.slots['opus'].provider;
  return resolved;
}

export function buildAdhocConfig(specs) {
  const reg = registry();
  const specCount = specs.length;
  const resolved = {
    name:
      'Ad-hoc: ' +
      specs
        .map((s) => {
          const { provKey, modelId } = parseSpec(s);
          const prov = reg.providers[provKey];
          return modelId + ' (' + (prov ? prov.displayName : provKey) + ')';
        })
        .join(' | '),
    slots: {},
    modelProviders: {},
    providers: {},
    defaultProvider: '',
  };
  for (let i = 0; i < 5; i++) {
    const idx = adhocSlotIndex(specCount, i);
    const spec = specs[idx];
    const { provKey, modelId } = parseSpec(spec);
    validateProvider(provKey, modelId, spec);
    const slot = SLOTS[i];
    resolved.slots[slot] = { provider: provKey, model: modelId };
    resolved.modelProviders[modelId] = provKey;
    if (!resolved.providers[provKey]) {
      const prov = reg.providers[provKey];
      resolved.providers[provKey] = {
        name: prov.displayName,
        url: prov.endpoint,
        keyEnv: prov.keyEnv,
        auth: prov.authHeader || 'bearer',
        format: prov.wireFormat || 'anthropic',
        key: getKey(provKey),
      };
      if (prov.fallback) resolved.providers[provKey].fallback = prov.fallback;
      if (prov.extraHeaders) resolved.providers[provKey].extraHeaders = prov.extraHeaders;
      if (prov.streamUsageReporting)
        resolved.providers[provKey].streamUsageReporting = prov.streamUsageReporting;
    }
  }
  resolved.defaultProvider = resolved.slots['opus'].provider;
  return resolved;
}

// --- Routes JSON ---
export function buildRoutesJson(resolved, includeAllModels = true) {
  const reg = registry();
  const routes = {};
  const providerEntries = {};

  // Active config routes
  for (const [modelId, provKey] of Object.entries(resolved.modelProviders)) {
    routes[modelId] = { provider: provKey, rewrite: modelId };
  }
  for (const [provKey, info] of Object.entries(resolved.providers)) {
    const fb = info.fallback || null;
    const entry = {
      url: info.url,
      keyEnv: info.keyEnv,
      auth: info.auth,
      format: info.format || 'anthropic',
      fallback: fb,
    };
    if (info.extraHeaders) entry.extraHeaders = info.extraHeaders;
    if (info.streamUsageReporting) entry.streamUsageReporting = info.streamUsageReporting;
    providerEntries[provKey] = entry;
  }

  // Include all models from all configs with valid keys (for /model switching)
  if (includeAllModels) {
    for (const cfg of Object.values(reg.configs)) {
      for (const slot of SLOTS) {
        const val = cfg[slot === 'subagent' ? 'sub' : slot] || cfg[slot];
        const { provKey, modelId } = parseSpec(val);
        const key = getKey(provKey);
        if (key && !routes[modelId]) {
          routes[modelId] = { provider: provKey, rewrite: modelId };
        }
        if (key && !providerEntries[provKey]) {
          const prov = reg.providers[provKey];
          const fb = prov.fallback || null;
          const entry = {
            url: prov.endpoint,
            keyEnv: prov.keyEnv,
            auth: prov.authHeader || 'bearer',
            format: prov.wireFormat || 'anthropic',
            fallback: fb,
          };
          if (prov.extraHeaders) entry.extraHeaders = prov.extraHeaders;
          if (prov.streamUsageReporting) entry.streamUsageReporting = prov.streamUsageReporting;
          providerEntries[provKey] = entry;
        }
      }
    }
  }

  // Build slots map
  const slotsMap = {};
  for (const [slot, s] of Object.entries(resolved.slots)) {
    slotsMap[slot] = `${slot}:${s.provider}:${s.model}`;
  }

  // Build context limits
  const ctxLimits = {};
  for (const [model, limit] of Object.entries(reg.contextLimits)) {
    if (!model.startsWith('_')) ctxLimits[model] = limit;
  }

  // Default prompt-router: route simple + mechanical requests to cheaper models.
  // TRIVIAL: <50 char single messages → free provider (greetings, "ok", "thanks")
  // TOOL: requests with tool definitions → flash (read/edit/write/bash)
  // CHAT: conversational turns without reasoning → flash
  // HEAVY: very long context (>32K tokens) → flash (attention dilution anyway)
  // CODE stays on pro for reasoning quality.
  // Saves ~3× on cache-miss ($0.14/M flash vs $0.435/M pro) for bulk turns.
  const DEFAULT_FLASH = { provider: 'ds', model: 'deepseek-v4-flash' };
  const promptRouter = {
    enabled: true,
    routes: {
      opus: [
        { tier: 'TRIVIAL', provider: 'oc', model: 'big-pickle' },
        { tier: 'TOOL', ...DEFAULT_FLASH },
        { tier: 'CHAT', ...DEFAULT_FLASH },
        { tier: 'HEAVY', ...DEFAULT_FLASH },
      ],
      sonnet: [
        { tier: 'TRIVIAL', provider: 'oc', model: 'big-pickle' },
        { tier: 'TOOL', ...DEFAULT_FLASH },
        { tier: 'CHAT', ...DEFAULT_FLASH },
        { tier: 'HEAVY', ...DEFAULT_FLASH },
      ],
      haiku: [
        { tier: 'TRIVIAL', provider: 'oc', model: 'big-pickle' },
        { tier: 'TOOL', ...DEFAULT_FLASH },
        { tier: 'CHAT', ...DEFAULT_FLASH },
        { tier: 'HEAVY', ...DEFAULT_FLASH },
      ],
      subagent: [
        { tier: 'TRIVIAL', provider: 'oc', model: 'big-pickle' },
        { tier: 'TOOL', ...DEFAULT_FLASH },
        { tier: 'CHAT', ...DEFAULT_FLASH },
        { tier: 'HEAVY', ...DEFAULT_FLASH },
      ],
      fable: [
        { tier: 'TRIVIAL', provider: 'oc', model: 'big-pickle' },
        { tier: 'TOOL', ...DEFAULT_FLASH },
        { tier: 'CHAT', ...DEFAULT_FLASH },
        { tier: 'HEAVY', ...DEFAULT_FLASH },
      ],
    },
  };

  return {
    slots: slotsMap,
    routes,
    providers: providerEntries,
    defaultProvider: resolved.defaultProvider,
    contextLimits: ctxLimits,
    promptRouter,
  };
}

// --- Slot overrides ---
export function readOverridesFile() {
  if (!existsSync(SLOT_OVERRIDES_FILE)) return {};
  try {
    return JSON.parse(readFileSync(SLOT_OVERRIDES_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function writeOverridesFile(data) {
  mkdirSync(DEFIANT_DIR, { recursive: true, mode: 0o700 });
  writeAtomic(SLOT_OVERRIDES_FILE, JSON.stringify(data));
}

export function initOverrides(resolved, configKey) {
  const defaults = {};
  for (const slot of SLOTS) {
    const s = resolved.slots[slot];
    defaults[slot] = `${s.provider}:${s.model}`;
  }
  const existing = readOverridesFile();
  // Preserve only genuine user overrides — slots whose value differs from
  // the OLD config's _defaults. Direct keys that match the old _defaults
  // were written by a previous initOverrides call and must be replaced by
  // the new config's defaults. User overrides survive config switches.
  //
  // IMPORTANT: when _defaults is missing from the file (corrupted, from an
  // older version, or manually edited), oldDefaults is {} and EVERY direct
  // key would compare !== undefined → treated as a "user override" →
  // preserved. This silently defeats config switches. Fix: when _defaults
  // is absent, treat ALL existing direct keys as stale — wipe them.
  const hasOldDefaults =
    existing._defaults &&
    typeof existing._defaults === 'object' &&
    Object.keys(existing._defaults).length > 0;
  const oldDefaults = hasOldDefaults ? existing._defaults : {};
  const userOverrides = {};
  for (const slot of SLOTS) {
    if (existing[slot] && hasOldDefaults && stripSlotPrefix(existing[slot]) !== oldDefaults[slot]) {
      userOverrides[slot] = existing[slot];
    }
  }
  // Track which config name wrote this file so we can detect stale overrides.
  const configName = configKey || resolved.name || 'ad-hoc';
  // Direct slot keys are visible to the proxy's routing.ts (slotOverrides[slot]).
  // _defaults is the canonical config snapshot for getSlotModel and --set-slot --clear.
  // _configName identifies which config produced these defaults (used for debugging).
  const merged = { ...defaults, ...userOverrides, _defaults: defaults, _configName: configName };
  writeOverridesFile(merged);
  return merged;
}

export function getSlotModel(slot, fallback) {
  const overrides = readOverridesFile();
  return overrides[slot] || (overrides._defaults && overrides._defaults[slot]) || fallback;
}

export function setSlotOverride(slotName, slotModel) {
  if (!SLOTS.includes(slotName))
    throw new Error(`Invalid slot '${slotName}'. Use: ${SLOTS.join(', ')}`);
  const overrides = readOverridesFile();
  if (!slotModel) {
    // Clear override
    delete overrides[slotName];
    const defaultModel = (overrides._defaults && overrides._defaults[slotName]) || 'unknown';
    writeOverridesFile(overrides);
    return { cleared: true, slot: slotName, revertsTo: defaultModel, overrides };
  }
  // Normalize: strip slot prefix if present (e.g. "haiku:ds:deepseek-v4-flash" → "ds:deepseek-v4-flash")
  const normalized = stripSlotPrefix(slotModel);
  // Validate format
  const { provKey } = parseSpec(normalized);
  const reg = registry();
  if (!reg.providers[provKey])
    throw new Error(
      `Unknown provider '${provKey}'. Known: ${Object.keys(reg.providers).join(', ')}`,
    );
  if (!getKey(provKey)) throw new Error(`No API key set for provider '${provKey}'.`);
  overrides[slotName] = normalized;
  writeOverridesFile(overrides);
  return { set: true, slot: slotName, value: normalized, overrides };
}

// --- Thinking overrides ---
export function writeThinkingOverrides(noThinking, budget) {
  if (!noThinking && (!budget || budget <= 0)) {
    try {
      rmSync(THINKING_OVERRIDES_FILE, { force: true });
    } catch {}
    return { cleared: true };
  }
  const overrides = {};
  const messages = [];
  for (const m of ['deepseek-v4-pro', 'deepseek-v4-flash']) {
    if (noThinking) {
      overrides[m] = null;
      messages.push(`Thinking: DISABLED for ${m}`);
    } else if (budget > 0) {
      overrides[m] = { budget_tokens: budget };
      messages.push(`Thinking: ${budget} token budget for ${m}`);
    }
  }
  mkdirSync(DEFIANT_DIR, { recursive: true, mode: 0o700 });
  writeAtomic(THINKING_OVERRIDES_FILE, JSON.stringify(overrides));
  return { written: true, overrides, messages };
}

// --- Subagent model ---
function setSubagentModel(model) {
  if (!model) {
    try {
      rmSync(SUBMODEL_FILE, { force: true });
    } catch {}
    return { cleared: true };
  }
  const { provKey, modelId } = parseSpec(model);
  const reg = registry();
  if (!reg.providers[provKey])
    throw new Error(
      `Unknown provider '${provKey}'. Known: ${Object.keys(reg.providers).join(', ')}`,
    );
  if (!getKey(provKey)) throw new Error(`No API key set for provider '${provKey}'.`);
  mkdirSync(DEFIANT_DIR, { recursive: true, mode: 0o700 });
  writeAtomic(SUBMODEL_FILE, JSON.stringify({ providerKey: provKey, modelId }));
  return { set: true, providerKey: provKey, modelId };
}

// Proxy state removed — each session runs its own isolated proxy.
// Per-session proxy ports are discovered via ANTHROPIC_BASE_URL env var.

// --- Context window logic ---
export function append1m(modelSpec) {
  const parts = modelSpec.split(':');
  const modelId = parts[parts.length - 1]; // last segment after last colon
  const reg = registry();
  const ctxLimit = reg.contextLimits[modelId];
  if (ctxLimit && ctxLimit >= 1000000) return modelSpec + '[1m]';
  return modelSpec;
}

export function computeContextInfo(opusModelId) {
  const reg = registry();
  const baseModel = opusModelId.replace(/\[1m\]/g, '');
  const ctxLimit = reg.contextLimits[baseModel] || null;
  const compactionWin = (reg.compactionWindow && reg.compactionWindow[baseModel]) || null;

  let autoCompactWindow, disableCompact, maxContextTokens;
  if (compactionWin) {
    // Per-model compaction window from providers.json
    if (compactionWin >= 1000000) {
      autoCompactWindow = '1000000';
    } else {
      autoCompactWindow = String(compactionWin);
    }
    disableCompact = false;
    maxContextTokens = null;
  } else if (ctxLimit) {
    // Fall back to context limits
    if (ctxLimit >= 1000000) {
      autoCompactWindow = '1000000';
    } else if (ctxLimit > 131072) {
      autoCompactWindow = null;
      disableCompact = true;
      maxContextTokens = String(ctxLimit);
    } else {
      autoCompactWindow = String(ctxLimit);
    }
  }

  return {
    model: baseModel,
    contextLimit: ctxLimit,
    compactionWindow: compactionWin,
    has1m: ctxLimit ? ctxLimit >= 1000000 : false,
    autoCompactWindow: autoCompactWindow || null,
    disableCompact: disableCompact || false,
    maxContextTokens: maxContextTokens || null,
  };
}

// --- Env vars ---
export function computeEnvVars(
  port,
  opusModel,
  sonnetModel,
  haikuModel,
  subagentModel,
  fableModel,
  opusCtxModel,
) {
  const opus1m = append1m('opus:' + opusModel);
  const sonnet1m = append1m('sonnet:' + sonnetModel);
  const haiku1m = append1m('haiku:' + haikuModel);
  const sub1m = append1m('subagent:' + subagentModel);
  const fable1m = append1m('fable:' + fableModel);

  // Compute per-slot compaction/context info. Each slot's model may have
  // a different context limit and compaction window. We use the MOST
  // CONSERVATIVE (smallest) compaction window across all slots so that
  // a slot with limited context (e.g., subagent with 131K model) gets
  // compacted before overflowing, even when another slot (opus with 1M)
  // would tolerate much more context.
  const slotModels = [
    { slot: 'opus', model: opusCtxModel || opusModel },
    { slot: 'sonnet', model: sonnetModel },
    { slot: 'haiku', model: haikuModel },
    { slot: 'subagent', model: subagentModel },
    { slot: 'fable', model: fableModel },
  ];
  const ctxInfo = slotModels.map((sm) => {
    const info = computeContextInfo(sm.model);
    return { slot: sm.slot, ...info };
  });

  // Pick the most conservative across all slots
  const compactWindows = ctxInfo
    .map((c) => (c.autoCompactWindow ? parseInt(c.autoCompactWindow, 10) : null))
    .filter(Boolean);
  const hasDisableCompact = ctxInfo.some((c) => c.disableCompact);
  const maxCtxTokens = ctxInfo
    .map((c) => (c.maxContextTokens ? parseInt(c.maxContextTokens, 10) : null))
    .filter(Boolean);
  const minCompactWindow = compactWindows.length > 0 ? String(Math.min(...compactWindows)) : null;
  const minMaxCtx = maxCtxTokens.length > 0 ? String(Math.min(...maxCtxTokens)) : null;

  const env = {
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    ANTHROPIC_AUTH_TOKEN: 'proxy',
    ANTHROPIC_MODEL: opus1m,
    ANTHROPIC_DEFAULT_OPUS_MODEL: opus1m,
    ANTHROPIC_DEFAULT_SONNET_MODEL: sonnet1m,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: haiku1m,
    ANTHROPIC_DEFAULT_FABLE_MODEL: fable1m,
    CLAUDE_CODE_SUBAGENT_MODEL: sub1m,
    CLAUDE_CONTEXT_COMPRESSION: 'true',
  };

  if (minCompactWindow) {
    env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = minCompactWindow;
  }
  if (hasDisableCompact) {
    env.DISABLE_COMPACT = '1';
    if (minMaxCtx) env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = minMaxCtx;
  }
  // Remove ANTHROPIC_API_KEY (proxy handles auth)
  env._unset = ['ANTHROPIC_API_KEY'];

  return env;
}

// --- Atomic file write ---
export function writeAtomic(path, content) {
  const tmpFile = path + '.tmp';
  const lockFile = path + '.lock';
  const maxRetries = 10;
  mkdirSync(dirname(path), { recursive: true });

  // Advisory lock
  for (let retry = 0; retry < maxRetries; retry++) {
    try {
      if (existsSync(lockFile)) {
        const lockContent = readFileSync(lockFile, 'utf-8');
        const m = lockContent.match(/pid=(\d+)/);
        const lockPid = m ? parseInt(m[1]) : 0;
        let stale = true;
        if (lockPid > 0) {
          try {
            process.kill(lockPid, 0);
            stale = false;
          } catch {}
        }
        if (stale) {
          try {
            rmSync(lockFile, { force: true });
          } catch {}
        } else {
          // Lock is held by a live process — wait and retry
          const waitMs = 50;
          const start = Date.now();
          while (Date.now() - start < waitMs) {
            /* spin */
          }
          continue;
        }
      }
      writeFileSync(lockFile, `pid=${process.pid}\nts=${new Date().toISOString()}`);
      break;
    } catch {
      /* retry */
    }
  }

  writeFileSync(tmpFile, content, 'utf-8');
  // Atomic rename
  try {
    rmSync(path, { force: true });
  } catch {}
  writeFileSync(path, content, 'utf-8'); // fallback if rename fails on different devices
  try {
    rmSync(tmpFile, { force: true });
  } catch {}
  try {
    rmSync(lockFile, { force: true });
  } catch {}

  // Restrict permissions on Unix
  if (platform() !== 'win32') {
    try {
      chmodSync(path, 0o600);
    } catch {}
  }
}

// --- Display data actions ---
function costData() {
  const reg = registry();
  const pricing = {};
  for (const [model, p] of Object.entries(reg.pricing)) {
    if (model.startsWith('_')) continue;
    pricing[model] = {
      input: p.input,
      output: p.output,
      input_cache_hit: p.input_cache_hit || null,
      input_cache_miss: p.input_cache_miss || null,
    };
  }
  return { pricing };
}

function modelList() {
  const reg = registry();
  const byProvider = {};
  for (const cfg of Object.values(reg.configs)) {
    for (const slot of SLOTS) {
      const val = cfg[slot === 'subagent' ? 'sub' : slot] || cfg[slot];
      const { provKey, modelId } = parseSpec(val);
      if (!byProvider[provKey]) byProvider[provKey] = {};
      byProvider[provKey][modelId] = true;
    }
  }
  const result = {};
  for (const pk of Object.keys(reg.providers).sort()) {
    const prov = reg.providers[pk];
    const key = getKey(pk);
    result[pk] = {
      name: prov.displayName,
      keyStatus: key ? 'set' : 'MISSING',
      models: Object.keys(byProvider[pk] || {}).sort(),
    };
  }
  return result;
}

function configList() {
  const reg = registry();
  const result = {};
  for (const [key, cfg] of Object.entries(reg.configs)) {
    result[key] = {
      name: cfg.name,
      opus: cfg.opus,
      sonnet: cfg.sonnet,
      haiku: cfg.haiku,
      subagent: cfg.sub,
      fable: cfg.fable || cfg.opus,
    };
  }
  return result;
}

function keyStatus() {
  const reg = registry();
  const result = {};
  for (const [pk, prov] of Object.entries(reg.providers)) {
    const key = getKey(pk);
    result[pk] = {
      keyName: prov.keyEnv,
      status: key ? 'set' : 'MISSING',
      masked: maskKey(key),
      setupUrl: prov.setupUrl || null,
      displayName: prov.displayName,
    };
  }
  return result;
}

function versionData() {
  const pkgPath = join(SCRIPT_DIR, '..', 'package.json');
  let version = 'v1.0.0';
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      version = 'v' + pkg.version;
    } catch {}
  }
  return {
    version,
    proxyPath: join(SCRIPT_DIR, 'start-proxy.ts'),
    scriptPath: join(SCRIPT_DIR, '..', 'launcher.mjs'),
  };
}

function doctorJson(_configName) {
  const reg = registry();

  // Node.js
  const node = { found: !!process.version, version: process.version, path: process.execPath };

  // Proxy script
  const proxyScriptPath = join(SCRIPT_DIR, 'start-proxy.ts');
  const proxyScript = { found: existsSync(proxyScriptPath), path: proxyScriptPath };

  // jq
  let jq = { found: false };
  try {
    const r = spawnSync('jq', ['--version'], { encoding: 'utf-8', timeout: 3000 });
    if (r.status === 0) jq = { found: true, version: r.stdout.trim() };
  } catch {}

  // Keys
  const keys = {};
  let configured = 0;
  const pkOrder = Object.keys(reg.providers);
  for (const pk of pkOrder) {
    const prov = reg.providers[pk];
    const key = getKey(pk);
    keys[pk] = {
      keyName: prov.keyEnv,
      hasKey: !!key,
      masked: maskKey(key),
      displayName: prov.displayName,
    };
    if (key) configured++;
  }

  // Stale tmps
  let staleTmps = 0;
  try {
    staleTmps = readdirSync(DEFIANT_DIR).filter((f) => f.endsWith('.tmp')).length;
  } catch {
    staleTmps = 0;
  }

  // Slots
  let slots = null;
  if (existsSync(SLOT_OVERRIDES_FILE)) {
    try {
      const overrides = JSON.parse(readFileSync(SLOT_OVERRIDES_FILE, 'utf-8'));
      slots = {};
      for (const slot of SLOTS) {
        const val = overrides[slot] || (overrides._defaults && overrides._defaults[slot]);
        if (val) {
          const { provKey, modelId } = parseSpec(val);
          const prov = reg.providers[provKey];
          slots[slot] = {
            value: val,
            provider: provKey,
            model: modelId,
            providerName: prov ? prov.displayName : 'unknown',
            hasKey: !!getKey(provKey),
          };
        }
      }
    } catch {
      slots = null;
    }
  }

  return {
    node,
    proxyScript,
    jq,
    keys: { configured, total: pkOrder.length, details: keys },
    slots,
    staleTmps,
    stateDir: DEFIANT_DIR,
  };
}

// --- CLI dispatch ---
function fail(msg) {
  console.error(msg);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = {};
  for (const arg of argv) {
    const m = arg.match(/^--([^=]+)=(.*)$/);
    if (m) {
      const key = m[1];
      const val = m[2];
      if (!opts[key]) opts[key] = val;
      else if (Array.isArray(opts[key])) opts[key].push(val);
      else opts[key] = [opts[key], val];
    } else if (arg.startsWith('--')) {
      // Boolean flag: --no-thinking → opts['no-thinking'] = true
      const key = arg.slice(2);
      opts[key] = true;
    } else {
      if (!opts._) opts._ = [];
      opts._.push(arg);
    }
  }
  return opts;
}

async function main() {
  const args = process.argv.slice(2);
  const action = args[0];
  if (!action)
    fail(
      'Usage: node launcher.mjs <action> [--key=value...]\nActions: ' +
        'resolve-config build-routes init-overrides read-override set-slot thinking-overrides ' +
        'subagent-model env-vars context-info cost-data model-list config-list ' +
        'key-status version write-atomic doctor-json',
    );

  const opts = parseArgs(args.slice(1));

  try {
    let result;
    switch (action) {
      case 'resolve-config': {
        if (opts.name) result = resolveConfig(opts.name);
        else if (opts.specs) result = buildAdhocConfig(opts.specs.split(','));
        else fail('resolve-config requires --name=CONFIG or --specs=PROV:MODEL,...');
        break;
      }
      case 'build-routes': {
        let resolved;
        if (opts.name) resolved = resolveConfig(opts.name);
        else if (opts.specs) resolved = buildAdhocConfig(opts.specs.split(','));
        else if (opts['config-file'])
          resolved = JSON.parse(readFileSync(opts['config-file'], 'utf-8'));
        else fail('build-routes requires --name, --specs, or --config-file');
        result = buildRoutesJson(resolved);
        break;
      }
      case 'init-overrides': {
        let resolved;
        let configKey = null;
        if (opts.name) {
          resolved = resolveConfig(opts.name);
          configKey = opts.name;
        } else if (opts.specs) {
          resolved = buildAdhocConfig(opts.specs.split(','));
          configKey = 'ad-hoc';
        } else {
          // Manual slot/value pairs
          const manual = { slots: {}, providers: {}, modelProviders: {}, defaultProvider: '' };
          const slotVals = Array.isArray(opts.slot) ? opts.slot : [opts.slot];
          const valueVals = Array.isArray(opts.value) ? opts.value : [opts.value];
          for (let i = 0; i < slotVals.length; i++) {
            const slot = slotVals[i];
            const val = valueVals[i];
            const { provKey, modelId } = parseSpec(val);
            manual.slots[slot] = { provider: provKey, model: modelId };
          }
          resolved = manual;
          configKey = 'manual';
        }
        result = initOverrides(resolved, configKey);
        break;
      }
      case 'read-override': {
        if (!opts.slot) fail('read-override requires --slot=SLOT');
        const value = getSlotModel(opts.slot, opts.fallback || '');
        result = {
          slot: opts.slot,
          value: append1m(opts.slot + ':' + value.split(':').slice(-1)[0]),
        };
        break;
      }
      case 'set-slot': {
        if (!opts.slot) fail('set-slot requires --slot=SLOT [--value=PROV:MODEL]');
        result = setSlotOverride(opts.slot, opts.value || '');
        break;
      }
      case 'thinking-overrides': {
        if (opts.clear) result = writeThinkingOverrides(false, 0);
        else result = writeThinkingOverrides(!!opts['no-thinking'], parseInt(opts.budget) || 0);
        break;
      }
      case 'subagent-model': {
        result = setSubagentModel(opts.model || '');
        break;
      }
      case 'env-vars': {
        if (!opts.port) fail('env-vars requires --port=N');
        result = computeEnvVars(
          opts.port,
          opts.opus || '',
          opts.sonnet || '',
          opts.haiku || '',
          opts.subagent || '',
          opts.fable || '',
          opts['ctx-model'] || opts.opus || '',
        );
        break;
      }
      case 'context-info': {
        if (!opts.model) fail('context-info requires --model=MODEL');
        result = computeContextInfo(opts.model);
        break;
      }
      case 'cost-data':
        result = costData();
        break;
      case 'model-list':
        result = modelList();
        break;
      case 'config-list':
        result = configList();
        break;
      case 'key-status':
        result = keyStatus();
        break;
      case 'version':
        result = versionData();
        break;
      case 'write-atomic': {
        if (!opts.file || opts.data === undefined)
          fail('write-atomic requires --file=PATH --data=JSON');
        writeAtomic(opts.file, opts.data);
        result = { written: true, file: opts.file };
        break;
      }
      case 'doctor-json': {
        result = await doctorJson(opts.name || 'ds');
        break;
      }
      default:
        fail(
          `Unknown action '${action}'. Actions: resolve-config build-routes init-overrides read-override set-slot thinking-overrides subagent-model env-vars context-info cost-data model-list config-list key-status version write-atomic doctor-json`,
        );
    }
    console.log(JSON.stringify(result));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

// Only run main() when executed directly (not imported as a module).
// When invoked as `node launcher.mjs <action>`, process.argv[1] resolves
// to the absolute path of this file. When imported by Jest, the test file
// is process.argv[1] instead, so main() is skipped.
const _modulePath = resolve(fileURLToPath(import.meta.url));
const _execPath = process.argv[1] ? resolve(process.argv[1]) : '';
const _isDirectExec = _execPath === _modulePath || (_execPath && _modulePath.endsWith(_execPath));
if (_isDirectExec) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
