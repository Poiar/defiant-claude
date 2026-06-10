# Stop hook: check for unread peer messages and write an alert file.
# The statusline reads this file to show an alert indicator.
# Usage: peer-hook.ps1  (called by Claude Code Stop hook)

$ErrorActionPreference = 'SilentlyContinue'

# ── Find session UUID ────────────────────────────────────────────────
$sessionId = $env:CLAUDE_CODE_SESSION_ID
if (-not $sessionId) { exit 0 }
$uuid8 = $sessionId.Substring(0, 8)
$home = $env:USERPROFILE

# ── Count unread peer messages ───────────────────────────────────────
$unread = 0
$logPath = "$home\.claude\peer-messages.jsonl"
$cursorPath = "$home\.claude\peer-cursor-$uuid8.txt"

if (Test-Path $logPath) {
  $lastSeen = $null
  if (Test-Path $cursorPath) {
    try { $lastSeen = Get-Date (Get-Content $cursorPath -Raw).Trim() } catch {}
  }

  $lines = Get-Content $logPath -Tail 50 -ErrorAction SilentlyContinue
  foreach ($line in $lines) {
    try {
      $m = $line | ConvertFrom-Json
      if ($m.to -eq $uuid8) {
        $msgDate = Get-Date $m.at
        if (-not $lastSeen -or $msgDate -gt $lastSeen) { $unread++ }
      }
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


# ── Periodic cleanup: remove stale registrations ──────────────────────
# Only run ~1 in 5 times to avoid work on every stop
if ((Get-Random -Maximum 5) -eq 0) {
  & "$PSScriptRoot\peer-cleanup.ps1" | Out-Null
}