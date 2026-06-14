'use strict';

// Config management: argument parsing, route file loading, and hot-reload.
// Reads routes.json, slot-overrides.json, and providers.json.
// Polls all three for changes once per second.

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { createLogger } from './log';
import { validateUrl } from './ssrf';
import { decrypt } from './crypto';
import {
  reconcileCircuitBreakers,
  reconcileProviderStats,
  registerProviderInfo,
  reloadPricing,
} from './stats';
import type { RoutingConfig } from './routing';

const log = createLogger('config');

// --- Interfaces ---

interface ProviderDefinition {
  displayName?: string;
  endpoint: string;
  keyEnv: string;
  authHeader: string;
  wireFormat: string;
  setupUrl?: string;
  monthlyBudget?: number;
  fallback?: string[];
  extraHeaders?: Record<string, string>;
  streamUsageReporting?: string | null;
  noAutoFallback?: boolean;
}

interface ProvidersData {
  providers?: Record<string, ProviderDefinition>;
  aliases?: Record<string, string>;
  contextLimits?: Record<string, number>;
  configs?: Record<string, Record<string, string>>;
  pricing?: Record<string, { input: number; output: number }>;
  thinking?: Record<string, ThinkingConfig>;
}

interface ThinkingConfig {
  type: string;
  budget_tokens: number;
}

interface ParsedArgs {
  routesFile: string | null;
  overridesFile: string | null;
  providersFile: string | null;
  thinkingOverridesFile: string | null;
  singleUrl: string | null;
  singleKey: string | null;
  port: number | null;
}
interface ConfigState {
  routing: RoutingConfig | null;
  routesMtime: number;
  slotOverrides: Record<string, string>;
  overridesMtime: number;
  providersFile: string | null;
  providersMtime: number;
  thinkingOverridesFile: string | null;
  thinkingOverridesMtime: number;
  thinkingConfig: Record<string, ThinkingConfig>;
}
// --- Argument parsing ---

export function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  let routesFile: string | null = null;
  let overridesFile: string | null = null;
  let providersFile: string | null = null;
  let thinkingOverridesFile: string | null = null;
  let singleUrl: string | null = null;
  let singleKey: string | null = null;
  let port: number | null = null;

  // Parse all named flags position-independently
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '--routes') routesFile = args[i + 1];
    if (args[i] === '--overrides') overridesFile = args[i + 1];
    if (args[i] === '--providers') providersFile = args[i + 1];
    if (args[i] === '--thinking-overrides') thinkingOverridesFile = args[i + 1];
    if (args[i] === '--port') {
      const p = parseInt(args[i + 1], 10);
      if (!isNaN(p) && p > 0 && p <= 65535) {
        port = p;
      } else {
        console.error('Invalid --port value: ' + args[i + 1] + ' (must be 1–65535)');
        process.exit(1);
      }
    }
  }

  if (routesFile) {
    // Already parsed, nothing extra needed
  } else if (args.length >= 2 && !args[0].startsWith('--') && !args[1].startsWith('--')) {
    singleUrl = args[0];
    singleKey = args[1];
  } else {
    console.error('Usage: npx tsx start-proxy.ts <provider_url> <api_key>');
    console.error(
      '       npx tsx start-proxy.ts --routes <routes.json> [--overrides <overrides.json>] [--providers <providers.json>] [--thinking-overrides <thinking-overrides.json>] [--port <port>]',
    );
    process.exit(1);
  }
  return {
    routesFile,
    overridesFile,
    providersFile,
    thinkingOverridesFile,
    singleUrl,
    singleKey,
    port,
  };
}
// --- JSON file helpers ---

export function readJson(path: string): Record<string, unknown> {
  const raw = fs.readFileSync(path, 'utf-8');
  return JSON.parse(raw);
}
export function tryReadJson(path: string): Record<string, unknown> | null {
  try {
    return readJson(path);
  } catch (_) {
    return null;
  }
}
// --- SSRF validation helper ---

function validateProviderUrls(routing: RoutingConfig): void {
  for (const [key, provider] of Object.entries(routing.providers || {})) {
    if (provider.url) {
      validateUrl(provider.url)
        .then((result: { valid: boolean; reason?: string }) => {
          if (!result.valid) {
            log.warn(
              null,
              'Provider "' + key + '" URL fails SSRF check: ' + (result.reason || 'unknown'),
            );
          }
        })
        .catch((err: Error) => {
          log.warn(null, 'Provider "' + key + '" SSRF validation error: ' + err.message);
        });
    }
  }
}

// --- Providers.json metadata patching ---
// Reads provider definitions from providers.json and patches url, format,
// auth, extraHeaders, and streamUsageReporting into the routing config.
// This allows provider metadata to be edited without regenerating routes.json.

function applyProviderMetadata(routing: RoutingConfig, providersData: ProvidersData): boolean {
  if (!providersData.providers) return false;
  if (!routing.providers) {
    routing.providers = {};
  }
  let changed = false;

  for (const [key, def] of Object.entries(providersData.providers)) {
    const existing = routing.providers[key];
    const newUrl = def.endpoint || '';
    const newFormat = def.wireFormat || 'anthropic';
    const newAuth = def.authHeader || 'bearer';

    if (!existing) {
      routing.providers[key] = {
        url: newUrl,
        keyEnv: def.keyEnv,
        auth: newAuth,
        format: newFormat,
        fallback: def.fallback || [],
        extraHeaders: def.extraHeaders,
        streamUsageReporting: def.streamUsageReporting || undefined,
        noAutoFallback: def.noAutoFallback === true,
      };
      changed = true;
      continue;
    }

    // Patch only changed fields
    if (existing.url !== newUrl) {
      existing.url = newUrl;
      changed = true;
    }
    if (existing.format !== newFormat) {
      existing.format = newFormat;
      changed = true;
    }
    if (existing.auth !== newAuth) {
      existing.auth = newAuth;
      changed = true;
    }
    if (!existing.keyEnv && def.keyEnv) {
      existing.keyEnv = def.keyEnv;
      changed = true;
    }
    if (def.fallback && JSON.stringify(existing.fallback) !== JSON.stringify(def.fallback)) {
      existing.fallback = def.fallback;
      changed = true;
    }
    if (def.extraHeaders) {
      // Always apply headers from providers.json, regardless of existing state
      const newHeaders = JSON.stringify(def.extraHeaders);
      if (!existing.extraHeaders || JSON.stringify(existing.extraHeaders) !== newHeaders) {
        existing.extraHeaders = { ...def.extraHeaders };
        changed = true;
      }
    }
    if (def.streamUsageReporting !== undefined) {
      const expected = def.streamUsageReporting || undefined;
      if (existing.streamUsageReporting !== expected) {
        existing.streamUsageReporting = expected;
        changed = true;
      }
    }
    if (existing.noAutoFallback !== (def.noAutoFallback === true)) {
      existing.noAutoFallback = def.noAutoFallback === true;
      changed = true;
    }
  }

  // Remove providers that exist in routing but not in providers.json.
  // SAFETY: only prune when the new providers list is non-empty — an empty
  // providers.json (e.g. during a config-file rotation or atomic replace)
  // would otherwise wipe ALL provider state and cause a service outage.
  const newKeys = Object.keys(providersData.providers);
  if (newKeys.length > 0) {
    for (const key of Object.keys(routing.providers)) {
      if (!providersData.providers[key]) {
        delete routing.providers[key];
        changed = true;
      }
    }
  }

  return changed;
}

// --- Thinking overrides ---
// Loads thinking-overrides.json and applies it on top of the base
// thinking config from providers.json. An override value of null
// disables thinking for that model. Non-null values merge (budget_tokens
// overrides, type preserved from base).

interface ThinkingOverride {
  type?: string;
  budget_tokens?: number;
}

export function applyThinkingOverrides(
  baseConfig: Record<string, ThinkingConfig>,
  overridesFile: string | null,
): Record<string, ThinkingConfig> {
  if (!overridesFile) return baseConfig;
  let overrides: Record<string, ThinkingOverride | null> = {};
  try {
    const raw = fs.readFileSync(overridesFile, 'utf-8');
    overrides = JSON.parse(raw);
  } catch (_) {
    log.warn(
      null,
      `Failed to parse thinking overrides file: ${overridesFile} — falling back to base thinking config`,
    );
    return baseConfig;
  }

  const result = { ...baseConfig };
  for (const [modelId, override] of Object.entries(overrides)) {
    if (override === null) {
      // null override = disable thinking for this model
      delete result[modelId];
    } else if (typeof override === 'object') {
      result[modelId] = {
        type: override.type || baseConfig[modelId]?.type || 'enabled',
        budget_tokens: override.budget_tokens ?? baseConfig[modelId]?.budget_tokens ?? 16000,
      };
    }
  }
  return result;
}

export function getEffectiveThinkingConfig(
  baseConfig: Record<string, ThinkingConfig>,
  overridesFile: string | null,
): Record<string, ThinkingConfig> {
  return applyThinkingOverrides(baseConfig, overridesFile);
}

// --- Load all provider info into the stats module ---
// Called after a providers/routes change so auto-probe and circuit breaker
// recovery use the current metadata.

async function syncProviderInfo(routing: RoutingConfig): Promise<void> {
  if (!routing || !routing.providers) return;
  for (const [key, provider] of Object.entries(routing.providers)) {
    const rawKey = resolveProviderKey(provider.keyEnv || '') || provider.key;
    const resolvedKey = await resolveKey(rawKey);
    const probeModel =
      (provider.format || 'anthropic') === 'openai' ? 'gpt-4o-mini' : 'claude-sonnet-4-6';
    registerProviderInfo(key, {
      url: provider.url,
      key: resolvedKey,
      isBearer: provider.auth === 'bearer',
      format: provider.format || 'anthropic',
      model: probeModel,
    });
  }
}

// --- Load initial state ---

export function loadConfig(parsed: ParsedArgs): ConfigState {
  let routing: RoutingConfig | null = null;
  let routesMtime = 0;
  let overridesMtime = 0;
  let providersMtime = 0;
  let slotOverrides: Record<string, string> = {};
  let thinkingConfig: Record<string, ThinkingConfig> = {};
  const thinkingOverridesMtime = 0;

  if (parsed.routesFile) {
    try {
      routing = readJson(parsed.routesFile) as RoutingConfig;
      routesMtime = fs.statSync(parsed.routesFile).mtimeMs;
    } catch (e) {
      log.error(null, 'Failed to load routes file: ' + (e as Error).message);
      process.exit(1);
    }
  }
  if (parsed.overridesFile) {
    try {
      slotOverrides = readJson(parsed.overridesFile) as Record<string, string>;
      overridesMtime = fs.statSync(parsed.overridesFile).mtimeMs;
    } catch (_e) {
      // Overrides file optional -- may not exist yet
    }
  }
  // Patch provider metadata from providers.json (direct read, hot-reloadable)
  if (parsed.providersFile && routing) {
    try {
      const providersData = readJson(parsed.providersFile) as ProvidersData;
      applyProviderMetadata(routing, providersData);
      if (providersData.thinking) thinkingConfig = providersData.thinking;
      providersMtime = fs.statSync(parsed.providersFile).mtimeMs;
    } catch (e) {
      log.warn(null, 'Failed to load providers metadata: ' + (e as Error).message);
    }
  }
  // Fire-and-forget SSRF validation for provider endpoint URLs
  if (routing) {
    validateProviderUrls(routing);
  }
  return {
    routing,
    routesMtime,
    slotOverrides,
    overridesMtime,
    providersFile: parsed.providersFile,
    providersMtime,
    thinkingOverridesFile: parsed.thinkingOverridesFile,
    thinkingOverridesMtime,
    thinkingConfig,
  };
}
// --- Hot-reload ---
// Polls route, override, and provider files once per second. If mtimes change, reloads.
// Returns true if anything changed.

let lastStatCheck = 0;
export async function checkReload(state: ConfigState, parsed: ParsedArgs): Promise<boolean> {
  const now = Date.now();
  if (now - lastStatCheck < 1000) return false;
  lastStatCheck = now;

  let changed = false;

  // Reload providers.json metadata (url, format, auth, etc.)
  if (state.providersFile) {
    try {
      const stat = fs.statSync(state.providersFile);
      if (stat.mtimeMs >= state.providersMtime) {
        const providersData = readJson(state.providersFile) as ProvidersData;
        if (state.routing) {
          const metaChanged = applyProviderMetadata(state.routing, providersData);
          if (metaChanged) {
            changed = true;
            validateProviderUrls(state.routing);
            reconcileCircuitBreakers(new Set(Object.keys(state.routing.providers || {})));
            reconcileProviderStats(new Set(Object.keys(state.routing.providers || {})));
            reloadPricing();
            resetAliasCache();
            await syncProviderInfo(state.routing);
            log.info(null, 'hot-reloaded providers.json');
          }
        }
        // Reload thinking config regardless of provider metadata changes
        if (providersData.thinking) {
          const newThinking = JSON.stringify(providersData.thinking);
          if (JSON.stringify(state.thinkingConfig) !== newThinking) {
            state.thinkingConfig = providersData.thinking;
            changed = true;
          }
        }
        state.providersMtime = stat.mtimeMs;
      }
    } catch (e) {
      log.warn(null, 'Failed to reload providers: ' + (e as Error).message);
    }
  }

  // Reload thinking overrides if the file changed
  if (state.thinkingOverridesFile) {
    try {
      const stat = fs.statSync(state.thinkingOverridesFile);
      if (stat.mtimeMs >= state.thinkingOverridesMtime) {
        state.thinkingOverridesMtime = stat.mtimeMs;
        changed = true;
      }
    } catch (_) {
      /* file may not exist yet or was deleted */
    }
  }

  if (parsed.routesFile) {
    try {
      const stat = fs.statSync(parsed.routesFile);
      if (stat.mtimeMs >= state.routesMtime) {
        state.routing = readJson(parsed.routesFile) as RoutingConfig;
        state.routesMtime = stat.mtimeMs;
        changed = true;
        validateProviderUrls(state.routing);

        // Re-patch provider metadata from providers.json (loaded routes
        // may have stale provider entries). Do this BEFORE reconciling
        // so the correct provider set is used.
        if (state.providersFile) {
          try {
            const providersData = readJson(state.providersFile) as ProvidersData;
            applyProviderMetadata(state.routing, providersData);
          } catch (_) {
            /* non-fatal */
          }
        }

        // Reconcile circuit breakers: remove entries for providers
        // that no longer exist in the reloaded config.
        const providerKeys = new Set(Object.keys(state.routing.providers || {}));
        reconcileCircuitBreakers(providerKeys);
        reconcileProviderStats(providerKeys);
        reloadPricing();
        resetAliasCache();
        // Register provider info for circuit breaker auto-probe recovery.
        // This propagates new/updated providers from hot-reload to the
        // stats module so the auto-probe scheduler can monitor them.
        await syncProviderInfo(state.routing);
      }
    } catch (e) {
      log.error(null, 'Failed to reload routes: ' + (e as Error).message);
    }
  }
  if (parsed.overridesFile) {
    try {
      const stat = fs.statSync(parsed.overridesFile);
      if (stat.mtimeMs >= state.overridesMtime) {
        state.slotOverrides = readJson(parsed.overridesFile) as Record<string, string>;
        state.overridesMtime = stat.mtimeMs;
        changed = true;
      }
    } catch (e) {
      log.error(null, 'Failed to reload ' + parsed.overridesFile + ': ' + (e as Error).message);
    }
  }
  return changed;
}
// --- Validate routing config ---
// Checks for common misconfigurations at startup.

export function validateConfig(state: ConfigState): string[] {
  const warnings: string[] = [];

  if (state.routing) {
    const providerKeys = new Set(Object.keys(state.routing.providers || {}));

    for (const [key, provider] of Object.entries(state.routing.providers || {})) {
      if (!provider.url) {
        warnings.push('Provider "' + key + '" has no URL configured');
      }
      if (provider.auth && provider.auth !== 'bearer' && provider.auth !== 'x-api-key') {
        warnings.push('Provider "' + key + '" has unrecognized auth type: ' + provider.auth);
      }
      if (provider.format && provider.format !== 'anthropic' && provider.format !== 'openai') {
        warnings.push('Provider "' + key + '" has unrecognized format: ' + provider.format);
      }
      if (Array.isArray(provider.fallback)) {
        for (const fb of provider.fallback) {
          if (fb !== key && !providerKeys.has(fb)) {
            warnings.push(
              'Provider "' + key + '" fallback "' + fb + '" not found in providers table',
            );
          }
        }
      }
    }
    if (state.routing.defaultProvider && !providerKeys.has(state.routing.defaultProvider)) {
      warnings.push(
        'defaultProvider "' + state.routing.defaultProvider + '" not found in providers table',
      );
    }
    if (state.routing.routes) {
      for (const [model, route] of Object.entries(state.routing.routes)) {
        let providerKey: string | null = null;
        if (typeof route === 'string') {
          providerKey = route;
        } else if (route && typeof route === 'object' && (route as { provider: string }).provider) {
          providerKey = (route as { provider: string }).provider;
        }
        if (providerKey && !providerKeys.has(providerKey)) {
          warnings.push('Route "' + model + '" references unknown provider: ' + providerKey);
        }
      }
    }
  }
  return warnings;
}
// --- Key resolution with encryption support ---
// If a key value starts with $aes256gcm:, decrypt it using DEEPCLAUDE_ENCRYPTION_KEY.
// Plaintext keys are returned as-is for backwards compatibility.

export async function resolveKey(rawKey: string | null | undefined): Promise<string | null> {
  if (!rawKey) return null;
  // Guard against the literal string "null" (e.g. from JSON config) — treat
  // it as a missing key rather than sending "Bearer null" to upstream.
  if (rawKey === 'null') return null;
  if (typeof rawKey !== 'string' || !rawKey.startsWith('$aes256gcm:')) {
    return rawKey;
  }
  const masterSecret =
    process.env.DEEPCLAUDE_ENCRYPTION_KEY || readWinReg('DEEPCLAUDE_ENCRYPTION_KEY');
  if (!masterSecret) {
    log.warn(null, 'Encrypted key found but DEEPCLAUDE_ENCRYPTION_KEY is not set');
    return null;
  }
  try {
    return await decrypt(rawKey, masterSecret);
  } catch (err) {
    log.warn(null, 'Failed to decrypt API key: ' + (err as Error).message);
    return null;
  }
}

// Fallback: read a Windows User-level environment variable from the registry.
// When the proxy starts as a detached process (e.g. CC auto-restart), it may
// not inherit all parent shell env vars. Registry lookup ensures API keys
// set via setx / [Environment]::SetEnvironmentVariable are always available.
function readWinReg(name: string): string | null {
  if (process.platform !== 'win32') return null;
  try {
    const out = execSync(`reg query "HKCU\\Environment" /v ${name}`, {
      encoding: 'utf8',
      timeout: 2000,
      windowsHide: true,
    });
    const m = out.match(/REG_\w+\s+(.+)/);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

// Resolve a provider key: try process.env first, then Windows registry.
export function resolveProviderKey(keyEnv: string): string {
  if (typeof keyEnv !== 'string' || !keyEnv) return '';
  const val = process.env[keyEnv] || readWinReg(keyEnv) || '';
  return val;
}

// --- Model alias resolution ---
// Loads short-name aliases from providers.json and resolves them to full model IDs.
// Aliases are case-insensitive; unknown inputs pass through unchanged.

let aliasCache: Record<string, string> | null = null;

export function loadAliases(): Record<string, string> {
  if (aliasCache) return aliasCache;
  try {
    const data = readJson(path.join(__dirname, 'providers.json'));
    aliasCache = (data.aliases as Record<string, string>) || {};
  } catch (_) {
    aliasCache = {};
  }
  return aliasCache;
}

/** Reset the alias cache (used in tests to reload from disk). */
export function resetAliasCache(): void {
  aliasCache = null;
}

export function resolveAlias(modelId: string): string {
  if (!modelId) return modelId;
  const aliases = loadAliases();
  const lower = modelId.toLowerCase();
  return (aliases[lower] as string) || modelId;
}
