#!/usr/bin/env node
'use strict';

// Unified DeepClaude statusline — single source of truth for both .ps1 and .sh.
// Reads CC JSON from stdin, outputs a single statusline string.

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { get } from 'http';
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

  const deepclaudeDir = process.env.DEEPCLAUDE_DIR || join(homedir(), '.deepclaude');

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
    pct = Math.round((tokens / maxTokens) * 100);
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

  // ── Health check (fire now, await later) ───────────────────
  // Per-session proxy: port discovered from ANTHROPIC_BASE_URL env var.
  // Falls back to DEEPCLAUDE_PROXY_PORT for explicit override.
  let proxyPort = 0;
  let healthPromise = Promise.resolve(null);
  try {
    const baseUrl = process.env.ANTHROPIC_BASE_URL || '';
    const explicitPort = process.env.DEEPCLAUDE_PROXY_PORT;
    const portMatch = explicitPort || (baseUrl.match(/:(\d+)$/) || [])[1];
    if (portMatch) {
      const port = parseInt(portMatch, 10);
      if (Number.isFinite(port) && port > 0 && port <= 65535) {
        proxyPort = port;
        healthPromise = new Promise((resolve) => {
          const req = get(`http://127.0.0.1:${port}/health`, { timeout: 1000 }, (res) => {
            let data = '';
            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => {
              try {
                resolve(JSON.parse(data));
              } catch (_) {
                resolve(null);
              }
            });
          });
          req.on('error', () => resolve(null));
          req.on('timeout', () => {
            req.destroy();
            resolve(null);
          });
        });
      }
    }
  } catch (_) {}

  // ── Spend data (while health check is in-flight) ───────────
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

  // ── Await health check result ──────────────────────────────
  const health = await healthPromise;

  // ── Circuit breaker / fallback / budget indicators ─────────
  const cbIndicator = (() => {
    const parts = [];
    try {
      if (health && health.providers) {
        let worstState = 'CLOSED';
        let hasData = false;
        for (const v of Object.values(health.providers)) {
          if (v.requests > 0) hasData = true;
          if (v.circuitBreaker === 'OPEN') {
            worstState = 'OPEN';
            break;
          }
          if (v.circuitBreaker === 'HALF_OPEN' && worstState !== 'OPEN') {
            worstState = 'HALF_OPEN';
          }
        }
        if (hasData) {
          if (worstState === 'OPEN') parts.push(bold + fg(255, 80, 80) + '✕' + reset);
          else if (worstState === 'HALF_OPEN') parts.push(bold + fg(255, 180, 50) + '◐' + reset);
          // CLOSED is silent — no need for a "normal" indicator.
        }
      }
      if (health && health.lastFallback) {
        const ageMin = Math.round(
          (Date.now() - new Date(health.lastFallback.at).getTime()) / 60000,
        );
        if (ageMin < 10) {
          parts.push(bold + fg(255, 180, 50) + '↳' + health.lastFallback.to + reset);
        }
      }
      if (health && health.budgetWarning && health.budgetWarning.level !== 'info') {
        const color = health.budgetWarning.level === 'red' ? fg(255, 80, 80) : fg(255, 180, 50);
        parts.push(bold + color + '⚠ ' + health.budgetWarning.message + reset);
      }
    } catch (_) {}
    return parts.join(' ');
  })();

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
    cbIndicator,
  ]
    .filter(Boolean)
    .join(narrow);

  let ctxGroup = ctxStr ? bold + ctxColor + ctxStr + reset : '';

  // DeepSeek V4 Pro context-window milestone tags
  if (modelLookup === 'deepseek-v4-pro' && tokens) {
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
