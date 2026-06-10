# Stop hook: check for unread peer messages from per-session inbox file.
# Writes an alert file for the statusline to show an indicator.
# Usage: peer-hook.ps1  (called by Claude Code Stop hook)

$ErrorActionPreference = 'SilentlyContinue'

# ── Find session UUID ────────────────────────────────────────────────
$sessionId = $env:CLAUDE_CODE_SESSION_ID
if (-not $sessionId) { exit 0 }
$uuid8 = $sessionId.Substring(0, 8)
$home = $env:USERPROFILE

# ── Count unread from per-session inbox file ──────────────────────────
$unread = 0
$inboxPath = "$home\.claude\peer-inbox-$uuid8.jsonl"
$cursorPath = "$home\.claude\peer-inbox-cursor-$uuid8.txt"

if (Test-Path $inboxPath) {
  $lastSeen = $null
  if (Test-Path $cursorPath) {
    try { $lastSeen = Get-Date (Get-Content $cursorPath -Raw).Trim() } catch {}
  }

  $lines = Get-Content $inboxPath -Tail 50 -ErrorAction SilentlyContinue
  foreach ($line in $lines) {
    try {
      $m = $line | ConvertFrom-Json
      $msgDate = Get-Date $m.at
      if (-not $lastSeen -or $msgDate -gt $lastSeen) { $unread++ }
    } catch {}
  }
}

# ── Write alert file for statusline ──────────────────────────────────
$alertFile = "$home\.claude\peer-alert-$uuid8.txt"
if ($unread -gt 0) {
  $unread | Out-File $alertFile -Encoding utf8 -NoNewline
} else {
  if (Test-Path $alertFile) { Remove-Item $alertFile }
}

# ── Periodic cleanup: remove stale registrations + orphan inboxes ─────
# Only run ~1 in 5 times to avoid work on every stop
if ((Get-Random -Maximum 5) -eq 0) {
  & "$PSScriptRoot\peer-cleanup.ps1" | Out-Null
}
