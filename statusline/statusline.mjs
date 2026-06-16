#!/usr/bin/env node
'use strict';

// Unified DeepClaude statusline — single source of truth for both .ps1 and .sh.
// Reads CC JSON from stdin, outputs a single statusline string.

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';

// Read all of stdin — works cross-platform (Windows lacks readFileSync(0)).
async function readStdin() {
  if (process.stdin.isTTY) return '';
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

async function main() {
  // ── Read CC JSON from stdin ──────────────────────────────────
  let raw;
  try {
    raw = await readStdin();
  } catch (_) {
    return;
  }
  if (!raw) return;
  let d;
  try {
    d = JSON.parse(raw);
  } catch (_) {
    return;
  }

  // ── Helpers ─────────────────────────────────────────────────
  const fg = (r, g, b) => `\x1b[38;2;${r};${g};${b}m`;
  const reset = '\x1b[0m';
  const bold = '\x1b[1m';
  const narrow = '  ';

  // ── Location ─────────────────────────────────────────────────
  const cwd = d?.workspace?.current_dir || d?.cwd || '';
  const sep = cwd.includes('\\') ? '\\' : '/';
  const dirName = cwd.split(sep).filter(Boolean).pop() || '';

  let branch = process.env.GIT_BRANCH || '';
  if (!branch && cwd) {
    try {
      branch = execSync(`git -C "${cwd}" --no-optional-locks rev-parse --abbrev-ref HEAD`, {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
        timeout: 2000,
      }).trim();
    } catch (_) {}
  }

  const deepclaudeDir =
    process.env.DEEPCLAUDE_CONFIG_DIR ||
    process.env.DEEPCLAUDE_DIR ||
    join(homedir(), '.deepclaude');

  // ── Model & slot overrides ──────────────────────────────────
  let model = d?.model?.id || d?.model?.display_name || '';
  const effort = d?.effort?.level || '';
  let slotLabel = '';

  try {
    const overridesPath = join(deepclaudeDir, 'slot-overrides.json');
    if (existsSync(overridesPath)) {
      const overrides = JSON.parse(readFileSync(overridesPath, 'utf8'));
      const slotMatch = model && model.match(/^(sonnet|opus|haiku|sub|subagent|fable):(.+)$/);
      if (slotMatch) {
        const slot = slotMatch[1];
        const fallback = slotMatch[2];
        const abbr = {
          opus: 'o',
          sonnet: 's',
          haiku: 'h',
          sub: 'sub',
          subagent: 'sub',
          fable: 'f',
        };
        slotLabel = (abbr[slot] || slot) + ' ';
        model = overrides[slot] || fallback;
        if (!overrides[slot] && (slot === 'sub' || slot === 'subagent')) {
          try {
            const subFile = join(deepclaudeDir, 'subagent-model.json');
            if (existsSync(subFile)) {
              const sub = JSON.parse(readFileSync(subFile, 'utf8'));
              if (sub.providerKey && sub.modelId) {
                model = sub.providerKey + ':' + sub.modelId;
              }
            }
          } catch (_) {}
        }
      }
    }
  } catch (_) {}

  const modelKey = model.replace(/^[a-f0-9]{6,}:/, '');
  const modelLookup = modelKey.replace(/^[a-z][a-z0-9_-]*:/, '').replace(/\[\d+[km]\]$/i, '');

  // ── Context window ──────────────────────────────────────────
  const tokens = d?.context_window?.total_input_tokens;
  let ctxMap = {};
  try {
    const routesPath = join(deepclaudeDir, 'current-routes.json');
    if (existsSync(routesPath)) {
      const routes = JSON.parse(readFileSync(routesPath, 'utf8'));
      if (routes.contextLimits) ctxMap = routes.contextLimits;
    }
  } catch (_) {}

  const maxTokens = d?.context_window?.max_input_tokens || ctxMap[modelLookup];
  const tokStr =
    tokens != null ? (tokens >= 1000 ? Math.round(tokens / 1000) + 'k' : String(tokens)) : '';
  let pct = null;
  if (tokens != null && maxTokens != null && maxTokens > 0) {
    const rawPct = Math.round((tokens / maxTokens) * 100);
    // Only show percentage when it makes sense: maxTokens must be at least
    // as large as the token count, and the result must be ≤100%.
    // When a subagent or fallback model has a smaller context than the
    // accumulated conversation, CC may report a max_input_tokens that is
    // smaller than total_input_tokens — producing nonsense >100% values.
    if (rawPct <= 100) pct = rawPct;
  }
  const ctxStr = tokStr + (tokStr && pct != null ? '/' + pct + '%' : pct != null ? pct + '%' : '');

  // ── Colors ──────────────────────────────────────────────────
  const effortColor =
    effort === 'high' || effort === 'max'
      ? fg(255, 80, 80)
      : effort === 'medium'
        ? fg(255, 180, 50)
        : fg(100, 160, 255);
  const ctxColor =
    pct != null && pct >= 80
      ? fg(255, 80, 80)
      : pct != null && pct >= 50
        ? fg(255, 180, 50)
        : fg(80, 200, 120);

  // ── Proxy port discovery ────────────────────────────────────
  let proxyPort = 0;
  try {
    // Disk port: updated on every hot-swap, most current.
    const deepclaudeDir =
      process.env.DEEPCLAUDE_CONFIG_DIR ||
      process.env.DEEPCLAUDE_DIR ||
      join(homedir() || '.', '.deepclaude');
    const portFile = join(deepclaudeDir, 'proxy.port');
    let diskPort = 0;
    if (existsSync(portFile)) {
      const raw = readFileSync(portFile, 'utf-8').trim();
      const p = parseInt(raw, 10);
      if (Number.isFinite(p) && p > 0 && p <= 65535) diskPort = p;
    }
    // Env var port (set at CC launch, stale after hot-swap)
    const baseUrl = process.env.ANTHROPIC_BASE_URL || '';
    const explicitPort = process.env.DEEPCLAUDE_PROXY_PORT;
    const envPortStr = explicitPort || (baseUrl.match(/:(\d+)$/) || [])[1];
    let envPort = 0;
    if (envPortStr) {
      const p = parseInt(envPortStr, 10);
      if (Number.isFinite(p) && p > 0 && p <= 65535) envPort = p;
    }
    // Disk wins if it exists (updated by hot-swap).
    // Env var as fallback for first launch before proxy writes port file.
    proxyPort = diskPort || envPort;
  } catch (_) {}

  // ── Spend data ──────────────────────────────────────────────
  let spendGroup = '';
  try {
    const spendPath = join(deepclaudeDir, 'spend.json');
    if (existsSync(spendPath)) {
      const spendData = JSON.parse(readFileSync(spendPath, 'utf8'));

      const ccSessId = process.env.CLAUDE_CODE_SESSION_ID;
      if (ccSessId) {
        try {
          writeFileSync(
            join(deepclaudeDir, 'cc-active.json'),
            JSON.stringify({ sessionId: ccSessId, timestamp: Date.now() }),
          );
        } catch (_) {}
      }

      let sessionSpend = 0;
      if (ccSessId) {
        const ccSpendPath = join(deepclaudeDir, `cc-spend-${ccSessId}.json`);
        try {
          if (existsSync(ccSpendPath)) {
            sessionSpend = parseFloat(readFileSync(ccSpendPath, 'utf8').trim()) || 0;
          }
          // The cc-spend file is created on the first spend flush, which
          // happens before the statusline renders (CC needs an API round-
          // trip to populate context-window info, and the proxy flushes
          // spend synchronously as part of that response). So by the time
          // you see the statusline, real money has already been spent.
        } catch (_) {
          /* stay 0 */
        }
      }

      // ISO YYYY-MM-DD from local date (matches stats.ts todayISO()).
      const d = new Date();
      const todayKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const todaySpend =
        spendData.daily && spendData.daily[todayKey] && spendData.daily[todayKey].total
          ? spendData.daily[todayKey].total
          : 0;

      // Session spend (yellow, left) — per-session, resets on new CC window.
      // Today's spend (grey, right) — resets at midnight local time.
      // Show session spend at $0.00 for active sessions so the user sees tracking is live.
      const parts = [];
      if (ccSessId) {
        parts.push(bold + fg(255, 210, 80) + '$' + Number(sessionSpend).toFixed(2) + reset);
      }
      if (todaySpend > 0) {
        parts.push(fg(120, 120, 120) + '$' + Number(todaySpend).toFixed(2) + reset);
      }
      if (parts.length > 0) spendGroup = parts.join(' ');
    }
  } catch (_) {}

  // Port display — always show when known, independent of spend data
  if (proxyPort > 0 && !spendGroup) {
    spendGroup = fg(90, 90, 90) + proxyPort + reset;
  } else if (proxyPort > 0) {
    spendGroup = spendGroup + ' ' + fg(90, 90, 90) + proxyPort + reset;
  }

  // ── Assemble groups ────────────────────────────────────────
  const locationGroup = [
    dirName ? bold + fg(100, 180, 255) + dirName + reset : '',
    branch ? bold + fg(255, 80, 180) + branch + reset : '',
  ]
    .filter(Boolean)
    .join(narrow);

  const displayModel = /^[a-f0-9]{6,}$/.test(modelKey) ? '' : modelKey;
  const modelGroup = [
    slotLabel || model ? bold + fg(200, 100, 255) + slotLabel + displayModel + reset : '',
    effort ? bold + effortColor + effort + reset : '',
  ]
    .filter(Boolean)
    .join(narrow);

  let ctxGroup = ctxStr ? bold + ctxColor + ctxStr + reset : '';

  // DeepSeek V4 / large-context model milestone tags.
  // SR (Serious Reduction): 300K+ tokens — user is burning cache headroom.
  // FBR (Full Backup Required): 400K+ tokens — compaction is imminent, prefix
  //   rewrite will destroy disk cache (DeepSeek) / ephemeral cache (Anthropic).
  // Any model with ≥1M context window gets these tags.
  if (tokens && ctxMap[modelLookup] && ctxMap[modelLookup] >= 1_000_000) {
    if (tokens >= 400000) {
      ctxGroup += ' ' + bold + fg(255, 80, 80) + 'FBR' + reset;
    } else if (tokens >= 300000) {
      ctxGroup += ' ' + bold + fg(255, 180, 50) + 'SR' + reset;
    }
  }

  // ── Output ──────────────────────────────────────────────────
  let output = [locationGroup, modelGroup, ctxGroup, spendGroup]
    .map((g) =>
      g
        .replace(/\b[a-f0-9]{6,}\b/g, '')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter(Boolean)
    .join(' ');
  // CC renders 2+ consecutive spaces as · — normalize to single spaces.
  output = output.replace(/\s+/g, ' ').trim();
  console.log(output);
}

main().catch(() => {});
