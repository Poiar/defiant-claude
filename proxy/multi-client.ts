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

import fs from 'fs';
import path from 'path';
import { homedir } from 'os';
import { createLogger } from './log';

const log = createLogger('multi-client');

// --- Config dir ---
function getConfigDir(): string {
  return process.env.DEFIANT_DIR || path.join(homedir(), '.defiant');
}

// ============================================================================
// VS Code Extension
// ============================================================================

/**
 * Write VS Code settings to point claude-code at the proxy.
 * Supports both workspace (.vscode/settings.json) and global settings.
 *
 * VS Code's Claude Code extension uses ANTHROPIC_BASE_URL from the
 * integrated terminal's environment, OR the claude-code.apiUrl setting.
 * Writing the setting is more reliable since it persists across terminals.
 */
export function configureVSCode(port: number): { ok: boolean; files: string[] } {
  const written: string[] = [];
  const apiUrl = `http://127.0.0.1:${port}`;

  // Try workspace settings first
  const cwd = process.cwd();
  const vscodeDir = path.join(cwd, '.vscode');
  const settingsPath = path.join(vscodeDir, 'settings.json');

  try {
    let settings: Record<string, unknown> = {};
    if (fs.existsSync(settingsPath)) {
      const raw = fs.readFileSync(settingsPath, 'utf-8');
      try {
        settings = JSON.parse(raw);
      } catch {}
    }

    if (settings['claude-code.apiUrl'] !== apiUrl) {
      fs.mkdirSync(vscodeDir, { recursive: true });
      settings['claude-code.apiUrl'] = apiUrl;
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
      written.push(settingsPath);
    }
  } catch (e) {
    log.warn(null, 'Failed to write VS Code workspace settings: ' + (e as Error).message);
  }

  // Also try global VS Code settings (more universal)
  const globalSettingsPaths = [
    path.join(homedir(), '.config', 'Code', 'User', 'settings.json'), // Linux
    path.join(homedir(), 'Library', 'Application Support', 'Code', 'User', 'settings.json'), // macOS
    path.join(process.env.APPDATA || '', 'Code', 'User', 'settings.json'), // Windows
    path.join(homedir(), '.vscode-server', 'data', 'Machine', 'settings.json'), // Remote SSH
  ];

  for (const gp of globalSettingsPaths) {
    try {
      const dir = path.dirname(gp);
      if (!fs.existsSync(dir)) continue;

      let settings: Record<string, unknown> = {};
      if (fs.existsSync(gp)) {
        const raw = fs.readFileSync(gp, 'utf-8');
        try {
          settings = JSON.parse(raw);
        } catch {}
      }

      if (settings['claude-code.apiUrl'] !== apiUrl) {
        settings['claude-code.apiUrl'] = apiUrl;
        fs.writeFileSync(gp, JSON.stringify(settings, null, 2), 'utf-8');
        written.push(gp);
      }
    } catch {}
  }

  return { ok: written.length > 0, files: written };
}

// ============================================================================
// Claude Desktop
// ============================================================================

/**
 * Write Claude Desktop config to point at the proxy.
 *
 * Claude Desktop reads its API configuration from:
 *   macOS: ~/Library/Application Support/Claude/claude_desktop_config.json
 *   Windows: %APPDATA%/Claude/claude_desktop_config.json
 *   Linux: ~/.config/Claude/claude_desktop_config.json
 *
 * The config file has an apiUrl field that overrides the default
 * https://api.anthropic.com endpoint.
 */
export function configureClaudeDesktop(port: number): { ok: boolean; path: string | null } {
  const apiUrl = `http://127.0.0.1:${port}`;

  const configDirs = [
    path.join(homedir(), 'Library', 'Application Support', 'Claude'), // macOS
    path.join(process.env.APPDATA || '', 'Claude'), // Windows
    path.join(homedir(), '.config', 'Claude'), // Linux
  ];

  for (const configDir of configDirs) {
    try {
      if (!fs.existsSync(configDir)) continue;

      const configPath = path.join(configDir, 'claude_desktop_config.json');
      let config: Record<string, unknown> = {};
      if (fs.existsSync(configPath)) {
        const raw = fs.readFileSync(configPath, 'utf-8');
        try {
          config = JSON.parse(raw);
        } catch {}
      }

      config.apiUrl = apiUrl;
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
      return { ok: true, path: configPath };
    } catch (e) {
      log.warn(null, 'Failed to write Claude Desktop config: ' + (e as Error).message);
    }
  }

  return { ok: false, path: null };
}

// ============================================================================
// JetBrains ACP (Anthropic Code Pilot)
// ============================================================================

/**
 * Write JetBrains ACP config to point at the proxy.
 *
 * JetBrains ACP stores its configuration in:
 *   ~/.config/JeBrains/options/anthropic.xml (Linux)
 *   ~/Library/Application Support/JetBrains/options/anthropic.xml (macOS)
 *   %APPDATA%/JetBrains/options/anthropic.xml (Windows)
 *
 * The file is an XML properties file.
 */
export function configureJetBrains(port: number): { ok: boolean; path: string | null } {
  const apiUrl = `http://127.0.0.1:${port}`;

  // JetBrains config directories (varies by IDE and version)
  const configDirs = [
    path.join(homedir(), 'Library', 'Application Support', 'JetBrains'), // macOS
    path.join(process.env.APPDATA || '', 'JetBrains'), // Windows
    path.join(homedir(), '.config', 'JetBrains'), // Linux
  ];

  // Common IDE subdirectories to check
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

  for (const baseDir of configDirs) {
    try {
      if (!fs.existsSync(baseDir)) continue;

      // Find the most recent IDE version directory
      const entries = fs.readdirSync(baseDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const ideMatch = ides.find((id) => entry.name.includes(id));
        if (!ideMatch) continue;

        const optionsDir = path.join(baseDir, entry.name, 'options');
        if (!fs.existsSync(optionsDir)) continue;

        const configPath = path.join(optionsDir, 'anthropic.xml');

        // Write the ACP config as XML properties
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<application>
  <component name="AnthropicCodePilotSettings">
    <option name="apiUrl" value="${apiUrl}" />
  </component>
</application>`;
        fs.writeFileSync(configPath, xml, 'utf-8');
        return { ok: true, path: configPath };
      }
    } catch (e) {
      log.warn(null, 'Failed to write JetBrains config: ' + (e as Error).message);
    }
  }

  // Fallback: write to a well-known default location
  const fallbackDir = path.join(getConfigDir(), 'jetbrains');
  try {
    fs.mkdirSync(fallbackDir, { recursive: true });
    const configPath = path.join(fallbackDir, 'anthropic.xml');
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<application>
  <component name="AnthropicCodePilotSettings">
    <option name="apiUrl" value="${apiUrl}" />
  </component>
</application>`;
    fs.writeFileSync(configPath, xml, 'utf-8');
    return { ok: true, path: configPath + ' (fallback — copy to JetBrains options/)' };
  } catch {
    return { ok: false, path: null };
  }
}

// ============================================================================
// Codex CLI (OpenAI Responses API support in proxy)
// ============================================================================

/**
 * Generate the env vars needed for Codex CLI.
 *
 * Codex CLI uses:
 *   OPENAI_BASE_URL=http://127.0.0.1:<port>/v1
 *   OPENAI_API_KEY=defiant-<port>
 *
 * The proxy must accept /v1/responses endpoint and translate OpenAI
 * Responses format to internal Anthropic format.
 */
export function codexEnvVars(port: number): Record<string, string> {
  return {
    OPENAI_API_KEY: `defiant-${port}`,
    OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`,
  };
}

/**
 * Print instructions for running Codex CLI with the proxy.
 */
export function printCodexInstructions(port: number): void {
  const env = codexEnvVars(port);
  console.log(`
  Codex CLI: Set these env vars:
    OPENAI_API_KEY=${env.OPENAI_API_KEY}
    OPENAI_BASE_URL=${env.OPENAI_BASE_URL}
  `);
}

// ============================================================================
// Generic Anthropic SDK
// ============================================================================

/**
 * Print instructions for using the proxy with any Anthropic SDK client.
 */
export function printSdkInstructions(port: number): void {
  console.log(`
  Any Anthropic SDK client can use the proxy:
    ANTHROPIC_BASE_URL=http://127.0.0.1:${port}
    ANTHROPIC_AUTH_KEY=defiant-${port}
  `);
}

// ============================================================================
// Runner — called from CLI
// ============================================================================

/**
 * Configure all requested clients and print instructions.
 * Returns the number of successfully configured clients.
 */
export function configureClients(port: number, flags: Record<string, boolean>): number {
  let count = 0;

  if (flags.vscode) {
    const result = configureVSCode(port);
    if (result.ok) {
      console.log(`  VS Code: configured (${result.files.join(', ')})`);
      count++;
    } else {
      console.log('  VS Code: no settings file found — set manually: claude-code.apiUrl');
    }
  }

  if (flags.desktop) {
    const result = configureClaudeDesktop(port);
    if (result.ok) {
      console.log(`  Claude Desktop: configured (${result.path})`);
      console.log('  Restart Claude Desktop for changes to take effect.');
      count++;
    } else {
      console.log('  Claude Desktop: config directory not found');
    }
  }

  if (flags.jetbrains) {
    const result = configureJetBrains(port);
    if (result.ok) {
      console.log(`  JetBrains ACP: configured (${result.path})`);
      console.log('  Restart your JetBrains IDE for changes to take effect.');
      count++;
    } else {
      console.log('  JetBrains ACP: config directory not found');
    }
  }

  if (flags.codex) {
    const env = codexEnvVars(port);
    console.log(`  Codex CLI: OPENAI_BASE_URL=${env.OPENAI_BASE_URL}`);
    count++;
  }

  return count;
}
