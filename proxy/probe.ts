'use strict';

import http from 'http';
import https from 'https';
import fs from 'fs';
import { resolveKey, resolveProviderKey } from './config';
import { translateRequest } from './protocol-translate';
import { deduplicatePath } from './util';
import type { RoutingConfig } from './routing';

const PROBE_TIMEOUT = 15_000;
const TEST_PROMPT = 'Hi';
const TEST_MAX_TOKENS = 10;

export interface ProbeSlot {
    slot: string;
    providerKey: string;
    model: string;
    url: string;
    key: string | null | undefined;
    isBearer: boolean;
    format: string;
}

export interface ProbeResult {
    slot: string;
    provider: string;
    model: string;
    latency: number;
    status: number;
    inputTokens: number;
    outputTokens: number;
    authFailed: boolean;
    success: boolean;
    error: string;
}

function buildProbeUrl(baseUrl: string, format: string): URL {
    const parsed = new URL(baseUrl);
    const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    const endpointPath = format === 'openai' ? '/chat/completions' : '/v1/messages';
    const fullPath = deduplicatePath(pathname, endpointPath);
    return new URL(fullPath, parsed.origin);
}

function formatMs(ms: number): string {
    if (ms >= 1000) {
        return (ms / 1000).toFixed(2) + 's';
    }
    return ms.toFixed(0) + 'ms';
}

function padEnd(s: string, len: number): string {
    while (s.length < len) s += ' ';
    return s;
}

function printResults(results: ProbeResult[]): void {
    const cols = [
        { key: 'slot' as const, label: 'Slot', width: 18 },
        { key: 'provider' as const, label: 'Provider', width: 12 },
        { key: 'model' as const, label: 'Model', width: 32 },
        { key: 'latency' as const, label: 'Latency', width: 10 },
        { key: 'status' as const, label: 'Status', width: 8 },
        { key: 'tokens' as const, label: 'Tokens', width: 14 },
        { key: 'result' as const, label: 'Result', width: 8 },
    ];

    function getVal(r: ProbeResult, k: string): string {
        switch (k) {
            case 'slot': return r.slot;
            case 'provider': return r.provider;
            case 'model': return r.model;
            case 'latency': return formatMs(r.latency);
            case 'status': return String(r.status || 0);
            case 'tokens': return r.success ? `${r.inputTokens}/${r.outputTokens}` : '-';
            case 'result': return r.success ? 'PASS' : 'FAIL';
            default: return '';
        }
    }

    const sep = ' | ';
    const header = cols.map(c => padEnd(c.label, c.width)).join(sep);
    const divider = cols.map(c => '-'.repeat(c.width)).join(sep);

    console.log('\n' + header);
    console.log(divider);

    let allPass = true;
    for (const r of results) {
        const row = cols.map(c => padEnd(getVal(r, c.key), c.width)).join(sep);
        console.log(row);
        if (!r.success) allPass = false;
    }
    console.log('');

    if (!allPass) {
        console.log('FAILURES:');
        for (const r of results) {
            if (!r.success) {
                const errMsg = r.error ? ' - ' + r.error : '';
                console.log('  ' + r.slot + ' (' + r.provider + '/' + r.model + ') FAILED' + errMsg);
            }
        }
        console.log('');
    }

    const passCount = results.filter(r => r.success).length;
    const failCount = results.length - passCount;
    console.log(passCount + '/' + results.length + ' probes passed' + (failCount > 0 ? ', ' + failCount + ' failed' : ''));
}

export function sendProbe(target: ProbeSlot): Promise<ProbeResult> {
    const t0 = Date.now();
    const result: ProbeResult = {
        slot: target.slot,
        provider: target.providerKey,
        model: target.model,
        latency: 0,
        status: 0,
        inputTokens: 0,
        outputTokens: 0,
        authFailed: false,
        success: false,
        error: '',
    };

    let body: string;
    const isOpenAI = target.format === 'openai';
    if (isOpenAI) {
        const anthropicReq = {
            model: target.model,
            max_tokens: TEST_MAX_TOKENS,
            messages: [{ role: 'user' as const, content: TEST_PROMPT }],
        };
        const { openaiBody } = translateRequest(anthropicReq as any);
        body = JSON.stringify(openaiBody);
    } else {
        body = JSON.stringify({
            model: target.model,
            max_tokens: TEST_MAX_TOKENS,
            messages: [{ role: 'user', content: TEST_PROMPT }],
        });
    }

    const url = buildProbeUrl(target.url, target.format);

    const transport = url.protocol === 'https:' ? https : http;
    const headers: Record<string, string> = {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body)),
    };
    if (target.isBearer) {
        headers['authorization'] = 'Bearer ' + (target.key || '');
    } else {
        headers['x-api-key'] = target.key || '';
    }
    if (isOpenAI) {
        headers['accept'] = 'application/json';
    } else {
        headers['anthropic-version'] = '2023-06-01';
        headers['accept'] = 'application/json';
    }

    return new Promise((resolve) => {
        const req = transport.request(
            {
                hostname: url.hostname,
                port: url.port || (url.protocol === 'https:' ? 443 : 80),
                path: url.pathname + url.search,
                method: 'POST',
                headers,
                timeout: PROBE_TIMEOUT,
            },
            (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (chunk: Buffer) => chunks.push(chunk));
                res.on('end', () => {
                    const ms = Date.now() - t0;
                    result.latency = ms;
                    result.status = res.statusCode || 0;

                    if (!res.statusCode || res.statusCode >= 400) {
                        result.authFailed = res.statusCode === 401 || res.statusCode === 403;
                        const errBody = Buffer.concat(chunks).toString().trim();
                        result.error = errBody ? errBody.substring(0, 200) : 'HTTP ' + res.statusCode;
                        resolve(result);
                        return;
                    }

                    result.success = true;
                    try {
                        const parsed = JSON.parse(Buffer.concat(chunks).toString());
                        if (isOpenAI) {
                            const u = parsed.usage;
                            if (u) {
                                result.inputTokens = u.prompt_tokens || 0;
                                result.outputTokens = u.completion_tokens || 0;
                            }
                        } else {
                            const u = parsed.usage;
                            if (u) {
                                result.inputTokens = u.input_tokens || 0;
                                result.outputTokens = u.output_tokens || 0;
                            }
                        }
                    } catch {
                        result.success = false;
                        result.error = 'response format mismatch: expected JSON with usage data, but could not parse response';
                    }
                    resolve(result);
                });
                res.on('error', (err: Error) => {
                    result.latency = Date.now() - t0;
                    result.error = err.message;
                    resolve(result);
                });
            }
        );

        req.on('timeout', () => {
            req.destroy();
            result.latency = Date.now() - t0;
            result.error = 'timeout (' + PROBE_TIMEOUT + 'ms)';
            resolve(result);
        });

        req.on('error', (err: Error) => {
            result.latency = Date.now() - t0;
            result.error = err.message;
            resolve(result);
        });

        req.write(body);
        req.end();
    });
}

function resolveSlotProvider(config: RoutingConfig, modelName: string, slotValue: string): { providerKey: string; actualModel: string } | null {
    const slotMatch = slotValue.match(/^(sonnet|opus|haiku|subagent|fable):(\w+):(.+)$/);
    if (!slotMatch) return null;
    const providerKey = slotMatch[2];
    const actualModel = slotMatch[3];
    if (!config.providers || !config.providers[providerKey]) return null;
    return { providerKey, actualModel };
}

async function addSlot(config: RoutingConfig, seen: Set<string>, slots: ProbeSlot[], slot: string, providerKey: string, actualModel: string): Promise<void> {
    const pairKey = providerKey + ':' + actualModel;
    if (seen.has(pairKey)) return;
    seen.add(pairKey);

    const provider = config.providers![providerKey];
    const rawKey = provider.keyEnv
        ? (resolveProviderKey(provider.keyEnv) || provider.key || null)
        : (provider.key || null);
    const resolvedKey = await resolveKey(rawKey);

    slots.push({
        slot,
        providerKey,
        model: actualModel,
        url: provider.url,
        key: resolvedKey,
        isBearer: provider.auth === 'bearer',
        format: provider.format || 'anthropic',
    });
}

async function collectSlots(config: RoutingConfig): Promise<ProbeSlot[]> {
    const slots: ProbeSlot[] = [];
    const seen = new Set<string>();
    if (!config.providers) return slots;

    const maybeSlots = (config as unknown as { slots?: Record<string, string> }).slots;
    if (maybeSlots) {
        for (const [slotName, slotValue] of Object.entries(maybeSlots)) {
            const resolved = resolveSlotProvider(config, slotName, slotValue);
            if (resolved) {
                await addSlot(config, seen, slots, slotName, resolved.providerKey, resolved.actualModel);
            }
        }
    }

    if (config.routes) {
        for (const [modelName, routeEntry] of Object.entries(config.routes)) {
            let providerKey: string | null = null;
            let rewriteModel: string | null = null;

            if (typeof routeEntry === 'string') {
                providerKey = routeEntry;
            } else if (routeEntry && typeof routeEntry === 'object') {
                const entry = routeEntry as { provider?: string; rewrite?: string };
                providerKey = entry.provider || null;
                rewriteModel = entry.rewrite || null;
            }

            if (!providerKey || !config.providers[providerKey]) continue;
            const actualModel = rewriteModel || modelName;
            await addSlot(config, seen, slots, modelName, providerKey, actualModel);
        }
    }

    return slots;
}

export async function runProbe(routesFile: string): Promise<void> {
    const config = JSON.parse(fs.readFileSync(routesFile, 'utf-8')) as RoutingConfig;
    const slots = await collectSlots(config);

    if (slots.length === 0) {
        console.error('No probe targets found in ' + routesFile);
        process.exit(1);
        return;
    }

    console.log('Probing ' + slots.length + ' unique provider/model combination(s)...\n');

    const results = await Promise.all(slots.map(s => sendProbe(s)));

    printResults(results);

    const allPass = results.every(r => r.success);
    process.exit(allPass ? 0 : 1);
}
