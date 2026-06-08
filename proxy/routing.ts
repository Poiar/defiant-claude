'use strict';

// Request routing: resolveTarget determines which provider + model handles
// a given request. Supports slot prefixes, explicit provider overrides,
// route table lookups, and fallback chain construction with circuit breaker.

import { URL } from 'url';
import { isProviderHealthy } from './stats';
import { resolveKey } from './config';

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
    format?: string;
    fallback?: string[];
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

// Resolve the primary provider and fallback chain for a given model name.
//
// Routing priority:
//   1. Slot prefix ("sonnet:", "opus:", "haiku:", "subagent:") -> check overrides
//   2. Explicit provider prefix ("ds:", "oc:", "or:") -> direct provider lookup
//   3. Routes table lookup by model ID
//   4. Default provider fallback
//
// Returns { primary, fallbacks } on success, { error } on failure.

export function resolveTarget(
    model: string | null | undefined,
    routing: RoutingConfig | null | undefined,
    slotOverrides: SlotOverrides | null | undefined,
    singleUrl: string | null | undefined,
    singleKey: string | null | undefined
): ResolveResult {
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
    const slotMatch = model && model.match(/^(sonnet|opus|haiku|subagent):(.+)$/);
    let resolvedModel = model;
    if (slotMatch) {
        const slot = slotMatch[1];
        const fallback = slotMatch[2];
        resolvedModel = (slotOverrides && slotOverrides[slot]) || fallback;
    }

    let providerKey: string | null = null;
    let rewriteModel: string | null = null;

    // Check for providerKey:modelId prefix (explicit provider override from /model)
    const prefixMatch = resolvedModel && resolvedModel.match(/^([a-z][a-z0-9_-]*):(.+)$/);
    if (prefixMatch && routing.providers && routing.providers[prefixMatch[1]]) {
        providerKey = prefixMatch[1];
        rewriteModel = prefixMatch[2];
    } else {
        // Fall back to routes table lookup
        const route = (resolvedModel && routing.routes && routing.routes[resolvedModel]) || null;

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
    const rawKey = process.env[provider.keyEnv || ''] || provider.key;
    const resolvedKey = resolveKey(rawKey);
    if (rawKey && rawKey.startsWith('$aes256gcm:') && resolvedKey === null) {
        return { error: 'Provider "' + providerKey + '" has encrypted key but DEEPCLAUDE_ENCRYPTION_KEY is not set or decryption failed' };
    }

    let primary: ResolvedTarget = {
        providerKey,
        url: provider.url,
        key: resolvedKey,
        isBearer: provider.auth === 'bearer',
        targetUrl: targetUrl,
        rewriteModel: rewriteModel,
        format: provider.format || 'anthropic',
    };

    // Build fallback chain
    const fallbacks: ResolvedTarget[] = [];
    if (provider.fallback && Array.isArray(provider.fallback)) {
        for (const fbKey of provider.fallback) {
            if (fbKey === providerKey) continue;
            const fb = routing.providers ? routing.providers[fbKey] : undefined;
            if (!fb) continue;
            const fbRawKey = process.env[fb.keyEnv || ''] || fb.key;
            if (!fbRawKey) continue;
            const fbResolvedKey = resolveKey(fbRawKey);
            if (fbRawKey.startsWith('$aes256gcm:') && fbResolvedKey === null) continue;
            const fbUrl = new URL(fb.url);

            // Resolve the correct model rewrite for the fallback provider.
            // Don't inherit the primary's rewriteModel -- different providers
            // use different model names. Prefer routes matching the same
            // capability tier (opus/sonnet/haiku) to avoid tier downgrades.
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

            fallbacks.push({
                providerKey: fbKey,
                url: fb.url,
                key: fbResolvedKey,
                isBearer: fb.auth === 'bearer',
                targetUrl: fbUrl,
                rewriteModel: fbRewrite,
                format: fb.format || 'anthropic',
            });
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

