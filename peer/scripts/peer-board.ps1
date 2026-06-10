# Read the shared fleet status board. Latest entry per UUID wins.
# Usage: peer-board.ps1              → active sessions, sorted idle→busy→dnd
#        peer-board.ps1 -All          → all sessions including stale
#        peer-board.ps1 -Idle         → only idle sessions
#        peer-board.ps1 -Capable bash → only sessions with "bash" in caps
param([switch]$All, [switch]$Idle, [string]$Capable)

$board = "$env:USERPROFILE\.claude\peer-status.jsonl"
if (-not (Test-Path $board)) { Write-Output "[]"; exit 0 }

# Self-identification via peer-id.ps1 (uses CLAUDE_CODE_SESSION_ID)
$me = try { (& "$PSScriptRoot\peer-id.ps1" | ConvertFrom-Json).name } catch { $null }

# Deduplicate: last write wins per UUID
$entries = @{}
foreach ($line in (Get-Content $board)) {
  $e = try { $line | ConvertFrom-Json } catch { $null }
  if (-not $e -or ($me -and $e.name -eq $me)) { continue }
  $entries[$e.uuid] = $e
}

$now = Get-Date
$result = foreach ($e in $entries.Values) {
  $age = ($now - (Get-Date $e.at)).TotalMinutes
  if (-not $All -and $age -ge 60) { continue }
  if ($Capable -and (-not $e.caps -or $Capable -notin $e.caps)) { continue }
  $e | Add-Member -NotePropertyName age_min -NotePropertyValue ([math]::Round($age, 1)) -Force -PassThru
}

if ($Idle) { $result = @($result | Where-Object { $_.status -eq "idle" }) }

$order = @{idle = 0; busy = 1; dnd = 2}
$result = @($result | Sort-Object { $order[$_.status] }, name)
ConvertTo-Json $result -Compress
