'use strict';

// Request routing: resolveTarget determines which provider + model handles
// a given request. Supports slot prefixes, explicit provider overrides,
// route table lookups, and fallback chain construction with circuit breaker.

import { URL } from 'url';
import fs from 'fs';
import path from 'path';
import { isProviderHealthy } from './stats';
import { createLogger } from './log';

const log = createLogger('routing');
import { resolveKey, resolveAlias, resolveProviderKey } from './config';

// --- Types ---

export type Tier = 'TRIVIAL' | 'CHAT' | 'CODE' | 'TOOL' | 'HEAVY';

export interface TierRoute {
    tier: Tier;
    provider: string;
    model: string;
}

export interface PromptRouterConfig {
    enabled: boolean;
    routes: Record<string, TierRoute[]>;
}

export interface ProviderEntry {
    url: string;
    key?: string;
    keyEnv?: string;
    auth?: string;
    authHeader?: string;
    format?: string;
    fallback?: string[];
    extraHeaders?: Record<string, string>;
    streamUsageReporting?: string;
    noAutoFallback?: boolean;
}

export interface RoutingConfig {
    providers?: Record<string, ProviderEntry>;
    defaultProvider?: string;
    routes?: Record<string, string | { provider: string; rewrite?: string }>;
    promptRouter?: PromptRouterConfig;
    canary?: Record<string, { targetProvider: string; targetModel: string; warmupPercent?: number }>;
}

interface SlotOverrides {
    [slot: string]: string;
}

export interface ResolvedTarget {
    providerKey: string;
    url: string;
    key: string | null | undefined;
    isBearer: boolean;
    targetUrl: URL;
    rewriteModel: string | null;
    format: string;
}

interface ResolveResult {
    primary?: ResolvedTarget;
    fallbacks?: ResolvedTarget[];
    error?: string;
}

// Cache for subagent model with mtime+size invalidation to avoid sync file I/O on every request.
let subagentModelCache: { model: { providerKey: string; modelId: string }; mtime: number; size: number } | null = null;

// Read the dedicated subagent model from ~/.deepclaude/subagent-model.json.
// Uses stat mtime+size cache to avoid synchonous file I/O on every subagent request.
// Returns null when the file does not exist, is invalid, or an I/O error occurs.
// Used by resolveTarget to override the subagent slot when no slot override is set.
export function resolveSubagentModel(): { providerKey: string; modelId: string } | null {
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    if (!homeDir) return null;
    const filePath = path.join(homeDir, '.deepclaude', 'subagent-model.json');
    try {
        const stat = fs.statSync(filePath);
        if (subagentModelCache && subagentModelCache.mtime === stat.mtimeMs && subagentModelCache.size === stat.size) {
            return subagentModelCache.model;
        }
        const raw = fs.readFileSync(filePath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.providerKey === 'string' && typeof parsed.modelId === 'string') {
            subagentModelCache = { model: { providerKey: parsed.providerKey, modelId: parsed.modelId }, mtime: stat.mtimeMs, size: stat.size };
            return subagentModelCache.model;
        }
        return null;
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
            log.warn(null, 'subagent-model.json read error: ' + ((e as Error).message || String(e)));
        }
        return null;
    }
}

// Resolve the primary provider and fallback chain for a given model name.
//
// Routing priority:
//   1. Slot prefix ("sonnet:", "opus:", "haiku:", "subagent:") -> check overrides
//   2. Explicit provider prefix ("ds:", "oc:", "or:") -> direct provider lookup
//   3. Routes table lookup by model ID
//   4. Default provider fallback
//
// Subagent slot priority (overrides the above):
//   1. --set-slot sub X:Y (slot override) — highest priority
//   2. --subagent-model X:Y (dedicated subagent model)
//   3. Routes table sub entry (from config)
//   4. Same as haiku / last slot (fallback)
//
// Returns { primary, fallbacks } on success, { error } on failure.

export async function resolveTarget(
    model: string | null | undefined,
    routing: RoutingConfig | null | undefined,
    slotOverrides: SlotOverrides | null | undefined,
    singleUrl: string | null | undefined,
    singleKey: string | null | undefined
): Promise<ResolveResult> {
    // Strip [1m] context-window hint (Claude Code convention for 1M context models)
    if (model && model.includes('[1m]')) {
        model = model.replace(/\[1m\]/g, '');
    }

    // Single-provider (legacy) mode
    if (!routing) {
        const targetUrl = new URL(singleUrl!);
        const isBearer = !targetUrl.hostname.includes('deepseek.com');
        const primary: ResolvedTarget = {
            providerKey: 'direct',
            url: singleUrl!,
            key: singleKey,
            isBearer,
            targetUrl,
            rewriteModel: null,
            format: 'anthropic',
        };
        return { primary, fallbacks: [] };
    }

    // Slot prefix: "sonnet:oc:big-pickle" -> check overrides, fall back to model after prefix
    // Subagent slot priority:
    //   1. Slot override (highest)
    //   2. Dedicated subagent model (--subagent-model)
    //   3. Routes table fallback (from config)
    //   4. Default provider fallback
    //
    // NOTE: Slot prefixes (sonnet|opus|haiku|subagent|fable) take priority over
    // provider-key prefixes.  Do not name a provider with one of these reserved
    // words — the slot regex will capture it first and provider-prefix routing
    // for that key will silently break.  config-lint.ts enforces this.
    const slotMatch = model && model.match(/^(sonnet|opus|haiku|subagent|fable):(.+)$/);
    let resolvedModel = model;
    if (slotMatch) {
        const slot = slotMatch[1];
        const fallback = slotMatch[2];
        if (slotOverrides && slotOverrides[slot]) {
            resolvedModel = slotOverrides[slot];
        } else if (slot === 'subagent') {
            const subagentModel = resolveSubagentModel();
            if (subagentModel) {
                resolvedModel = subagentModel.providerKey + ':' + subagentModel.modelId;
            } else {
                resolvedModel = fallback;
            }
        } else {
            resolvedModel = fallback;
        }
    }

    let providerKey: string | null = null;
    let rewriteModel: string | null = null;

    // Check for providerKey:modelId prefix (explicit provider override from /model)
    const prefixMatch = resolvedModel && resolvedModel.match(/^([a-z][a-z0-9_-]*):(.+)$/);
    if (prefixMatch && routing.providers && routing.providers[prefixMatch[1]]) {
        providerKey = prefixMatch[1];
        rewriteModel = resolveAlias(prefixMatch[2]);
    } else {
        // Resolve model alias before routes table lookup
        const resolvedAlias = resolveAlias(resolvedModel || '');
        // Fall back to routes table lookup
        const route = (resolvedAlias && routing.routes && routing.routes[resolvedAlias]) || null;

        if (!route) {
            providerKey = routing.defaultProvider || null;
        } else if (typeof route === 'string') {
            providerKey = route;
        } else if (route && typeof route === 'object' && (route as { provider: string }).provider) {
            providerKey = (route as { provider: string }).provider;
            rewriteModel = (route as { rewrite?: string }).rewrite || null;
        } else {
            providerKey = routing.defaultProvider || null;
        }
    }

    const provider = (providerKey && routing.providers) ? routing.providers[providerKey] : null;
    if (!provider || !providerKey) {
        return { error: providerKey ? 'Unknown provider: ' + providerKey : 'No default provider configured' };
    }

    const targetUrl = new URL(provider.url);
    const rawKey = resolveProviderKey(provider.keyEnv || '') || provider.key;
    const resolvedKey = await resolveKey(rawKey);
    if (rawKey && rawKey.startsWith('$aes256gcm:') && resolvedKey === null) {
        return { error: 'Provider "' + providerKey + '" has encrypted key but DEEPCLAUDE_ENCRYPTION_KEY is not set or decryption failed' };
    }

    let primary: ResolvedTarget = {
        providerKey,
        url: provider.url,
        key: resolvedKey,
        isBearer: (provider.auth || provider.authHeader) === 'bearer',
        targetUrl: targetUrl,
        rewriteModel: rewriteModel,
        format: provider.format || 'anthropic',
    };

    // Resolve a single fallback provider entry.  Returns the ResolvedTarget
    // or null when the provider has no key, can't decrypt, or is the primary.
    async function resolveFallback(
        fbKey: string,
        fb: ProviderEntry,
    ): Promise<ResolvedTarget | null> {
        if (!routing) return null;
        if (fbKey === providerKey) return null;
        const fbRawKey = resolveProviderKey(fb.keyEnv || '') || fb.key;
        if (!fbRawKey) return null;
        const fbResolvedKey = await resolveKey(fbRawKey);
        if (fbRawKey.startsWith('$aes256gcm:') && fbResolvedKey === null) return null;
        const fbUrl = new URL(fb.url);

        // Resolve the correct model rewrite for the fallback provider.
        // Don't inherit the primary's rewriteModel -- different providers
        // use different model names. Prefer routes matching the same
        // capability tier (opus/sonnet/haiku) to avoid tier downgrades.
        //
        // NOTE: Resolution iterates Object.entries(routing.routes) and
        // breaks on the first match per provider. Since the iteration
        // order follows JS property insertion order (routes.json key
        // order), the order in which routes appear in routes.json
        // determines fallback model priority.
        let fbRewrite: string | null = null;
        const tier = (model || '').match(/(opus|sonnet|haiku|subagent)/);
        const tierPart = tier ? tier[1] : null;
        if (tierPart && routing.routes) {
            for (const [routeModel, routeEntry] of Object.entries(routing.routes)) {
                if (!routeModel.includes(tierPart)) continue;
                if (typeof routeEntry === 'string' && routeEntry === fbKey) {
                    fbRewrite = routeModel; break;
                } else if (routeEntry && typeof routeEntry === 'object' && (routeEntry as { provider: string }).provider === fbKey) {
                    fbRewrite = (routeEntry as { rewrite?: string }).rewrite || routeModel; break;
                }
            }
        }
        if (!fbRewrite && routing.routes) {
            for (const [routeModel, routeEntry] of Object.entries(routing.routes)) {
                if (typeof routeEntry === 'string' && routeEntry === fbKey) {
                    fbRewrite = routeModel; break;
                } else if (routeEntry && typeof routeEntry === 'object' && (routeEntry as { provider: string }).provider === fbKey) {
                    fbRewrite = (routeEntry as { rewrite?: string }).rewrite || routeModel; break;
                }
            }
        }

        return {
            providerKey: fbKey,
            url: fb.url,
            key: fbResolvedKey,
            isBearer: (fb.auth || fb.authHeader) === 'bearer',
            targetUrl: fbUrl,
            rewriteModel: fbRewrite,
            format: fb.format || 'anthropic',
        };
    }

    // Build fallback chain
    const fallbacks: ResolvedTarget[] = [];
    if (provider.fallback && Array.isArray(provider.fallback)) {
        for (const fbKey of provider.fallback) {
            const fb = routing.providers ? routing.providers[fbKey] : undefined;
            if (!fb) continue;
            const fbTarget = await resolveFallback(fbKey, fb);
            if (fbTarget) fallbacks.push(fbTarget);
        }
    }

    // Auto-fallback: when no explicit fallbacks are configured, try all
    // other available providers as implicit fallbacks.  This prevents
    // single-provider death spirals where the primary rejects a request for
    // provider-specific reasons (e.g. output token limits, payload size)
    // and the session retries the same provider endlessly.
    // Providers with noAutoFallback:true (e.g. ds, oc, um) opt out — they
    // are primary providers that should fail-fast rather than auto-cascading.
    // When the providers.json metadata wasn't loaded (--routes-only mode),
    // fall back to a hardcoded set of well-known noAutoFallback providers.
    const HARDCODED_NO_AUTO_FALLBACK = new Set(['ds', 'oc', 'um']);
    const primaryDef = routing.providers?.[primary.providerKey];
    const hasNoAutoFallback = (primaryDef?.noAutoFallback) || HARDCODED_NO_AUTO_FALLBACK.has(primary.providerKey);
    if (fallbacks.length === 0 && routing.providers && !hasNoAutoFallback) {
        for (const [fbKey, fb] of Object.entries(routing.providers)) {
            // Skip circuit-broken providers — no point resolving keys for
            // providers that won't be used.  This also prevents wasted
            // encrypted-key decryption attempts on unreachable providers.
            if (!isProviderHealthy(fbKey)) continue;
            const fbTarget = await resolveFallback(fbKey, fb);
            if (fbTarget) fallbacks.push(fbTarget);
        }
    }

    // Circuit breaker: skip unhealthy primary
    if (!isProviderHealthy(primary.providerKey)) {
        if (fallbacks.length > 0) {
            const healthyFallbackIdx = fallbacks.findIndex(f => isProviderHealthy(f.providerKey));
            if (healthyFallbackIdx >= 0) {
                const tmp = primary;
                primary = fallbacks[healthyFallbackIdx];
                fallbacks[healthyFallbackIdx] = tmp;
            }
        } else {
            return { error: 'Primary provider ' + primary.providerKey + ' is unhealthy (circuit breaker open)' };
        }
    }

    return { primary, fallbacks };
}

