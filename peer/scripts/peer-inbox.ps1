# Read messages from this session's per-session inbox file.
# Usage: peer-inbox.ps1                    → all messages (last 30)
#        peer-inbox.ps1 -Tail 10           → last 10
#        peer-inbox.ps1 -Unseen            → only unread (since last check)
#        peer-inbox.ps1 -Type delegate     → only delegate messages
#        peer-inbox.ps1 -SinceMinutes 5    → only messages from last 5 min
#        peer-inbox.ps1 -Json              → raw JSON array output
#        peer-inbox.ps1 -From "abc12345"   → only from a specific sender
param(
  [int]$Tail = 30,
  [string]$Type,
  [int]$SinceMinutes,
  [string]$From,
  [switch]$Unseen,
  [switch]$Json
)

$ErrorActionPreference = 'SilentlyContinue'
$me = & "$PSScriptRoot\peer-id.ps1" | ConvertFrom-Json
if ($me.uuid -eq "unknown") { throw "Not a Claude Code session (CLAUDE_CODE_SESSION_ID not set)" }

# Per-session inbox file
$inboxFile = "$env:USERPROFILE\.claude\peer-inbox-$($me.name).jsonl"
if (-not (Test-Path $inboxFile)) {
  if ($Json) { Write-Output "[]" } else { Write-Output "(no messages)" }
  exit 0
}

# Cursor file for Unseen tracking
$cursorFile = "$env:USERPROFILE\.claude\peer-inbox-cursor-$($me.name).txt"
$lastAt = $null
if ($Unseen) {
  if (Test-Path $cursorFile) {
    try { $lastAt = Get-Date (Get-Content $cursorFile -Raw).Trim() } catch {}
  }
}

$sinceDate = if ($SinceMinutes) { (Get-Date).AddMinutes(-$SinceMinutes) } else { $null }

# Read from per-session inbox file
$found = @()
Get-Content $inboxFile -Tail $Tail | ForEach-Object {
  $m = try { $_ | ConvertFrom-Json } catch { $null }
  if (-not $m) { return }
  if ($From -and $m.from -ne $From) { return }
  if ($Type -and $m.type -ne $Type) { return }
  if ($sinceDate) {
    $msgDate = try { Get-Date $m.at } catch { $null }
    if ($msgDate -and $msgDate -lt $sinceDate) { return }
  }
  if ($Unseen -and $lastAt) {
    $msgDate = try { Get-Date $m.at } catch { $null }
    if ($msgDate -and $msgDate -le $lastAt) { return }
  }
  $found += $m
}

# Update cursor (mark as seen)
if ($found.Count -gt 0) {
  $newest = ($found | Sort-Object { (Get-Date $_.at) } | Select-Object -Last 1).at
  if ($newest) {
    # Always store as ISO-8601 with ms precision to avoid false "unread" alerts.
    # Get-Date strips ms from human-readable strings, causing permanent false positives.
    $iso = try { (Get-Date $newest).ToString('o') } catch { $newest }
    $iso | Out-File $cursorFile -Encoding utf8 -NoNewline
  }
}

if ($Json) {
  ConvertTo-Json @($found) -Compress
} else {
  if ($found.Count -eq 0) { Write-Output "(no messages)"; exit 0 }
  foreach ($m in $found) {
    $dir = '←'
    $id = if ($m.msgId) { " #$($m.msgId)" } else { '' }
    $refs = if ($m.refs) { " (re: $($m.refs))" } else { '' }
    $type = if ($m.type -and $m.type -ne "chat") { " [$($m.type)]" } else { '' }
    Write-Output "$($m.at) $dir $($m.from) → $($m.to)$id$refs$type : $($m.msg)"
  }
}
