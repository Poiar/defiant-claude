'use strict';

import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { deduplicatePath } from './util';
import { createLogger } from './log';

const log = createLogger('startup-check');

const STARTUP_CHECK_TIMEOUT = 5000;
const PROBE_BODY_ANTHROPIC = JSON.stringify({
    model: 'claude-sonnet-4-20250514',
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 1,
});
const PROBE_BODY_OPENAI = JSON.stringify({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 1,
});
const PROBE_BODY_ANTHROPIC_STREAM = JSON.stringify({
    model: 'claude-sonnet-4-20250514',
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 1,
    stream: true,
});
const PROBE_BODY_OPENAI_STREAM = JSON.stringify({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 1,
    stream: true,
});

// --- Types ---

interface ProviderDef {
    displayName?: string;
    endpoint: string;
    keyEnv?: string;
    authHeader?: string;
    auth?: string;
    wireFormat?: string;
    extraHeaders?: Record<string, string>;
}

export interface CheckResult {
    providerKey: string;
    displayName: string;
    success: boolean;
    latencyMs: number;
    errorSummary?: string;
    degraded: boolean;
}

export interface StartUpCheckSummary {
    allHealthy: boolean;
    someDown: boolean;
    allDown: boolean;
    probesSkipped?: boolean;
    results: CheckResult[];
    healthyCount: number;
    degradedCount: number;
    downCount: number;
    noKeyCount: number;
}

// --- URL construction ---

function buildProbeUrl(endpoint: string, format: string): URL {
    const parsed = new URL(endpoint);
    const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    const endpointPath = format === 'openai' ? '/chat/completions' : '/v1/messages';
    const fullPath = deduplicatePath(pathname, endpointPath);
    return new URL(fullPath, parsed.origin);
}

// --- Individual probe ---

/**
 * Send a single health probe to a provider endpoint.
 * Returns a CheckResult with success/failure, latency, and error summary.
 */
function sendProbe(
    providerKey: string,
    displayName: string,
    endpoint: string,
    apiKey: string | null | undefined,
    authHeader: string | undefined,
    format: string,
    extraHeaders?: Record<string, string>,
): Promise<CheckResult> {
    const result: CheckResult = {
        providerKey,
        displayName,
        success: false,
        latencyMs: 0,
        degraded: false,
    };

    if (!apiKey) {
        result.errorSummary = 'NO KEY';
        return Promise.resolve(result);
    }

    const t0 = Date.now();
    const isOpenAI = format === 'openai';
    const body = isOpenAI ? PROBE_BODY_OPENAI : PROBE_BODY_ANTHROPIC;
    const url = buildProbeUrl(endpoint, format);
    const transport = url.protocol === 'https:' ? https : http;

    const headers: Record<string, string> = {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body)),
        'accept': 'application/json',
    };

    const authHeaderLower = (authHeader || '').toLowerCase();
    if (authHeaderLower === 'bearer') {
        headers['authorization'] = 'Bearer ' + apiKey;
    } else {
        headers['x-api-key'] = apiKey;
    }

    if (!isOpenAI) {
        headers['anthropic-version'] = '2023-06-01';
    }

    if (extraHeaders) {
        Object.assign(headers, extraHeaders);
    }

    return new Promise((resolve) => {
        const req = transport.request(
            {
                hostname: url.hostname,
                port: url.port || (url.protocol === 'https:' ? 443 : 80),
                path: url.pathname + url.search,
                method: 'POST',
                headers,
                timeout: STARTUP_CHECK_TIMEOUT,
            },
            (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (chunk: Buffer) => chunks.push(chunk));
                res.on('end', () => {
                    const ms = Date.now() - t0;
                    result.latencyMs = ms;

                    if (!res.statusCode || res.statusCode >= 400) {
                        if (res.statusCode === 401 || res.statusCode === 403) {
                            result.errorSummary = 'AUTH FAIL';
                        } else if (res.statusCode === 429) {
                            result.errorSummary = 'RATE LIMITED';
                        } else {
                            result.errorSummary = 'HTTP ' + res.statusCode;
                        }
                        resolve(result);
                        return;
                    }

                    result.success = true;
                    result.degraded = ms > 1000;
                    resolve(result);
                });
                res.on('error', (err: Error) => {
                    result.latencyMs = Date.now() - t0;
                    result.errorSummary = err.message;
                    resolve(result);
                });
            },
        );

        req.on('timeout', () => {
            req.destroy();
            result.latencyMs = Date.now() - t0;
            result.errorSummary = 'timeout (' + STARTUP_CHECK_TIMEOUT + 'ms)';
            resolve(result);
        });

        req.on('error', (err: Error) => {
            result.latencyMs = Date.now() - t0;
            result.errorSummary = err.message;
            resolve(result);
        });

        req.write(body);
        req.end();
    });
}

// --- Streaming probe ---

/**
 * Send a streaming health probe to a provider endpoint.
 * Uses `stream: true` in the request body and checks that the response
 * contains at least one valid SSE event (a line starting with `data:` or `event:`).
 * This catches CDN-level compression issues that non-streaming probes miss.
 */
function sendProbeStream(
    providerKey: string,
    displayName: string,
    endpoint: string,
    apiKey: string | null | undefined,
    authHeader: string | undefined,
    format: string,
    extraHeaders?: Record<string, string>,
): Promise<CheckResult> {
    const result: CheckResult = {
        providerKey,
        displayName,
        success: false,
        latencyMs: 0,
        degraded: false,
    };

    if (!apiKey) {
        result.errorSummary = 'NO KEY';
        return Promise.resolve(result);
    }

    const t0 = Date.now();
    const isOpenAI = format === 'openai';
    const body = isOpenAI ? PROBE_BODY_OPENAI_STREAM : PROBE_BODY_ANTHROPIC_STREAM;
    const url = buildProbeUrl(endpoint, format);
    const transport = url.protocol === 'https:' ? https : http;

    const headers: Record<string, string> = {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body)),
        'accept': 'text/event-stream',
    };

    const authHeaderLower = (authHeader || '').toLowerCase();
    if (authHeaderLower === 'bearer') {
        headers['authorization'] = 'Bearer ' + apiKey;
    } else {
        headers['x-api-key'] = apiKey;
    }

    if (!isOpenAI) {
        headers['anthropic-version'] = '2023-06-01';
    }

    if (extraHeaders) {
        Object.assign(headers, extraHeaders);
    }

    return new Promise((resolve) => {
        const req = transport.request(
            {
                hostname: url.hostname,
                port: url.port || (url.protocol === 'https:' ? 443 : 80),
                path: url.pathname + url.search,
                method: 'POST',
                headers,
                timeout: STARTUP_CHECK_TIMEOUT,
            },
            (res) => {
                // Handle non-2xx status codes
                if (!res.statusCode || res.statusCode >= 400) {
                    const ms = Date.now() - t0;
                    result.latencyMs = ms;
                    if (res.statusCode === 401 || res.statusCode === 403) {
                        result.errorSummary = 'AUTH FAIL';
                    } else if (res.statusCode === 429) {
                        result.errorSummary = 'RATE LIMITED';
                    } else {
                        result.errorSummary = 'HTTP ' + res.statusCode;
                    }
                    res.resume();
                    resolve(result);
                    return;
                }

                // Check each incoming chunk for valid SSE framing
                res.on('data', (chunk: Buffer) => {
                    if (result.success) return;
                    const text = chunk.toString('utf-8');
                    // A valid SSE response contains lines starting with "data:" or "event:"
                    if (/^(?:data:|event:)/m.test(text)) {
                        const ms = Date.now() - t0;
                        result.latencyMs = ms;
                        result.success = true;
                        result.degraded = ms > 1000;
                        // Stop consuming the response — we only needed the first event
                        res.destroy();
                        resolve(result);
                    }
                });

                res.on('end', () => {
                    if (!result.success) {
                        result.latencyMs = Date.now() - t0;
                        result.errorSummary = 'no SSE received';
                        resolve(result);
                    }
                });

                res.on('error', (err: Error) => {
                    result.latencyMs = Date.now() - t0;
                    result.errorSummary = err.message;
                    resolve(result);
                });
            },
        );

        req.on('timeout', () => {
            req.destroy();
            result.latencyMs = Date.now() - t0;
            result.errorSummary = 'timeout';
            resolve(result);
        });

        req.on('error', (err: Error) => {
            result.latencyMs = Date.now() - t0;
            result.errorSummary = err.message;
            resolve(result);
        });

        req.write(body);
        req.end();
    });
}

// --- Main entry point ---

/**
 * Run startup health checks on all providers defined in providers.json.
 * Probes each provider in parallel with a 5-second timeout.
 *
 * Returns a summary with counts and the all-down/some-down status for the caller
 * to decide whether to continue startup or exit.
 */
export async function runStartupChecks(): Promise<StartUpCheckSummary> {
    const skip = process.env.DEEPCLAUDE_SKIP_STARTUP_CHECK;
    if (skip === 'true' || skip === '1') {
        log.info(null, 'Startup health check skipped (DEEPCLAUDE_SKIP_STARTUP_CHECK=true)');
        return {
            allHealthy: true,
            someDown: false,
            allDown: false,
            probesSkipped: true,
            results: [],
            healthyCount: 0,
            degradedCount: 0,
            downCount: 0,
            noKeyCount: 0,
        };
    }

    // Read providers.json to get all provider definitions
    let providersData: Record<string, ProviderDef> = {};
    try {
        const raw = fs.readFileSync(path.join(__dirname, 'providers.json'), 'utf-8');
        const parsed = JSON.parse(raw);
        providersData = parsed.providers || {};
    } catch (e) {
        log.error(null, 'Failed to read providers.json: ' + (e as Error).message);
        return {
            allHealthy: true,
            someDown: false,
            allDown: false,
            probesSkipped: true,
            results: [],
            healthyCount: 0,
            degradedCount: 0,
            downCount: 0,
            noKeyCount: 0,
        };
    }

    const providerKeys = Object.keys(providersData);
    if (providerKeys.length === 0) {
        log.warn(null, 'No providers found in providers.json');
        return {
            allHealthy: true,
            someDown: false,
            allDown: false,
            probesSkipped: true,
            results: [],
            healthyCount: 0,
            degradedCount: 0,
            downCount: 0,
            noKeyCount: 0,
        };
    }

    log.info(null, 'startup health check (' + STARTUP_CHECK_TIMEOUT + 'ms timeout, ' + providerKeys.length + ' providers)');

    // Launch both non-streaming and streaming probes in parallel per provider.
    // The streaming probe catches CDN-level compression issues and runs concurrently
    // so it does not double the startup time.
    const probePromises = providerKeys.map((key) => {
        const def = providersData[key];
        const apiKey = def.keyEnv ? process.env[def.keyEnv] : undefined;
        const pName = def.displayName || key;
        const pAuth = def.authHeader || def.auth || 'x-api-key';
        const pFmt = def.wireFormat || 'anthropic';
        return Promise.all([
            sendProbe(key, pName, def.endpoint, apiKey, pAuth, pFmt, def.extraHeaders),
            sendProbeStream(key, pName, def.endpoint, apiKey, pAuth, pFmt, def.extraHeaders),
        ]);
    });

    const settled = await Promise.allSettled(probePromises);
    const results: CheckResult[] = settled.map((s) => {
        if (s.status === 'rejected') {
            return {
                providerKey: 'unknown',
                displayName: 'unknown',
                success: false,
                latencyMs: 0,
                errorSummary: 'probe crashed',
                degraded: false,
            };
        }
        const [nonStream, stream] = s.value;
        const result: CheckResult = {
            providerKey: nonStream.providerKey,
            displayName: nonStream.displayName,
            success: nonStream.success && stream.success,
            latencyMs: Math.max(nonStream.latencyMs, stream.latencyMs),
            degraded: nonStream.degraded || stream.degraded,
        };
        if (!result.success) {
            if (!nonStream.success && !stream.success) {
                const nsErr = nonStream.errorSummary || 'probe fail';
                const stErr = stream.errorSummary || 'fail';
                result.errorSummary = nsErr === stErr ? nsErr : nsErr + ' / stream: ' + stErr;
            } else if (!nonStream.success) {
                result.errorSummary = (nonStream.errorSummary || 'probe fail') + ' (stream OK)';
            } else {
                result.errorSummary = (stream.errorSummary || 'stream fail') + ' (probe OK)';
            }
        }
        return result;
    });

    // Print per-provider results to stdout so the user sees them
    console.log('Startup health check (' + STARTUP_CHECK_TIMEOUT + 'ms timeout):');
    for (const r of results) {
        if (r.errorSummary === 'NO KEY') {
            log.info(null, '  ' + r.providerKey.padEnd(4) + (r.displayName.padEnd(30)) + 'SKIP  (no API key configured)');
            console.log('  ' + r.providerKey.padEnd(4) + (r.displayName.padEnd(30)) + 'SKIP  (no API key configured)');
        } else if (r.success) {
            const label = r.degraded ? 'SLOW' : 'OK';
            const msStr = r.latencyMs >= 1000 ? (r.latencyMs / 1000).toFixed(1) + 's' : r.latencyMs + 'ms';
            log.info(null, '  ' + r.providerKey.padEnd(4) + (r.displayName.padEnd(30)) + label + ' (stream verified)  ' + msStr);
            console.log('  ' + r.providerKey.padEnd(4) + (r.displayName.padEnd(30)) + label + ' (stream verified)  ' + msStr);
        } else {
            log.info(null, '  ' + r.providerKey.padEnd(4) + (r.displayName.padEnd(30)) + 'FAIL  ' + (r.errorSummary || 'error'));
            console.log('  ' + r.providerKey.padEnd(4) + (r.displayName.padEnd(30)) + 'FAIL  ' + (r.errorSummary || 'error'));
        }
    }

    const healthyCount = results.filter(r => r.success && !r.degraded).length;
    const degradedCount = results.filter(r => r.success && r.degraded).length;
    const downCount = results.filter(r => !r.success && r.errorSummary !== 'NO KEY').length;
    const noKeyCount = results.filter(r => r.errorSummary === 'NO KEY').length;
    const allDown = healthyCount === 0 && degradedCount === 0;
    const allHealthy = downCount === 0;

    // Print summary to stdout for CLI visibility
    if (allDown) {
        log.error(null, 'All providers are down. Check your API keys and network.');
        console.log('  ⚠  All ' + providerKeys.length + ' providers unreachable — check API keys and network');
    } else if (!allHealthy) {
        const parts: string[] = [];
        parts.push(healthyCount + '/' + providerKeys.length + ' providers healthy');
        if (degradedCount > 0) parts.push(degradedCount + ' degraded (>1000ms)');
        if (downCount > 0) parts.push(downCount + ' down');
        if (noKeyCount > 0) parts.push(noKeyCount + ' no key');
        log.warn(null, 'Summary: ' + parts.join('. ') + '.');
        const failedNames = results.filter(r => !r.success && r.errorSummary !== 'NO KEY').map(r => r.providerKey).join(', ');
        console.log('  ⚠  ' + parts.join(', ') + (failedNames ? ' — unreachable: ' + failedNames : ''));
    } else {
        log.info(null, 'All ' + providerKeys.length + ' providers healthy.');
        console.log('  ✓  All ' + providerKeys.length + ' providers healthy');
    }
    console.log('');

    return {
        allHealthy,
        someDown: !allHealthy && !allDown,
        allDown,
        results,
        healthyCount,
        degradedCount,
        downCount,
        noKeyCount,
    };
}
