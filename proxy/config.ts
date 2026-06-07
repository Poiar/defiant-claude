'use strict';

// Config management: argument parsing, route file loading, and hot-reload.
// Reads routes.json and slot-overrides.json, polls for changes once per second.

import fs from 'fs';
import { createLogger } from './log';
import { validateUrl } from './ssrf';
import { decrypt } from './crypto';

const log = createLogger('config');

// --- Interfaces ---

interface ParsedArgs {
    routesFile: string | null;
    overridesFile: string | null;
    singleUrl: string | null;
    singleKey: string | null;
}
interface ProviderEntry {
    url: string;
    auth?: string;
    format?: string;
    fallback?: string[];
    key?: string;
    keyEnv?: string;
}
interface RoutingConfig {
    providers?: Record<string, ProviderEntry>;
    defaultProvider?: string;
    routes?: Record<string, string | { provider: string; rewrite?: string }>;
}
interface ConfigState {
    routing: RoutingConfig | null;
    routesMtime: number;
    slotOverrides: Record<string, string>;
    overridesMtime: number;
}
// --- Argument parsing ---

export function parseArgs(argv: string[]): ParsedArgs {
    const args = argv.slice(2);
    let routesFile: string | null = null;
    let overridesFile: string | null = null;
    let singleUrl: string | null = null;
    let singleKey: string | null = null;

    if (args[0] === '--routes' && args[1]) {
        routesFile = args[1];
        if (args[2] === '--overrides' && args[3]) {
            overridesFile = args[3];
        }
    } else if (args.length >= 2) {
        singleUrl = args[0];
        singleKey = args[1];
    } else {
        console.error('Usage: npx tsx start-proxy.ts <provider_url> <api_key>');
        console.error('       npx tsx start-proxy.ts --routes <routes.json> [--overrides <overrides.json>]');
        process.exit(1);
    }
    return { routesFile, overridesFile, singleUrl, singleKey };
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
// --- Load initial state ---

export function loadConfig(parsed: ParsedArgs): ConfigState {
    let routing: RoutingConfig | null = null;
    let routesMtime = 0;
    let overridesMtime = 0;
    let slotOverrides: Record<string, string> = {};

    if (parsed.routesFile) {
        routing = readJson(parsed.routesFile) as RoutingConfig;
        routesMtime = fs.statSync(parsed.routesFile).mtimeMs;
    }
    if (parsed.overridesFile) {
        try {
            slotOverrides = readJson(parsed.overridesFile) as Record<string, string>;
            overridesMtime = fs.statSync(parsed.overridesFile).mtimeMs;
        } catch (e) {
            // Overrides file optional -- may not exist yet
        }
    }
    // Fire-and-forget SSRF validation for provider endpoint URLs
    if (routing && routing.providers) {
        for (const [key, provider] of Object.entries(routing.providers)) {
            if (provider.url) {
                validateUrl(provider.url).then((result: { valid: boolean; reason?: string }) => {
                    if (!result.valid) {
                        log.warn(null, 'Provider "' + key + '" URL fails SSRF check: ' + (result.reason || 'unknown'));
                    }
                }).catch((err: Error) => {
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
export function checkReload(state: ConfigState, parsed: ParsedArgs): boolean {
    const now = Date.now();
    if (now - lastStatCheck < 1000) return false;
    lastStatCheck = now;

    let changed = false;

    if (parsed.routesFile) {
        try {
            const stat = fs.statSync(parsed.routesFile);
            if (stat.mtimeMs > state.routesMtime) {
                state.routing = readJson(parsed.routesFile) as RoutingConfig;
                state.routesMtime = stat.mtimeMs;
                changed = true;
            }
        } catch (e) {
            log.error(null, 'Failed to reload routes: ' + (e as Error).message);
        }
    }
    if (parsed.overridesFile) {
        try {
            const stat = fs.statSync(parsed.overridesFile);
            if (stat.mtimeMs > state.overridesMtime) {
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

export function validateConfig(state: ConfigState, _parsed: ParsedArgs): string[] {
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

export function resolveKey(rawKey: string | null | undefined): string | null | undefined {
    if (!rawKey || typeof rawKey !== 'string' || !rawKey.startsWith('$aes256gcm:')) {
        return rawKey;
    }
    const masterSecret = process.env.DEEPCLAUDE_ENCRYPTION_KEY;
    if (!masterSecret) {
        log.warn(null, 'Encrypted key found but DEEPCLAUDE_ENCRYPTION_KEY is not set');
        return null;
    }
    try {
        return decrypt(rawKey, masterSecret);
    } catch (err) {
        log.warn(null, 'Failed to decrypt API key: ' + (err as Error).message);
        return null;
    }
}
