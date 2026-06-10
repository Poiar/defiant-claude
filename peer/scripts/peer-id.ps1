# Resolve or set peer identity. Outputs JSON: {uuid, name, msgN, port, tabId}
#
# Session UUID comes from CLAUDE_CODE_SESSION_ID (set by Claude Code).
# Per-session cache in ~/.claude/peer-id-<UUID first 8>.txt.
#
# Usage:
#   peer-id.ps1                        → auto-identify
#   peer-id.ps1 -TabId <tab-uuid>      → register tab UUID for direct messaging
#   peer-id.ps1 -Reset                 → force re-identify
param([string]$TabId, [switch]$Reset)

$ErrorActionPreference = 'Stop'

# ── Resolve session UUID ──────────────────────────────────────────────
$sessionId = $env:CLAUDE_CODE_SESSION_ID
if (-not $sessionId) {
  Write-Output '{"uuid":"unknown","name":"unknown","msgN":0,"port":""}'
  exit 0
}
$uuid8 = $sessionId.Substring(0, 8)

# ── Resolve proxy port ────────────────────────────────────────────────
$port = ""
try {
  $pidRaw = Get-Content "$env:USERPROFILE\.deepclaude\proxy.pid" -Raw -ErrorAction Stop
  $colonIdx = $pidRaw.IndexOf(':')
  if ($colonIdx -ge 0) { $port = $pidRaw.Substring($colonIdx + 1).Trim() }
} catch { $port = "" }

# ── Cache file (per-session, not per-port) ────────────────────────────
$cache = "$env:USERPROFILE\.claude\peer-id-$uuid8.txt"

# ── Migrate from old per-port format if it exists ─────────────────────
$oldCache = if ($port) { "$env:USERPROFILE\.claude\peer-id-$port.txt" } else { $null }
if ((-not (Test-Path $cache)) -and $oldCache -and (Test-Path $oldCache)) {
  try { Copy-Item $oldCache $cache -ErrorAction Stop } catch {}
}

# ── Read existing cache ───────────────────────────────────────────────
$existing = @{uuid=$sessionId; name=$uuid8; msgN=0; port=$port; tabId=""}
if ((-not $Reset) -and (Test-Path $cache)) {
  try {
    $raw = Get-Content $cache -Raw | ConvertFrom-Json
    $existing.uuid  = [string]$raw.uuid
    $existing.name  = [string]$raw.name
    $existing.msgN  = [int]$raw.msgN
    $existing.port  = [string]$raw.port
    $existing.tabId = [string]$raw.tabId
  } catch {}
}

# ── Apply updates ─────────────────────────────────────────────────────
if ($TabId) { $existing.tabId = $TabId }

# Auto-detect tab from Tabby env var (no manual setup needed)
if ((-not $existing.tabId) -and $env:TABBY_AGENT_CHAT_TAB_ID) {
  $existing.tabId = $env:TABBY_AGENT_CHAT_TAB_ID
}

# ── Save cache ────────────────────────────────────────────────────────
$out = [ordered]@{
  uuid  = $existing.uuid
  name  = $existing.name
  msgN  = $existing.msgN
  port  = $existing.port
  tabId = $existing.tabId
}
$out | ConvertTo-Json -Compress | Out-File $cache -Encoding utf8

# ── Register session→tab mapping for direct messaging ─────────────────
if ($TabId) {
  $tabMap = "$env:USERPROFILE\.claude\peer-tabs.json"
  $map = [ordered]@{}
  if (Test-Path $tabMap) {
    try {
      $rawMap = Get-Content $tabMap -Raw | ConvertFrom-Json
      foreach ($k in $rawMap.PSObject.Properties.Name) {
        $v = $rawMap.$k
        $map[$k] = [ordered]@{ tabId = [string]$v.tabId; at = [string]$v.at }
      }
    } catch {}
  }
  $map[$uuid8] = [ordered]@{ tabId = $TabId; at = (Get-Date -Format "o") }
  $map | ConvertTo-Json -Compress | Out-File $tabMap -Encoding utf8
}

# ── Register on fleet status board ────────────────────────────────────
$entry = [ordered]@{
  uuid   = $sessionId
  name   = $existing.name
  status = "idle"
  project = $null
  task    = $null
  tabId   = $existing.tabId
  at      = (Get-Date -Format "o")
}
$entry | ConvertTo-Json -Compress | Add-Content "$env:USERPROFILE\.claude\peer-status.jsonl"

Get-Content $cache -Raw
