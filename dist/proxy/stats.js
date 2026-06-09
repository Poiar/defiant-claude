'use strict';
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startTime = void 0;
exports.openCircuitBreaker = openCircuitBreaker;
exports.maybeStartProbe = maybeStartProbe;
exports.recordProbeResult = recordProbeResult;
exports.getBreakerState = getBreakerState;
exports.getBreakerEntry = getBreakerEntry;
exports.registerProviderInfo = registerProviderInfo;
exports.getProviderInfo = getProviderInfo;
exports.getRegisteredProviderKeys = getRegisteredProviderKeys;
exports.setGitHash = setGitHash;
exports.nextRequestId = nextRequestId;
exports.recordStat = recordStat;
exports.recordUsage = recordUsage;
exports.getHealthSnapshot = getHealthSnapshot;
exports.getFullHealthSnapshot = getFullHealthSnapshot;
exports.isProviderHealthy = isProviderHealthy;
exports.getCircuitBreakerState = getCircuitBreakerState;
exports.recordRecentRequest = recordRecentRequest;
exports.recordSpend = recordSpend;
exports.setSessionCap = setSessionCap;
exports.setDailyBudget = setDailyBudget;
exports.getDailySpend = getDailySpend;
exports.checkBudget = checkBudget;
exports.setSpendFilePath = setSpendFilePath;
exports._resetBudgetState = _resetBudgetState;
exports._setSessionTotal = _setSessionTotal;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const os_1 = __importDefault(require("os"));
// Provider stats tracking with non-fatal recording.
// Every stat write is wrapped so a recording failure never crashes a request.
// Circuit breaker state machine with auto-probe support.
// When a provider's failure rate exceeds the threshold, the breaker opens.
// After a cooldown, the breaker transitions to HALF_OPEN and sends a probe
// request. If the probe succeeds, the breaker closes; if it fails, the
// cooldown doubles and the cycle repeats up to MAX_PROBES attempts.
const DEFAULT_COOLDOWN_MS = 60_000;
const MAX_COOLDOWN_MS = 300_000;
const MAX_PROBES = 5;
const circuitBreakers = {};
const providersInfo = {};
function openCircuitBreaker(providerKey) {
    const existing = circuitBreakers[providerKey];
    if (existing && existing.state !== 'CLOSED')
        return;
    circuitBreakers[providerKey] = {
        state: 'OPEN',
        openedAt: Date.now(),
        cooldownMs: DEFAULT_COOLDOWN_MS,
        probeCount: 0,
        consecutiveProbeFailures: 0,
    };
}
function maybeStartProbe(providerKey) {
    const entry = circuitBreakers[providerKey];
    if (!entry || entry.state !== 'OPEN')
        return null;
    if (entry.probeCount >= MAX_PROBES)
        return null;
    if (Date.now() - entry.openedAt < entry.cooldownMs)
        return null;
    entry.state = 'HALF_OPEN';
    entry.probeCount++;
    const info = providersInfo[providerKey];
    if (!info)
        return null;
    return { url: info.url, key: info.key, isBearer: info.isBearer, format: info.format, model: info.model };
}
function recordProbeResult(providerKey, success) {
    const entry = circuitBreakers[providerKey];
    if (!entry || entry.state !== 'HALF_OPEN')
        return;
    if (success) {
        entry.state = 'CLOSED';
        entry.cooldownMs = DEFAULT_COOLDOWN_MS;
        entry.probeCount = 0;
        entry.consecutiveProbeFailures = 0;
        entry.openedAt = 0;
        delete circuitBreakers[providerKey];
    }
    else {
        entry.state = 'OPEN';
        entry.openedAt = Date.now();
        entry.cooldownMs = Math.min(entry.cooldownMs * 2, MAX_COOLDOWN_MS);
        entry.consecutiveProbeFailures++;
    }
}
function getBreakerState(providerKey) {
    const entry = circuitBreakers[providerKey];
    if (entry)
        return entry.state;
    return 'CLOSED';
}
function getBreakerEntry(providerKey) {
    return circuitBreakers[providerKey];
}
function registerProviderInfo(providerKey, info) {
    providersInfo[providerKey] = info;
}
function getProviderInfo(providerKey) {
    return providersInfo[providerKey];
}
function getRegisteredProviderKeys() {
    return Object.keys(providersInfo);
}
const providerStats = {};
exports.startTime = Date.now();
// Read version from package.json at the project root, fallback to hardcoded value.
let packageVersion = '1.0.0';
try {
    packageVersion = require('../package.json').version;
}
catch (_) { /* use fallback version */ }
// Git hash is set once at startup by start-proxy.ts. Default to 'unknown' when unavailable.
let gitHash = 'unknown';
function setGitHash(hash) { gitHash = hash; }
let requestIdCounter = 0;
function nextRequestId() {
    return ++requestIdCounter;
}
// Core stat recording -- increments counters and records timing.
// Never throws.
function recordStat(providerKey, success, ms) {
    if (!providerKey)
        return;
    try {
        if (!providerStats[providerKey]) {
            providerStats[providerKey] = { requests: 0, successes: 0, fails: 0, totalMs: 0, inputTokens: 0, outputTokens: 0 };
        }
        const s = providerStats[providerKey];
        s.requests++;
        s.totalMs += ms;
        s.lastRequest = Date.now();
        if (success)
            s.successes++;
        else
            s.fails++;
        if (!success && s.requests >= 5 && (s.fails / s.requests) >= 0.34) {
            openCircuitBreaker(providerKey);
        }
    }
    catch (_) {
        // Non-fatal -- recording should never crash the request.
    }
}
// Record token usage for a provider -- increments cumulative token counts.
// Never throws.
function recordUsage(providerKey, inputTokens, outputTokens) {
    if (!providerKey)
        return;
    try {
        if (!providerStats[providerKey]) {
            providerStats[providerKey] = { requests: 0, successes: 0, fails: 0, totalMs: 0, inputTokens: 0, outputTokens: 0 };
        }
        const s = providerStats[providerKey];
        s.inputTokens += inputTokens || 0;
        s.outputTokens += outputTokens || 0;
    }
    catch (_) {
        // Non-fatal -- recording should never crash the request.
    }
}
// Build health endpoint response -- normalized per-provider stats.
function getHealthSnapshot() {
    const healthStats = {};
    try {
        for (const [k, v] of Object.entries(providerStats)) {
            healthStats[k] = {
                requests: v.requests,
                successes: v.successes,
                fails: v.fails,
                avgMs: v.requests ? Math.round(v.totalMs / v.requests) : 0,
                inputTokens: v.inputTokens || 0,
                outputTokens: v.outputTokens || 0,
            };
        }
    }
    catch (_) {
        // Non-fatal -- return whatever we built so far.
    }
    return { status: 'ok', uptime: Date.now() - exports.startTime, providers: healthStats };
}
// Build health endpoint response with concurrency, rate limiter, version, process memory,
// circuit breaker state, spend totals, and recent requests.
function getFullHealthSnapshot(concurrencyStatus, rateLimiterStatus) {
    const base = getHealthSnapshot();
    base.version = packageVersion + ' (' + gitHash + ')';
    if (concurrencyStatus) {
        base.concurrency = concurrencyStatus;
    }
    if (rateLimiterStatus) {
        base.rateLimiter = rateLimiterStatus;
    }
    // Add circuit breaker state per provider
    const providers = base.providers;
    if (providers) {
        for (const k of Object.keys(providers)) {
            providers[k].circuitBreaker = getCircuitBreakerState(k);
            providers[k].lastRequest = providerStats[k] ? providerStats[k].lastRequest : undefined;
        }
    }
    // Spend and recent requests
    base.spend = parseFloat(sessionTotal.toFixed(4));
    base.recentRequests = recentRequests.slice().reverse();
    try {
        const mem = process.memoryUsage();
        base.memory = {
            heapUsed: Math.round((mem.heapUsed / 1024 / 1024) * 100) / 100,
            heapTotal: Math.round((mem.heapTotal / 1024 / 1024) * 100) / 100,
            rss: Math.round((mem.rss / 1024 / 1024) * 100) / 100,
            external: Math.round((mem.external / 1024 / 1024) * 100) / 100,
        };
    }
    catch (_) {
        // Non-fatal -- memory stats should never crash a health check.
    }
    return base;
}
// Check whether a provider is healthy.
// Requires at least 5 requests before judging. A provider is unhealthy
// if more than a third of its requests have failed or the circuit breaker
// is OPEN. HALF_OPEN is treated as healthy (probe traffic is the test).
function isProviderHealthy(providerKey) {
    const entry = circuitBreakers[providerKey];
    if (entry) {
        if (entry.state === 'OPEN')
            return false;
        if (entry.state === 'HALF_OPEN')
            return true;
    }
    const s = providerStats[providerKey];
    if (!s || s.requests < 5)
        return true;
    return (s.fails / s.requests) < 0.34;
}
;
// Derive circuit breaker state from recorded stats or active breaker entry.
// Returns CLOSED, OPEN, or HALF_OPEN.
function getCircuitBreakerState(providerKey) {
    const entry = circuitBreakers[providerKey];
    if (entry)
        return entry.state;
    const s = providerStats[providerKey];
    if (!s || s.requests < 5)
        return 'CLOSED';
    return (s.fails / s.requests) >= 0.34 ? 'OPEN' : 'CLOSED';
}
const MAX_RECENT_REQUESTS = 50;
const recentRequests = [];
// Append a request entry. Never throws.
function recordRecentRequest(entry) {
    try {
        recentRequests.push(entry);
        if (recentRequests.length > MAX_RECENT_REQUESTS) {
            recentRequests.shift();
        }
    }
    catch (_) {
        // Non-fatal -- recording should never crash the request.
    }
}
// --- Spend tracking ---
let spendFile = path_1.default.join(os_1.default.homedir(), '.deepclaude', 'spend.json');
let lastSpendWrite = 0;
const SPEND_WRITE_THROTTLE_MS = 1000;
let runningTotal = 0;
let sessionTotal = 0;
let dailyAccumulator = 0;
let sessionCap = 0;
let sessionDailyBudget = 0;
let lastDailyRead = 0;
let cachedDailySpend = 0;
const BUDGET_CHECK_THROTTLE_MS = 1000;
const sessionStarted = new Date().toISOString();
let pricingData = {};
try {
    pricingData = require('./providers.json').pricing || {};
}
catch (_) { /* continue without pricing */ }
function lookupPrice(modelName) {
    if (pricingData[modelName])
        return pricingData[modelName];
    const stripped = modelName.replace(/^[a-z][a-z0-9_-]*:/, '');
    if (stripped !== modelName && pricingData[stripped])
        return pricingData[stripped];
    return null;
}
async function recordSpend(modelName, usage) {
    const price = lookupPrice(modelName);
    if (!price)
        return;
    const cost = (usage.prompt_tokens / 1_000_000) * price.input + (usage.completion_tokens / 1_000_000) * price.output;
    runningTotal += cost;
    sessionTotal += cost;
    dailyAccumulator += cost;
    const now = Date.now();
    if (now - lastSpendWrite < SPEND_WRITE_THROTTLE_MS)
        return;
    lastSpendWrite = now;
    try {
        const spendDir = path_1.default.dirname(spendFile);
        if (!fs_1.default.existsSync(spendDir)) {
            fs_1.default.mkdirSync(spendDir, { recursive: true });
        }
        const existing = {};
        if (fs_1.default.existsSync(spendFile)) {
            try {
                const raw = fs_1.default.readFileSync(spendFile, 'utf-8');
                const parsed = JSON.parse(raw);
                if (parsed.total !== undefined)
                    existing.total = parsed.total;
                if (parsed.sessions)
                    existing.sessions = parsed.sessions;
                if (parsed.current_model)
                    existing.current_model = parsed.current_model;
                if (parsed.daily)
                    existing.daily = parsed.daily;
            }
            catch (_) { /* ignore corrupt file */ }
        }
        const today = new Date().toISOString().slice(0, 10);
        const daily = existing.daily || {};
        daily[today] = (daily[today] || 0) + dailyAccumulator;
        dailyAccumulator = 0;
        const data = {
            total: parseFloat(runningTotal.toFixed(4)),
            daily,
            sessions: [{ started: sessionStarted, total: parseFloat(sessionTotal.toFixed(4)) }],
            current_model: modelName,
        };
        fs_1.default.writeFileSync(spendFile, JSON.stringify(data) + '\n');
    }
    catch (_) { /* non-fatal */ }
}
// --- Spend budget caps ---
function setSessionCap(dollars) {
    sessionCap = dollars;
}
function setDailyBudget(dollars) {
    sessionDailyBudget = dollars;
}
function getDailySpend() {
    const now = Date.now();
    if (now - lastDailyRead < BUDGET_CHECK_THROTTLE_MS) {
        return cachedDailySpend;
    }
    lastDailyRead = now;
    try {
        if (!fs_1.default.existsSync(spendFile)) {
            cachedDailySpend = 0;
            return 0;
        }
        const raw = fs_1.default.readFileSync(spendFile, 'utf-8');
        const data = JSON.parse(raw);
        const today = new Date().toISOString().slice(0, 10);
        const daily = data.daily;
        cachedDailySpend = (daily?.[today] ?? 0) + dailyAccumulator;
        return cachedDailySpend;
    }
    catch (_) {
        cachedDailySpend = 0;
        return 0;
    }
}
function checkBudget() {
    if (sessionCap > 0 && sessionTotal >= sessionCap) {
        return 'Session cap of $' + sessionCap.toFixed(2) + ' exceeded ($' + sessionTotal.toFixed(2) + ' spent this session)';
    }
    if (sessionDailyBudget > 0) {
        const dailySpend = getDailySpend();
        if (dailySpend >= sessionDailyBudget) {
            return 'Daily budget of $' + sessionDailyBudget.toFixed(2) + ' exceeded ($' + dailySpend.toFixed(2) + ' spent today)';
        }
    }
    return null;
}
// Testing support
function setSpendFilePath(p) {
    spendFile = p;
}
function _resetBudgetState() {
    sessionCap = 0;
    sessionDailyBudget = 0;
    sessionTotal = 0;
    runningTotal = 0;
    dailyAccumulator = 0;
    lastDailyRead = 0;
    cachedDailySpend = 0;
}
function _setSessionTotal(val) {
    sessionTotal = val;
}
