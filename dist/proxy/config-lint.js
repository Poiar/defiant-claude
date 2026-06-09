'use strict';
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateConfig = validateConfig;
exports.formatLintResults = formatLintResults;
exports.lint = lint;
// Config linting: validates providers.json for common misconfigurations.
// Exports validateConfig() for programmatic use, formatLintResults() for display,
// and lint() as the CLI entry point called by deepclaude --lint-config.
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
// --- File loading ---
function loadRegistry(registryPath) {
    const resolvedPath = registryPath || path_1.default.join(__dirname, 'providers.json');
    try {
        const raw = fs_1.default.readFileSync(resolvedPath, 'utf-8');
        const data = JSON.parse(raw);
        return { data, issue: null };
    }
    catch (err) {
        const message = err instanceof SyntaxError
            ? 'Invalid JSON in providers.json: ' + err.message
            : 'Cannot read providers.json: ' + err.message;
        return { data: null, issue: { type: 'ERROR', section: 'general', message } };
    }
}
// --- Formatting ---
function formatContextLimit(limit) {
    if (limit >= 1048576) {
        const val = limit / 1048576;
        return val === Math.floor(val) ? String(val) + 'M' : val.toFixed(1) + 'M';
    }
    if (limit >= 1024) {
        const val = limit / 1024;
        return val === Math.floor(val) ? String(val) + 'K' : val.toFixed(0) + 'K';
    }
    return String(limit);
}
// --- Validation ---
function validateConfig(registryPath) {
    const issues = [];
    const { data: registry, issue } = loadRegistry(registryPath);
    if (issue || !registry) {
        if (issue)
            issues.push(issue);
        return issues;
    }
    const providers = registry.providers || {};
    const contextLimits = registry.contextLimits || {};
    const configs = registry.configs || {};
    const aliases = registry.aliases || {};
    // 1. Schema validation: top-level keys
    const requiredTopLevel = ['providers', 'contextLimits', 'configs'];
    for (const key of requiredTopLevel) {
        if (!(key in registry)) {
            issues.push({ type: 'ERROR', section: 'schema', message: "Missing top-level key: '" + key + "'" });
        }
    }
    // 2. Required provider fields
    const requiredProviderFields = ['endpoint', 'keyEnv', 'authHeader', 'wireFormat'];
    for (const [pk, pv] of Object.entries(providers)) {
        for (const field of requiredProviderFields) {
            if (!pv[field]) {
                issues.push({ type: 'ERROR', section: 'providers', message: "Provider '" + pk + "' missing required field: '" + field + "'" });
            }
        }
    }
    // 3. Build sets of what's referenced in configs
    const referencedProviders = new Set();
    const allReferencedModels = new Set();
    for (const [ck, cv] of Object.entries(configs)) {
        const entry = cv;
        for (const sk of ['opus', 'sonnet', 'haiku', 'sub']) {
            const val = entry[sk];
            if (val && typeof val === 'string' && val.indexOf(':') >= 0) {
                const colonIdx = val.indexOf(':');
                const provKey = val.substring(0, colonIdx);
                const modelId = val.substring(colonIdx + 1);
                if (providers[provKey]) {
                    referencedProviders.add(provKey);
                }
                allReferencedModels.add(modelId);
                if (!providers[provKey]) {
                    const displaySlot = sk === 'sub' ? 'subagent' : sk;
                    issues.push({ type: 'ERROR', section: 'configs', message: "Config '" + ck + "' slot '" + displaySlot + "' references unknown provider '" + provKey + "' in '" + val + "'" });
                }
            }
            else if (val && typeof val === 'string') {
                const displaySlot = sk === 'sub' ? 'subagent' : sk;
                issues.push({ type: 'ERROR', section: 'configs', message: "Config '" + ck + "' slot '" + displaySlot + "' has invalid format: '" + val + "' (expected providerKey:modelId)" });
            }
        }
    }
    // 4. API key check
    for (const [pk, pv] of Object.entries(providers)) {
        const entry = pv;
        const keyName = entry.keyEnv || '';
        const keyValue = process.env[keyName];
        const hasFallback = Array.isArray(entry.fallback) && entry.fallback.length > 0;
        const isReferenced = referencedProviders.has(pk);
        const notSet = !keyValue || keyValue.trim() === '';
        if (notSet) {
            if (hasFallback) {
                issues.push({ type: 'WARNING', section: 'keys', message: (entry.displayName || pk) + " (" + pk + "): " + keyName + " not set, but has fallback [" + (entry.fallback || []).join(', ') + "]" });
            }
            else if (isReferenced) {
                let keyOrFallback = "Set " + keyName;
                issues.push({ type: 'ERROR', section: 'keys', message: "config '" + pk + "': provider '" + pk + "' has no fallback and no API key set. " + keyOrFallback + " or configure a fallback." });
            }
        }
    }
    // 5. Context limits check
    for (const modelId of allReferencedModels) {
        if (!(modelId in contextLimits)) {
            issues.push({ type: 'WARNING', section: 'contextLimits', message: "No context limit entry for model '" + modelId + "' (referenced in configs)" });
        }
    }
    // 6. Fallback chain validation
    for (const [pk, pv] of Object.entries(providers)) {
        const entry = pv;
        const fallbacks = entry.fallback;
        if (!Array.isArray(fallbacks) || fallbacks.length === 0)
            continue;
        for (const fb of fallbacks) {
            // Self-referencing
            if (fb === pk) {
                issues.push({ type: 'ERROR', section: 'fallbacks', message: "Provider '" + pk + "' has self-referencing fallback" });
                continue;
            }
            // Missing target
            if (!providers[fb]) {
                issues.push({ type: 'ERROR', section: 'fallbacks', message: "Provider '" + pk + "' fallback '" + fb + "' not found in providers table" });
                continue;
            }
            // Circular check: follow the fallback chain from the target
            const visited = new Set([pk, fb]);
            let current = fb;
            while (current && providers[current]) {
                const currentEntry = providers[current];
                const nextFbs = currentEntry.fallback;
                if (!Array.isArray(nextFbs) || nextFbs.length === 0)
                    break;
                const next = nextFbs[0];
                if (next === pk) {
                    issues.push({ type: 'ERROR', section: 'fallbacks', message: "Circular fallback detected: " + pk + " -> " + fb + " -> ... -> " + next });
                    break;
                }
                if (visited.has(next)) {
                    issues.push({ type: 'ERROR', section: 'fallbacks', message: "Circular fallback detected in fallback chain: " + pk + " -> " + fb + " -> ... -> " + next });
                    break;
                }
                visited.add(next);
                current = next;
            }
        }
    }
    // 7. Alias validation
    for (const [alias, target] of Object.entries(aliases)) {
        if (!(target in contextLimits)) {
            issues.push({ type: 'WARNING', section: 'aliases', message: "Alias '" + alias + "' -> '" + target + "' points to a model not found in contextLimits" });
        }
    }
    return issues;
}
// --- Formatting ---
function formatLintResults(issues, registryPath) {
    const green = '\x1b[32m';
    const yellow = '\x1b[33m';
    const red = '\x1b[31m';
    const reset = '\x1b[0m';
    const bold = '\x1b[1m';
    const lines = [];
    lines.push(bold + 'DeepClaude Config Lint' + reset);
    lines.push('======================');
    lines.push('');
    const { data: registry } = loadRegistry(registryPath);
    if (registry) {
        const providers = registry.providers || {};
        const contextLimits = registry.contextLimits || {};
        const configs = registry.configs || {};
        // Providers section
        const providerKeys = Object.keys(providers);
        lines.push(bold + 'Providers (' + providerKeys.length + ')' + reset);
        for (const [pk, pv] of Object.entries(providers)) {
            const entry = pv;
            const keyName = entry.keyEnv || '';
            const keyValue = process.env[keyName];
            const hasFallback = Array.isArray(entry.fallback) && entry.fallback.length > 0;
            let keyStatus;
            if (keyValue && keyValue.trim() !== '') {
                keyStatus = green + 'KEY=OK' + reset;
            }
            else if (hasFallback) {
                keyStatus = yellow + 'KEY=WARNING' + reset;
            }
            else {
                keyStatus = red + 'KEY=ERROR' + reset;
            }
            const fbDisplay = hasFallback ? (entry.fallback || []).join(',') : '--';
            const format = entry.wireFormat || '?';
            const name = entry.displayName || pk;
            lines.push('  ' + pk.padEnd(4) + ' ' + name.padEnd(25) + ' ' + format.padEnd(12) + ' ' + keyStatus + '  FALLBACK=' + fbDisplay);
        }
        lines.push('');
        // Context Limits section
        const limitEntries = Object.entries(contextLimits);
        lines.push(bold + 'Context Limits (' + limitEntries.length + ')' + reset);
        for (const [model, limit] of limitEntries) {
            lines.push('  ' + model.padEnd(35) + ' ' + formatContextLimit(limit));
        }
        lines.push('');
        // Configs section
        const configEntries = Object.entries(configs);
        lines.push(bold + 'Configs (' + configEntries.length + ')' + reset);
        for (const [ck, cv] of Object.entries(configs)) {
            const entry = cv;
            const slotParts = [];
            const slotMap = { opus: 'opus', sonnet: 'sonnet', haiku: 'haiku', sub: 'subagent' };
            for (const sk of ['opus', 'sonnet', 'haiku', 'sub']) {
                const val = entry[sk];
                if (val && typeof val === 'string') {
                    const displaySlot = slotMap[sk];
                    const hasIssue = issues.some(i => i.message.indexOf(ck) >= 0 && i.message.indexOf(displaySlot) >= 0);
                    const marker = hasIssue ? (red + '?' + reset) : (green + '✓' + reset);
                    slotParts.push(displaySlot + '=' + val);
                }
            }
            const name = entry.name || ck;
            lines.push('  ' + ck.padEnd(6) + ' ' + name.padEnd(30) + ' ' + slotParts.join(' | '));
        }
        lines.push('');
    }
    // Issues section
    if (issues.length > 0) {
        lines.push(bold + 'Issues' + reset);
        for (const issue of issues) {
            const color = issue.type === 'ERROR' ? red : yellow;
            lines.push('  ' + color + issue.type + reset + '  ' + issue.message);
        }
        lines.push('');
    }
    // Summary
    const errors = issues.filter(i => i.type === 'ERROR');
    const warnings = issues.filter(i => i.type === 'WARNING');
    if (errors.length === 0 && warnings.length === 0) {
        lines.push(green + 'Summary: No issues found.' + reset);
    }
    else {
        lines.push('Summary: ' + red + String(errors.length) + ' error(s)' + reset + ', ' + yellow + String(warnings.length) + ' warning(s)' + reset);
    }
    lines.push('');
    return lines.join('\n');
}
// --- CLI entry point ---
function lint(registryPath) {
    const issues = validateConfig(registryPath);
    const output = formatLintResults(issues, registryPath);
    process.stdout.write(output);
    const errors = issues.filter(i => i.type === 'ERROR');
    process.exit(errors.length > 0 ? 1 : 0);
}
