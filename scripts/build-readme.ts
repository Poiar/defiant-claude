#!/usr/bin/env npx tsx
/**
 * README builder — reads data sources and generates the dynamic sections of
 * README.md from README.template.md. Run with: npm run build:readme
 *
 * Over 20 numeric/factual claims in the README are derived from code rather
 * than hand-maintained. This script eliminates staleness by sourcing from:
 *   - proxy/providers.json (providers, configs, context limits, pricing)
 *   - proxy/*.ts (module list)
 *   - npm test output (test counts)
 *   - package.json (version)
 *   - git rev-parse (hash)
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '..');
const PROXY_DIR = path.join(ROOT, 'proxy');
const PROVIDERS_PATH = path.join(PROXY_DIR, 'providers.json');

// ──────────────────────────────────────────────
// Data loading
// ──────────────────────────────────────────────

interface ProviderDef {
  displayName?: string;
  endpoint: string;
  keyEnv: string;
  authHeader: string;
  wireFormat: string;
  setupUrl?: string;
  monthlyBudget?: number;
  fallback?: string[];
  extraHeaders?: Record<string, string>;
  streamUsageReporting?: string | null;
  noAutoFallback?: boolean;
}

interface ProvidersData {
  providers?: Record<string, ProviderDef>;
  aliases?: Record<string, string>;
  contextLimits?: Record<string, number>;
  compactionWindow?: Record<string, number>;
  configs?: Record<string, SlotConfig>;
  pricing?: Record<string, { input: number; output: number; input_cache_hit?: number; input_cache_miss?: number }>;
  thinking?: Record<string, { type: string; budget_tokens: number }>;
}

interface SlotConfig {
  name?: string;
  opus?: string;
  sonnet?: string;
  haiku?: string;
  sub?: string;
  fable?: string;
}

const providersData: ProvidersData = JSON.parse(
  fs.readFileSync(PROVIDERS_PATH, 'utf-8')
);

function getVersion(): string {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
  let hash = '';
  try { hash = execSync('git rev-parse --short HEAD', { cwd: ROOT, encoding: 'utf-8' }).trim(); } catch {}
  return hash ? `${pkg.version} (${hash})` : pkg.version;
}

function getTestStats(): { files: number; total: number } {
  const files = fs.readdirSync(path.join(PROXY_DIR, '__tests__'))
    .filter(f => f.endsWith('.test.ts')).length;

  // Use cached count when available — avoids ~4s Jest run.
  // Set DEEPCLAUDE_TEST_COUNT=<N> or DEEPCLAUDE_RUN_TESTS=1 to force live run.
  if (process.env.DEEPCLAUDE_TEST_COUNT && !process.env.DEEPCLAUDE_RUN_TESTS) {
    return { files, total: parseInt(process.env.DEEPCLAUDE_TEST_COUNT) };
  }

  try {
    const jestBin = path.join(ROOT, 'node_modules', '.bin', 'jest');
    const out = execSync(`"${jestBin}" --no-coverage --forceExit 2>&1`, {
      cwd: ROOT, encoding: 'utf-8', timeout: 30000,
      windowsHide: true,
    });
    const m = out.match(/Tests:\s+\d+ passed, (\d+) total/);
    const total = m ? parseInt(m[1]) : 0;
    return { files, total };
  } catch (e: any) {
    const out = (e.stdout || '') + (e.stderr || '');
    const m = out.match(/Tests:\s+\d+ passed, (\d+) total/);
    const total = m ? parseInt(m[1]) : 0;
    return { files, total };
  }
}

function getEnvVarsFromCode(): string[] {
  const vars = new Set<string>();
  for (const f of fs.readdirSync(PROXY_DIR).filter(f => f.endsWith('.ts'))) {
    const content = fs.readFileSync(path.join(PROXY_DIR, f), 'utf-8');
    for (const m of content.matchAll(/DEEPCLAUDE_[A-Z_]+/g)) vars.add(m[0]);
  }
  return [...vars].sort();
}

// ──────────────────────────────────────────────
// Formatters
// ──────────────────────────────────────────────

const DISPLAY_NAMES: Record<string, string> = {
  ds: 'DeepSeek (direct)', or: 'OpenRouter', fw: 'Fireworks AI', oc: 'OpenCode Zen',
  al: 'Alibaba/DashScope', km: 'Kimi/Moonshot', mm: 'Xiaomi Mimo', um: 'Umans AI',
  gr: 'Groq', mt: 'Mistral', mx: 'MiniMax', za: 'Z.ai / GLM', bp: 'BytePlus/Doubao',
  sf: 'SiliconFlow', nv: 'Novita',
};

// Short names used in the tagline for readability
const SHORT_NAMES: Record<string, string> = {
  ds: 'DeepSeek', or: 'OpenRouter', fw: 'Fireworks', oc: 'OpenCode',
  al: 'Alibaba', km: 'Kimi', mm: 'Mimo', um: 'Umans',
  gr: 'Groq', mt: 'Mistral', mx: 'MiniMax', za: 'Z.ai', bp: 'BytePlus',
  sf: 'SiliconFlow', nv: 'Novita',
};

const AUTH_LABEL: Record<string, string> = {
  'x-api-key': 'x-api-key', bearer: 'bearer',
};

function fmtTokens(n: number): string {
  if (n >= 1_048_576) return '1M';
  if (n >= 1024) return `${Math.round(n / 1024)}K`;
  return String(n);
}

// ─── Tagline ──────────────────────────────────

function genTagline(): string {
  const providerNames = Object.keys(providersData.providers || {})
    .map(k => SHORT_NAMES[k] || k)
    .sort();
  // Anthropic is a special pseudo-provider (bypasses the proxy)
  providerNames.push('Anthropic');
  return `Provider-agnostic Claude Code wrapper. Route each model slot (Opus, Sonnet, Haiku, subagent) to a different provider. Mix ${providerNames.join(', ')} in one session.`;
}

// ─── Module table ─────────────────────────────

const MODULE_DESCRIPTIONS: Record<string, string> = {
  'start-proxy.ts': 'Entry point — HTTP server, request lifecycle, health endpoint',
  'routing.ts': 'Slot-based routing with prefix matching, fallback chain construction, circuit breaker',
  'protocol-translate.ts': "Bidirectional Anthropic Messages ↔ OpenAI Chat Completions format translation (only active for OpenAI-format providers — `ds` bypasses this entirely via DeepSeek's `/anthropic` endpoint)",
  'forward.ts': 'Upstream HTTP forwarding with SSE streaming, gzip decompression, stream heartbeat/deadline timers with byte diagnostics, total-byte cap (500MB), fallback header injection, SSE buffer guarding, usage token extraction, peekFirstChunk with fast-stream race protection',
  'thinking-cache.ts': 'Anthropic-format thinking block extraction, caching, and injection for multi-turn tool conversations — keyed on sessionKey:toolUseId (no conversation fingerprint) to avoid cross-turn cache misses with DeepSeek thinking mode',
  'reasoning-cache.ts': 'OpenAI-format reasoning content cache with session-keyed LRU and re-injection — same UUID-keyed architecture as thinking-cache.ts, no conversation fingerprint (only for OpenAI-format providers; `ds` handles this natively)',
  'transport-errors.ts': 'Network failure classification via ordered signature tuples with cause chain walking',
  'error-codes.ts': 'Structured error codes with template interpolation, dev/production mode, credential scrubbing via data-driven pattern list',
  'concurrency.ts': 'Promise-queue-based semaphore with FIFO ordering and acquire/release pump pattern',
  'lru-cache.ts': 'TTL cache with LRU eviction using delete-then-set MRU promotion and lazy shared cleanup',
  'server-tools.ts': 'Anthropic server tool conversion (web_search, web_fetch, url_fetch, computer, bash, text_editor, memory, tool_search_tool), DuckDuckGo web search, SSRF-protected web fetch, tool result population',
  'config.ts': 'CLI argument parsing, JSON config loading with mtime-based hot reload, key resolution with AES-256-GCM decryption',
  'stats.ts': 'Provider health tracking, circuit breaker with 429 exclusion, auto-probe recovery with cooldown backoff, request statistics, token/spend tracking with atomic writes and restart persistence, event loop lag monitoring, provider stats reconciliation on config reload',
  'util.ts': 'Path deduplication for /v1-prefixed providers, safe header construction',
  'crypto.ts': 'AES-256-GCM encryption/decryption for provider API keys with async scrypt (N=131072) key derivation and fingerprint-based key caching',
  'encrypt-key.ts': 'CLI tool for encrypting API keys',
  'friendly-error.ts': 'Conversational error responses for exhausted fallback chains',
  'header-sanitizer.ts': 'Request header sanitization before logging (drops auth, cookies, noise)',
  'log.ts': 'Structured logger with per-module namespacing, request IDs, and env-gated debug level (`DEEPCLAUDE_DEBUG=true`)',
  'momentum.ts': 'Session-based provider stickiness (tracks last 5 provider decisions)',
  'rate-limiter.ts': 'Per-IP fixed-window rate limiter with LRU eviction',
  'ssrf.ts': 'URL validation against SSRF/DNS rebinding, blocks private/internal IPs and metadata endpoints',
  'truncate.ts': 'Log/error body length truncation with credential scrubbing',
  'startup-check.ts': 'Startup health probe — concurrent non-streaming + streaming checks per provider before accepting connections',
  'stream-metrics.ts': 'Per-stream timing (TTFB, tokens/sec) and aggregated provider metrics',
  'request-log.ts': 'Opt-in request logging to `~/.deepclaude/requests.log` (`--log-all` or `DEEPCLAUDE_LOG_ALL_REQUESTS=true`)',
  'session-key.ts': 'SHA-256 session key derivation from conversation content, shared by thinking/reasoning caches and momentum',
  'prompt-router.ts': 'Request prompt complexity classification (TRIVIAL/CHAT/CODE/TOOL/HEAVY) for cost-based routing',
  'canary.ts': 'Canary routing state machine (COLD → WARMING → ACTIVE) with configurable rollout percentages and rollback',
  'probe.ts': 'Single-provider health probe with auth failure detection and latency measurement',
  'dashboard.ts': 'Health dashboard HTML page with live SSE metrics stream',
  'config-lint.ts': '`providers.json` structural validation (used by `--lint-config`)',
  'dry-run.ts': 'Resolved routing table display without starting the proxy (used by `--dry-run`)',
  'launcher.mjs': 'Unified Node.js engine shared by deepclaude.ps1 and deepclaude.sh — config resolution, routes JSON, env vars with [1m] suffix and compaction window, slot/thinking overrides, proxy state, pricing/model/key data. Zero npm deps, single source of truth.',
};

function genModuleTable(): string {
  const files = fs.readdirSync(PROXY_DIR).filter(f => f.endsWith('.ts') || f.endsWith('.mjs')).sort();
  const lines: string[] = [];
  lines.push('| Module | Purpose |');
  lines.push('|---|---|');
  for (const f of files) {
    const desc = MODULE_DESCRIPTIONS[f] || '(undocumented)';
    lines.push(`| \`${f}\` | ${desc} |`);
  }
  return lines.join('\n');
}

// ─── providers.json schema ────────────────────

function genProvidersSchema(): string {
  const keys = Object.keys(providersData).filter(k => !k.startsWith('_'));
  const descriptions: Record<string, string> = {
    providers: 'endpoint, auth, wire format, fallbacks, setup URLs, streamUsageReporting, extraHeaders',
    aliases: 'short model aliases (e.g. "v4" → "deepseek-v4-pro")',
    contextLimits: 'per-model token windows',
    compactionWindow: 'per-model compaction thresholds (950K for DeepSeek — preserves disk cache hits)',
    thinking: 'per-model reasoning mode config (type, budget_tokens)',
    configs: 'named preset configs (slot → provider:model), monthlyBudget',
    pricing: `per-model input/output/cache token pricing ($/MTok)`,
  };
  // Build tree
  const lines: string[] = ['```', 'providers.json'];
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const prefix = i === keys.length - 1 ? '└──' : '├──';
    const desc = descriptions[k] || '';
    lines.push(`${prefix} ${k.padEnd(18)} →  ${desc}`);
  }
  lines.push('```');
  return lines.join('\n');
}

// ─── Test coverage ────────────────────────────

function genTestCoverage(): string {
  const stats = getTestStats();
  return `${stats.total} tests across ${stats.files} test files covering all proxy modules — transport errors, concurrency, LRU cache, provider registry validation, error codes, routing, stats, forwarding, server tools, config, protocol translation, thinking cache (including fingerprint-free cross-turn regression tests), reasoning cache, header sanitization, truncation, crypto, friendly errors, SSRF validation, dead stream detection, startup checks, and stream metrics. Run with \`npm test\`.`;
}

// ─── Named configs usage ──────────────────────

function genNamedConfigsUsage(): string {
  const configs = providersData.configs || {};
  const lines: string[] = [];
  // ds is the default — list it first without -b
  if (configs['ds']) {
    lines.push(`deepclaude                  # ds (default) — ${configs['ds'].name || 'DeepSeek V4 Pro'}`);
    delete (configs as any)['ds'];
  }
  for (const [key, cfg] of Object.entries(configs).sort(([, a], [, b]) =>
    (a.name || key).localeCompare(b.name || key)
  )) {
    lines.push(`deepclaude -b ${key.padEnd(15)} # ${cfg.name || key}`);
  }
  // anthropic is a special pseudo-config
  lines.push(`deepclaude -b anthropic     # Normal Claude Code`);
  return lines.join('\n');
}

// ─── Provider table ───────────────────────────

function genProviderTable(): string {
  const providers = providersData.providers || {};
  const lines: string[] = [];
  lines.push('| Key | Provider | Flag | Auth |');
  lines.push('|---|---|---|---|');
  for (const [key, def] of Object.entries(providers)) {
    lines.push(`| \`${def.keyEnv}\` | ${def.displayName || key} | \`${key}\` | ${AUTH_LABEL[def.authHeader] || def.authHeader} |`);
  }
  return lines.join('\n');
}

// ─── Named configs reference ──────────────────

function genConfigsReference(): string {
  const configs = providersData.configs || {};
  const slotLabels = ['opus', 'sonnet', 'haiku', 'sub', 'fable'] as const;
  const slotKeys = ['opus', 'sonnet', 'haiku', 'sub', 'fable'] as const;
  const lines: string[] = [];
  for (const [key, cfg] of Object.entries(configs)) {
    const cfgRec = cfg as Record<string,string>;
    const parts = slotKeys.map((s, i) => {
      const val = cfgRec[s] || (s === 'fable' ? cfgRec['opus'] : '-');
      return `${i < 4 ? s : 'fable'}=${val}`;
    });
    const allSame = parts.every(p => p.split('=')[1] === parts[0].split('=')[1]);
    lines.push(`${key.padEnd(7)} ${parts.join('  ')}${allSame ? '  (all slots same)' : ''}`);
  }
  return lines.join('\n');
}

// ─── Context limits table ─────────────────────

function genContextTable(): string {
  const limits = providersData.contextLimits || {};
  // Group models by limit for compact display
  const byLimit: Record<number, string[]> = {};
  for (const [model, limit] of Object.entries(limits)) {
    (byLimit[limit] ||= []).push(model);
  }
  const lines: string[] = [];
  lines.push('| Model | Context |');
  lines.push('|---|---|');
  for (const [limitStr, models] of Object.entries(byLimit).sort(([a], [b]) => Number(b) - Number(a))) {
    const limit = Number(limitStr);
    const label = fmtTokens(limit);
    const names = models.map(m => `\`${m}\``).join(', ');
    lines.push(`| ${names} | ${label} |`);
  }
  return lines.join('\n');
}

// ─── Fallback list ────────────────────────────

function genFallbackList(): string {
  const providers = providersData.providers || {};
  const lines: string[] = [];
  for (const [key, def] of Object.entries(providers)) {
    if (def.fallback && def.fallback.length > 0) {
      lines.push(`${key} → fallback: ${def.fallback.join(', ').padEnd(25)} # ${def.displayName || key} fails → ${def.fallback.join('/')}`);
    }
  }
  return lines.join('\n');
}

// ─── Environment variables ────────────────────

function genEnvVarTable(): string {
  const proxyEnvs = getEnvVarsFromCode();
  const desc: Record<string, string> = {
    DEEPCLAUDE_DEFAULT_BACKEND: `Default config name (falls back to \`ds\`; legacy \`CHEAPCLAUDE_DEFAULT_BACKEND\` also accepted)`,
    DEEPCLAUDE_ENCRYPTION_KEY: `Master key for AES-256-GCM API key decryption (used with \`--encrypt-key\`)`,
    DEEPCLAUDE_DAILY_BUDGET: `Daily spending cap in dollars (proxy rejects requests when exceeded)`,
    DEEPCLAUDE_DEV: `Development mode — more verbose error details in responses (\`1\` or \`true\`)`,
    DEEPCLAUDE_DEBUG: `Enable debug-level log output (\`true\`, \`1\`, or \`yes\`, case-insensitive)`,
    DEEPCLAUDE_LOG_LEVEL: `Set log level (\`debug\` for verbose output; defaults to \`info\`)`,
    DEEPCLAUDE_LOG_ALL_REQUESTS: `Log all requests to \`~/.deepclaude/requests.log\` (\`true\` to enable)`,
    DEEPCLAUDE_SKIP_STARTUP_CHECK: `Skip provider health checks on proxy startup (\`true\` to skip)`,
    DEEPCLAUDE_WATCHDOG: `Enable the proxy watchdog process (\`true\` to enable; off by default)`,
    DEEPCLAUDE_MAX_CONCURRENT: `Max concurrent upstream requests for main slots (default: \`25\`)`,
    DEEPCLAUDE_SUBAGENT_MAX_CONCURRENT: `Max concurrent upstream requests for subagent slots (default: \`8\`)`,
    DEEPCLAUDE_STREAM_HEARTBEAT_MS: `Stream silence timeout in ms before heartbeat triggers (default: \`180000\`)`,
    DEEPCLAUDE_STREAM_DEADLINE_MS: `Hard wall-clock cap on total streaming duration in ms (default: \`300000\`)`,
    DEEPCLAUDE_SUBAGENT_STREAM_HEARTBEAT_MS: `Subagent stream heartbeat timeout in ms (default: \`90000\`)`,
    DEEPCLAUDE_SUBAGENT_STREAM_DEADLINE_MS: `Hard wall-clock cap on subagent streaming duration in ms (default: \`90000\`)`,
    DEEPCLAUDE_BUDGET_WARNING: `Fraction of daily budget at which to emit warnings (default: unset)`,
    DEEPCLAUDE_DASHBOARD_KEY: `Shared secret for \`/dashboard\` and \`/health/stream\` endpoints (unset = no auth)`,
    DEEPCLAUDE_NO_PID_LOCK: `Skip PID file locking at startup (\`1\` to skip; used by integration tests)`,
  };
  const lines: string[] = [];
  lines.push('| Variable | Purpose |');
  lines.push('|---|---|');
  for (const env of proxyEnvs) {
    lines.push(`| \`${env}\` | ${desc[env] || '(undocumented)'} |`);
  }
  return lines.join('\n');
}

// ─── State files ──────────────────────────────

function genStateFiles(): string {
  const files = [
    ['`proxy.json`', 'PID, port, routes file'],
    ['`proxy.pid`', 'PID lock file (prevents dual-instance state corruption)'],
    ['`current-routes.json`', 'active routing table (reloaded on every request)'],
    ['`slot-overrides.json`', 'per-slot model overrides'],
    ['`thinking-overrides.json`', 'thinking mode overrides (--no-thinking / --thinking-budget)'],
    ['`spend.json`', 'daily and total spend tracking (atomic write via .tmp + rename)'],
    ['`subagent-model.json`', 'dedicated subagent model setting'],
    ['`fix-av.cmd`', 'standalone AV exclusion script (survives Defender quarantine of proxy files)'],
    ['`requests.log`', 'opt-in request logs (JSONL, timestamped rotation, 5 backups)'],
  ];
  return files.map(([f, d]) => `- ${f} — ${d}`).join('\n');
}

// ─── Flags ────────────────────────────────────

function genFlags(): string {
  return [
    '-h, --help      Show this help',
    '--status        Show keys, configs, and active slot mapping',
    '--doctor        System health check (prereqs, keys, proxy test)',
    '--cost          Pricing comparison',
    '--benchmark     Latency test across all configs (parallel via background jobs)',
    '--models        List all available model IDs (for /model in CC)',
    '--remote        Browser-based remote control (starts proxy automatically)',
    '--persist       Keep proxy alive after CC exits',
    '--switch CONFIG  Switch a running persistent proxy to a different config (use with --persist)',
    '--set-slot SLOT MODEL  Override a slot (opus/sonnet/haiku/subagent/fable)',
    '--subagent-model MODEL  Set a dedicated subagent model (e.g., oc:big-pickle)',
    '--stop-proxy    Kill the persistent proxy',
    '--probe [FILE]  Test each provider with a minimal prompt (latency, tokens, auth)',
    '--dry-run [FILE] Show resolved routing table without starting the proxy',
    '--what-if       Alias for --dry-run',
    '--dashboard     Print health dashboard URL (http://127.0.0.1:PORT/dashboard)',
    '--open          Open dashboard in browser (use with --dashboard)',
    '--version       Print version with git hash and proxy path',
    '--lint          Self-lint (PSScriptAnalyzer on .ps1, shellcheck on .sh)',
    '--lint-config   Validate providers.json configuration',
    '--effort LEVEL  Set Claude Code effort level (default: max). Values: low, medium, high, max.',
    '--fix-av        Print Windows Defender exclusion commands',
    '--install-statusline  Install status bar showing model, effort, context (requires restart)',
    '--logs, --tail  Tail the proxy log (~/.deepclaude/proxy.log)',
    '--health        Quick health check (one-line summary)',
    '--log-all       Log all requests to ~/.deepclaude/requests.log (by default only failures are logged)',
    '--stats         Show proxy request stats and provider health',
    '--skip-startup-check  Skip provider health checks on proxy startup',
    '--no-thinking   Disable extended thinking for all models (save cost)',
    '--thinking-budget N  Set thinking budget in tokens (e.g. 64000 for deep reasoning)',
  ].join('\n');
}

// ─── OpenAPI-format providers note ────────────

function genOpenAINote(): string {
  const providers = providersData.providers || {};
  const openaiProviders = Object.entries(providers)
    .filter(([, def]) => def.wireFormat === 'openai')
    .map(([key]) => DISPLAY_NAMES[key] || key);
  const directProviders = Object.entries(providers)
    .filter(([, def]) => def.wireFormat === 'anthropic' && def.endpoint?.includes('deepseek.com'))
    .map(([key]) => key);
  return `Providers with \`format = "openai"\` (${openaiProviders.join(', ')}) use OpenAI-compatible endpoints. The proxy automatically translates between Anthropic and OpenAI protocols — including thinking/reasoning, tool calls, streaming, and multi-turn context management. Direct DeepSeek (\`${directProviders.join(', ')}\`) uses the \`/anthropic\` endpoint and bypasses all translation.`;
}

// ──────────────────────────────────────────────
// Builder
// ──────────────────────────────────────────────

interface Section {
  name: string;
  generator: () => string;
}

const SECTIONS: Section[] = [
  { name: 'tagline', generator: genTagline },
  { name: 'modules', generator: genModuleTable },
  { name: 'providers-schema', generator: genProvidersSchema },
  { name: 'test-coverage', generator: genTestCoverage },
  { name: 'named-configs', generator: genNamedConfigsUsage },
  { name: 'providers-table', generator: genProviderTable },
  { name: 'openai-note', generator: genOpenAINote },
  { name: 'fallback-list', generator: genFallbackList },
  { name: 'configs-reference', generator: genConfigsReference },
  { name: 'context-table', generator: genContextTable },
  { name: 'flags', generator: genFlags },
  { name: 'env-vars', generator: genEnvVarTable },
  { name: 'state-files', generator: genStateFiles },
];

function build(templatePath: string, outputPath: string): void {
  let template = fs.readFileSync(templatePath, 'utf-8');

  for (const section of SECTIONS) {
    const marker = `<!-- AUTO:${section.name} -->`;
    const endMarker = `<!-- /AUTO:${section.name} -->`;

    if (!template.includes(marker)) {
      console.warn(`WARNING: marker ${marker} not found in template — skipping`);
      continue;
    }

    const startIdx = template.indexOf(marker) + marker.length;
    const endIdx = template.indexOf(endMarker);
    if (endIdx === -1) {
      console.warn(`WARNING: end marker for ${section.name} not found — skipping`);
      continue;
    }

    const generated = section.generator();
    template = template.slice(0, startIdx) + '\n' + generated + '\n' + template.slice(endIdx);
  }

  fs.writeFileSync(outputPath, template);
  console.log(`Wrote ${outputPath}`);
}

// ──────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────

const templatePath = path.join(ROOT, 'README.template.md');
const outputPath = path.join(ROOT, 'README.md');

if (!fs.existsSync(templatePath)) {
  console.error('ERROR: README.template.md not found at', templatePath);
  process.exit(1);
}

build(templatePath, outputPath);
