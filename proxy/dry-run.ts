'use strict';

import fs from 'fs';
import path from 'path';
import type { RoutingConfig } from './routing';

function padEnd(s: string, len: number): string {
    while (s.length < len) s += ' ';
    return s;
}

function fmtLimit(limit: number): string {
    if (limit >= 1000000) return (limit / 1000000).toFixed(0) + 'M tokens';
    if (limit >= 1000) return (limit / 1000).toFixed(0) + 'K tokens';
    return String(limit) + ' tokens';
}

export function runDryRun(routesFile: string): void {
    const raw = fs.readFileSync(routesFile, 'utf-8');
    const config = JSON.parse(raw) as RoutingConfig & {
        slots?: Record<string, string>;
        contextLimits?: Record<string, number>;
    };

    const displayNames: Record<string, string> = {};
    try {
        const reg = JSON.parse(fs.readFileSync(path.join(__dirname, 'providers.json'), 'utf-8'));
        if (reg.providers) {
            for (const [k, v] of Object.entries(reg.providers)) {
                displayNames[k] = (v as { displayName: string }).displayName || k;
            }
        }
    } catch (_) {}

    interface Row {
        slot: string;
        providerKey: string;
        model: string;
        format: string;
        keyStatus: string;
        fallback: string;
    }

    const rows: Row[] = [];
    const slots = config.slots || {};

    for (const [slotName, slotValue] of Object.entries(slots)) {
        const m = slotValue.match(/^(\w+):(\w+):(.+)$/);
        if (!m) {
            rows.push({ slot: slotName, providerKey: '?', model: slotValue, format: '?', keyStatus: '?', fallback: '-' });
            continue;
        }
        const providerKey = m[2];
        const model = m[3];
        const provider = config.providers ? config.providers[providerKey] : undefined;
        if (!provider) {
            rows.push({ slot: slotName, providerKey: providerKey + ' (unknown)', model: model, format: '?', keyStatus: '?', fallback: '-' });
            continue;
        }

        const format = provider.format || 'anthropic';
        const keyEnv = provider.keyEnv;
        const keyStatus = keyEnv ? (process.env[keyEnv] ? 'SET' : 'MISSING') : 'N/A';
        const display = displayNames[providerKey] || providerKey;
        let fallback = '-';
        if (provider.fallback && provider.fallback.length > 0) fallback = provider.fallback.join(', ');

        rows.push({ slot: slotName, providerKey: providerKey + ' (' + display + ')', model: model, format: format, keyStatus: keyStatus, fallback: fallback });
    }

    const cols: Array<{ label: string; width: number; key: keyof Row }> = [
        { label: 'SLOT', width: 12, key: 'slot' },
        { label: 'PROVIDER', width: 30, key: 'providerKey' },
        { label: 'MODEL', width: 32, key: 'model' },
        { label: 'FORMAT', width: 10, key: 'format' },
        { label: 'KEY', width: 8, key: 'keyStatus' },
        { label: 'FALLBACK', width: 30, key: 'fallback' },
    ];

    const sep = '  ';
    console.log('');
    console.log(cols.map(c => padEnd(c.label, c.width)).join(sep));
    console.log(cols.map(c => '-'.repeat(c.width)).join(sep));

    for (const row of rows) {
        console.log(cols.map(c => padEnd(row[c.key], c.width)).join(sep));
    }

    const limits = config.contextLimits;
    if (limits) {
        const keys = Object.keys(limits);
        if (keys.length > 0) {
            console.log('');
            console.log('Context limits:');
            const seen = new Set<string>();
            for (const [model, limit] of Object.entries(limits)) {
                const short = model.split('/').pop() || model;
                if (seen.has(short)) continue;
                seen.add(short);
                console.log('  ' + short + ': ' + fmtLimit(limit));
            }
        }
    }

    console.log('');
}
