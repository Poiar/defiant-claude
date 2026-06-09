'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveTarget = resolveTarget;
// Request routing: resolveTarget determines which provider + model handles
// a given request. Supports slot prefixes, explicit provider overrides,
// route table lookups, and fallback chain construction with circuit breaker.
const url_1 = require("url");
const stats_1 = require("./stats");
const config_1 = require("./config");
// Resolve the primary provider and fallback chain for a given model name.
//
// Routing priority:
//   1. Slot prefix ("sonnet:", "opus:", "haiku:", "subagent:") -> check overrides
//   2. Explicit provider prefix ("ds:", "oc:", "or:") -> direct provider lookup
//   3. Routes table lookup by model ID
//   4. Default provider fallback
//
// Returns { primary, fallbacks } on success, { error } on failure.
function resolveTarget(model, routing, slotOverrides, singleUrl, singleKey) {
    // Single-provider (legacy) mode
    if (!routing) {
        const targetUrl = new url_1.URL(singleUrl);
        const isBearer = !targetUrl.hostname.includes('deepseek.com');
        const primary = {
            providerKey: 'direct',
            url: singleUrl,
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
    let providerKey = null;
    let rewriteModel = null;
    // Check for providerKey:modelId prefix (explicit provider override from /model)
    const prefixMatch = resolvedModel && resolvedModel.match(/^([a-z][a-z0-9_-]*):(.+)$/);
    if (prefixMatch && routing.providers && routing.providers[prefixMatch[1]]) {
        providerKey = prefixMatch[1];
        rewriteModel = (0, config_1.resolveAlias)(prefixMatch[2]);
    }
    else {
        // Resolve model alias before routes table lookup
        const resolvedAlias = (0, config_1.resolveAlias)(resolvedModel || '');
        // Fall back to routes table lookup
        const route = (resolvedAlias && routing.routes && routing.routes[resolvedAlias]) || null;
        if (!route) {
            providerKey = routing.defaultProvider || null;
        }
        else if (typeof route === 'string') {
            providerKey = route;
        }
        else if (route && typeof route === 'object' && route.provider) {
            providerKey = route.provider;
            rewriteModel = route.rewrite || null;
        }
        else {
            providerKey = routing.defaultProvider || null;
        }
    }
    const provider = (providerKey && routing.providers) ? routing.providers[providerKey] : null;
    if (!provider || !providerKey) {
        return { error: providerKey ? 'Unknown provider: ' + providerKey : 'No default provider configured' };
    }
    const targetUrl = new url_1.URL(provider.url);
    const rawKey = process.env[provider.keyEnv || ''] || provider.key;
    const resolvedKey = (0, config_1.resolveKey)(rawKey);
    if (rawKey && rawKey.startsWith('$aes256gcm:') && resolvedKey === null) {
        return { error: 'Provider "' + providerKey + '" has encrypted key but DEEPCLAUDE_ENCRYPTION_KEY is not set or decryption failed' };
    }
    let primary = {
        providerKey,
        url: provider.url,
        key: resolvedKey,
        isBearer: provider.auth === 'bearer',
        targetUrl: targetUrl,
        rewriteModel: rewriteModel,
        format: provider.format || 'anthropic',
    };
    // Build fallback chain
    const fallbacks = [];
    if (provider.fallback && Array.isArray(provider.fallback)) {
        for (const fbKey of provider.fallback) {
            if (fbKey === providerKey)
                continue;
            const fb = routing.providers ? routing.providers[fbKey] : undefined;
            if (!fb)
                continue;
            const fbRawKey = process.env[fb.keyEnv || ''] || fb.key;
            if (!fbRawKey)
                continue;
            const fbResolvedKey = (0, config_1.resolveKey)(fbRawKey);
            if (fbRawKey.startsWith('$aes256gcm:') && fbResolvedKey === null)
                continue;
            const fbUrl = new url_1.URL(fb.url);
            // Resolve the correct model rewrite for the fallback provider.
            // Don't inherit the primary's rewriteModel -- different providers
            // use different model names. Prefer routes matching the same
            // capability tier (opus/sonnet/haiku) to avoid tier downgrades.
            let fbRewrite = null;
            const tier = (model || '').match(/(opus|sonnet|haiku|subagent)/);
            const tierPart = tier ? tier[1] : null;
            if (tierPart && routing.routes) {
                for (const [routeModel, routeEntry] of Object.entries(routing.routes)) {
                    if (!routeModel.includes(tierPart))
                        continue;
                    if (typeof routeEntry === 'string' && routeEntry === fbKey) {
                        fbRewrite = routeModel;
                        break;
                    }
                    else if (routeEntry && typeof routeEntry === 'object' && routeEntry.provider === fbKey) {
                        fbRewrite = routeEntry.rewrite || routeModel;
                        break;
                    }
                }
            }
            if (!fbRewrite && routing.routes) {
                for (const [routeModel, routeEntry] of Object.entries(routing.routes)) {
                    if (typeof routeEntry === 'string' && routeEntry === fbKey) {
                        fbRewrite = routeModel;
                        break;
                    }
                    else if (routeEntry && typeof routeEntry === 'object' && routeEntry.provider === fbKey) {
                        fbRewrite = routeEntry.rewrite || routeModel;
                        break;
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
    if (!(0, stats_1.isProviderHealthy)(primary.providerKey)) {
        if (fallbacks.length > 0) {
            const healthyFallbackIdx = fallbacks.findIndex(f => (0, stats_1.isProviderHealthy)(f.providerKey));
            if (healthyFallbackIdx >= 0) {
                const tmp = primary;
                primary = fallbacks[healthyFallbackIdx];
                fallbacks[healthyFallbackIdx] = tmp;
            }
        }
        else {
            return { error: 'Primary provider ' + primary.providerKey + ' is unhealthy (circuit breaker open)' };
        }
    }
    return { primary, fallbacks };
}
