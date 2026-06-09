'use strict';
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseArgs = parseArgs;
exports.readJson = readJson;
exports.tryReadJson = tryReadJson;
exports.loadConfig = loadConfig;
exports.checkReload = checkReload;
exports.validateConfig = validateConfig;
exports.resolveKey = resolveKey;
exports.loadAliases = loadAliases;
exports.resetAliasCache = resetAliasCache;
exports.resolveAlias = resolveAlias;
// Config management: argument parsing, route file loading, and hot-reload.
// Reads routes.json and slot-overrides.json, polls for changes once per second.
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const log_1 = require("./log");
const ssrf_1 = require("./ssrf");
const crypto_1 = require("./crypto");
const log = (0, log_1.createLogger)('config');
// --- Argument parsing ---
function parseArgs(argv) {
    const args = argv.slice(2);
    let routesFile = null;
    let overridesFile = null;
    let singleUrl = null;
    let singleKey = null;
    if (args[0] === '--routes' && args[1]) {
        routesFile = args[1];
        if (args[2] === '--overrides' && args[3]) {
            overridesFile = args[3];
        }
    }
    else if (args.length >= 2) {
        singleUrl = args[0];
        singleKey = args[1];
    }
    else {
        console.error('Usage: npx tsx start-proxy.ts <provider_url> <api_key>');
        console.error('       npx tsx start-proxy.ts --routes <routes.json> [--overrides <overrides.json>]');
        process.exit(1);
    }
    return { routesFile, overridesFile, singleUrl, singleKey };
}
// --- JSON file helpers ---
function readJson(path) {
    const raw = fs_1.default.readFileSync(path, 'utf-8');
    return JSON.parse(raw);
}
function tryReadJson(path) {
    try {
        return readJson(path);
    }
    catch (_) {
        return null;
    }
}
// --- Load initial state ---
function loadConfig(parsed) {
    let routing = null;
    let routesMtime = 0;
    let overridesMtime = 0;
    let slotOverrides = {};
    if (parsed.routesFile) {
        routing = readJson(parsed.routesFile);
        routesMtime = fs_1.default.statSync(parsed.routesFile).mtimeMs;
    }
    if (parsed.overridesFile) {
        try {
            slotOverrides = readJson(parsed.overridesFile);
            overridesMtime = fs_1.default.statSync(parsed.overridesFile).mtimeMs;
        }
        catch (e) {
            // Overrides file optional -- may not exist yet
        }
    }
    // Fire-and-forget SSRF validation for provider endpoint URLs
    if (routing && routing.providers) {
        for (const [key, provider] of Object.entries(routing.providers)) {
            if (provider.url) {
                (0, ssrf_1.validateUrl)(provider.url).then((result) => {
                    if (!result.valid) {
                        log.warn(null, 'Provider "' + key + '" URL fails SSRF check: ' + (result.reason || 'unknown'));
                    }
                }).catch((err) => {
                    log.warn(null, 'Provider "' + key + '" SSRF validation error: ' + err.message);
                });
            }
        }
    }
    return { routing, routesMtime, slotOverrides, overridesMtime };
}
// --- Hot-reload ---
// Polls route and override files once per second. If mtimes change, reloads.
// Returns true if anything changed.
let lastStatCheck = 0;
function checkReload(state, parsed) {
    const now = Date.now();
    if (now - lastStatCheck < 1000)
        return false;
    lastStatCheck = now;
    let changed = false;
    if (parsed.routesFile) {
        try {
            const stat = fs_1.default.statSync(parsed.routesFile);
            if (stat.mtimeMs > state.routesMtime) {
                state.routing = readJson(parsed.routesFile);
                state.routesMtime = stat.mtimeMs;
                changed = true;
            }
        }
        catch (e) {
            log.error(null, 'Failed to reload routes: ' + e.message);
        }
    }
    if (parsed.overridesFile) {
        try {
            const stat = fs_1.default.statSync(parsed.overridesFile);
            if (stat.mtimeMs > state.overridesMtime) {
                state.slotOverrides = readJson(parsed.overridesFile);
                state.overridesMtime = stat.mtimeMs;
                changed = true;
            }
        }
        catch (e) {
            log.error(null, 'Failed to reload ' + parsed.overridesFile + ': ' + e.message);
        }
    }
    return changed;
}
// --- Validate routing config ---
// Checks for common misconfigurations at startup.
function validateConfig(state) {
    const warnings = [];
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
                        warnings.push('Provider "' + key + '" fallback "' + fb + '" not found in providers table');
                    }
                }
            }
        }
        if (state.routing.defaultProvider && !providerKeys.has(state.routing.defaultProvider)) {
            warnings.push('defaultProvider "' + state.routing.defaultProvider + '" not found in providers table');
        }
        if (state.routing.routes) {
            for (const [model, route] of Object.entries(state.routing.routes)) {
                let providerKey = null;
                if (typeof route === 'string') {
                    providerKey = route;
                }
                else if (route && typeof route === 'object' && route.provider) {
                    providerKey = route.provider;
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
function resolveKey(rawKey) {
    if (!rawKey || typeof rawKey !== 'string' || !rawKey.startsWith('$aes256gcm:')) {
        return rawKey;
    }
    const masterSecret = process.env.DEEPCLAUDE_ENCRYPTION_KEY;
    if (!masterSecret) {
        log.warn(null, 'Encrypted key found but DEEPCLAUDE_ENCRYPTION_KEY is not set');
        return null;
    }
    try {
        return (0, crypto_1.decrypt)(rawKey, masterSecret);
    }
    catch (err) {
        log.warn(null, 'Failed to decrypt API key: ' + err.message);
        return null;
    }
}
// --- Model alias resolution ---
// Loads short-name aliases from providers.json and resolves them to full model IDs.
// Aliases are case-insensitive; unknown inputs pass through unchanged.
let aliasCache = null;
function loadAliases() {
    if (aliasCache)
        return aliasCache;
    try {
        const data = readJson(path_1.default.join(__dirname, 'providers.json'));
        aliasCache = data.aliases || {};
    }
    catch (_) {
        aliasCache = {};
    }
    return aliasCache;
}
/** Reset the alias cache (used in tests to reload from disk). */
function resetAliasCache() {
    aliasCache = null;
}
function resolveAlias(modelId) {
    if (!modelId)
        return modelId;
    const aliases = loadAliases();
    const lower = modelId.toLowerCase();
    return aliases[lower] || modelId;
}
