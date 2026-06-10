# Read recent peer messages addressed to/from this session.
# Usage: peer-inbox.ps1                    → last 30 messages
#        peer-inbox.ps1 -Tail 10           → last 10
#        peer-inbox.ps1 -Type delegate     → only delegate messages
#        peer-inbox.ps1 -SinceMinutes 5    → only messages from last 5 min
#        peer-inbox.ps1 -Unseen            → only unread (since last check)
#        peer-inbox.ps1 -Json              → raw JSON array output
param(
  [int]$Tail = 30,
  [string]$Type,
  [int]$SinceMinutes,
  [switch]$Unseen,
  [switch]$Json
)

# Single source of truth for identity
$me = & "$PSScriptRoot\peer-id.ps1" | ConvertFrom-Json
if ($me.uuid -eq "unknown") { throw "Not a Claude Code session (CLAUDE_CODE_SESSION_ID not set)" }

$log = "$env:USERPROFILE\.claude\peer-messages.jsonl"
if (-not (Test-Path $log)) {
  if ($Json) { Write-Output "[]" } else { Write-Output "(no messages)" }
  exit 0
}

# Unseen: use a cursor file keyed by session UUID (stable, won't collide)
$cursorFile = "$env:USERPROFILE\.claude\peer-cursor-$($me.uuid.Substring(0,8)).txt"
$lastAt = $null
if ($Unseen) {
  if (Test-Path $cursorFile) {
    $lastAt = (Get-Content $cursorFile -Raw).Trim()
  }
}

$sinceDate = if ($SinceMinutes) { (Get-Date).AddMinutes(-$SinceMinutes) } else { $null }

$found = @()
Get-Content $log -Tail $Tail | ForEach-Object {
  $m = try { $_ | ConvertFrom-Json } catch { $null }
  if (-not $m -or ($m.to -ne $me.name -and $m.from -ne $me.name)) { return }
  if ($Type -and $m.type -ne $Type) { return }
  if ($sinceDate) {
    $msgDate = try { Get-Date $m.at } catch { $null }
    if ($msgDate -and $msgDate -lt $sinceDate) { return }
  }
  if ($Unseen -and $lastAt) {
    $msgDate = try { Get-Date $m.at } catch { $null }
    if ($msgDate -and $msgDate -le (Get-Date $lastAt)) { return }
  }
  $found += $m
}

# Update cursor
if ($found.Count -gt 0) {
  $newest = ($found | Sort-Object { (Get-Date $_.at) } | Select-Object -Last 1).at
  if ($newest) { $newest | Out-File $cursorFile -Encoding utf8 -NoNewline }
}

if ($Json) {
  ConvertTo-Json @($found) -Compress
} else {
  if ($found.Count -eq 0) { Write-Output "(no messages)"; exit 0 }
  foreach ($m in $found) {
    $dir = if ($m.from -eq $me.name) { '→' } else { '←' }
    $id = if ($m.msgId) { " #$($m.msgId)" } else { '' }
    $refs = if ($m.refs) { " (re: $($m.refs))" } else { '' }
    $type = if ($m.type -and $m.type -ne "chat") { " [$($m.type)]" } else { '' }
    Write-Output "$($m.at) $dir $($m.from) → $($m.to)$id$refs$type : $($m.msg)"
  }
}
