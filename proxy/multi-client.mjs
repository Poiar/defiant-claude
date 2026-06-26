#!/usr/bin/env node
'use strict';

/**
 * Multi-client support for Defiant Claude.
 *
 * Configures third-party clients to route through the proxy:
 * - VS Code extension (claude-code.apiUrl)
 * - Claude Desktop (claude_desktop_config.json)
 * - JetBrains ACP (IDE config)
 * - Codex CLI (OpenAI-compatible endpoint)
 * - Generic Anthropic SDK (env vars)
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// --- Config dir ---
function getConfigDir() {
  return process.env.DEFIANT_DIR || join(homedir(), '.defiant');
}

// ============================================================================
// VS Code Extension
// ============================================================================

export function configureVSCode(port) {
  const written = [];
  const apiUrl = `http://127.0.0.1:${port}`;

  // Try workspace settings first
  const cwd = process.cwd();
  const vscodeDir = join(cwd, '.vscode');
  const settingsPath = join(vscodeDir, 'settings.json');

  try {
    let settings = {};
    if (existsSync(settingsPath)) {
      try {
        settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      } catch {}
    }

    if (settings['claude-code.apiUrl'] !== apiUrl) {
      mkdirSync(vscodeDir, { recursive: true });
      settings['claude-code.apiUrl'] = apiUrl;
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
      written.push(settingsPath);
    }
  } catch (e) {
    // Non-fatal — workspace may not exist
  }

  // Try global VS Code settings
  const globalPaths = [
    join(homedir(), '.config', 'Code', 'User', 'settings.json'),
    join(homedir(), 'Library', 'Application Support', 'Code', 'User', 'settings.json'),
    join(process.env.APPDATA || '', 'Code', 'User', 'settings.json'),
    join(homedir(), '.vscode-server', 'data', 'Machine', 'settings.json'),
  ];

  for (const gp of globalPaths) {
    try {
      if (!existsSync(join(gp, '..'))) continue;
      let settings = {};
      if (existsSync(gp)) {
        try {
          settings = JSON.parse(readFileSync(gp, 'utf-8'));
        } catch {}
      }
      if (settings['claude-code.apiUrl'] !== apiUrl) {
        settings['claude-code.apiUrl'] = apiUrl;
        writeFileSync(gp, JSON.stringify(settings, null, 2), 'utf-8');
        written.push(gp);
      }
    } catch {}
  }

  return { ok: written.length > 0, files: written };
}

// ============================================================================
// Claude Desktop
// ============================================================================

export function configureClaudeDesktop(port) {
  const apiUrl = `http://127.0.0.1:${port}`;

  const configDirs = [
    join(homedir(), 'Library', 'Application Support', 'Claude'),
    join(process.env.APPDATA || '', 'Claude'),
    join(homedir(), '.config', 'Claude'),
  ];

  for (const configDir of configDirs) {
    try {
      if (!existsSync(configDir)) continue;
      const configPath = join(configDir, 'claude_desktop_config.json');
      let config = {};
      if (existsSync(configPath)) {
        try {
          config = JSON.parse(readFileSync(configPath, 'utf-8'));
        } catch {}
      }
      config.apiUrl = apiUrl;
      writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
      return { ok: true, path: configPath };
    } catch {}
  }

  return { ok: false, path: null };
}

// ============================================================================
// JetBrains ACP
// ============================================================================

export function configureJetBrains(port) {
  const apiUrl = `http://127.0.0.1:${port}`;
  const ides = [
    'IdeaIC',
    'IntelliJIdea',
    'WebStorm',
    'PyCharm',
    'GoLand',
    'CLion',
    'Rider',
    'DataGrip',
    'RubyMine',
    'PhpStorm',
  ];

  const configDirs = [
    join(homedir(), 'Library', 'Application Support', 'JetBrains'),
    join(process.env.APPDATA || '', 'JetBrains'),
    join(homedir(), '.config', 'JetBrains'),
  ];

  for (const baseDir of configDirs) {
    try {
      if (!existsSync(baseDir)) continue;
      const entries = readdirSync(baseDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (!ides.some((id) => entry.name.includes(id))) continue;
        const optionsDir = join(baseDir, entry.name, 'options');
        if (!existsSync(optionsDir)) continue;
        const configPath = join(optionsDir, 'anthropic.xml');
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<application>
  <component name="AnthropicCodePilotSettings">
    <option name="apiUrl" value="${apiUrl}" />
  </component>
</application>`;
        writeFileSync(configPath, xml, 'utf-8');
        return { ok: true, path: configPath };
      }
    } catch {}
  }

  // Fallback
  const fallbackDir = join(getConfigDir(), 'jetbrains');
  try {
    mkdirSync(fallbackDir, { recursive: true });
    const configPath = join(fallbackDir, 'anthropic.xml');
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<application>
  <component name="AnthropicCodePilotSettings">
    <option name="apiUrl" value="${apiUrl}" />
  </component>
</application>`;
    writeFileSync(configPath, xml, 'utf-8');
    return { ok: true, path: configPath + ' (fallback)' };
  } catch {
    return { ok: false, path: null };
  }
}

// ============================================================================
// Codex CLI env vars
// ============================================================================

export function codexEnvVars(port) {
  return {
    OPENAI_API_KEY: `defiant-${port}`,
    OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`,
  };
}

// ============================================================================
// Generic Anthropic SDK instructions
// ============================================================================

export function sdkInstructions(port) {
  return {
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    ANTHROPIC_AUTH_KEY: `defiant-${port}`,
  };
}

// ============================================================================
// Runner
// ============================================================================

export function configureClients(port, flags) {
  let count = 0;

  if (flags.vscode) {
    const r = configureVSCode(port);
    if (r.ok) {
      console.log(`  VS Code: claude-code.apiUrl set (${r.files.join(', ')})`);
      count++;
    } else {
      console.log('  VS Code: no settings file found — set manually');
    }
  }

  if (flags.desktop) {
    const r = configureClaudeDesktop(port);
    if (r.ok) {
      console.log(`  Claude Desktop: apiUrl set (${r.path})`);
      console.log('  Restart Claude Desktop to apply.');
      count++;
    } else {
      console.log('  Claude Desktop: install not found');
    }
  }

  if (flags.jetbrains) {
    const r = configureJetBrains(port);
    if (r.ok) {
      console.log(`  JetBrains ACP: apiUrl set (${r.path})`);
      console.log('  Restart JetBrains IDE to apply.');
      count++;
    } else {
      console.log('  JetBrains ACP: install not found');
    }
  }

  if (flags.codex) {
    const env = codexEnvVars(port);
    console.log(`  Codex CLI: OPENAI_BASE_URL=${env.OPENAI_BASE_URL}`);
    console.log('  Note: Codex uses OpenAI format. Use an OpenAI-format provider.');
    count++;
  }

  if (flags.sdk) {
    const env = sdkInstructions(port);
    console.log(`  Anthropic SDK: ANTHROPIC_BASE_URL=${env.ANTHROPIC_BASE_URL}`);
    count++;
  }

  return count;
}

// ─── CLI entry point ─────────────────────────────────────────
// Run directly: node proxy/multi-client.mjs --vscode --port=1234
const args = process.argv.slice(2);
if (args.length > 0) {
  const flags = {};
  let port = 0;
  for (const a of args) {
    if (a.startsWith('--port=')) port = parseInt(a.split('=')[1], 10);
    else if (a.startsWith('--')) flags[a.replace(/^-+/, '').replace(/-/g, '').split('=')[0]] = true;
  }
  if (port && Object.keys(flags).length > 0) {
    configureClients(port, flags);
  }
}
