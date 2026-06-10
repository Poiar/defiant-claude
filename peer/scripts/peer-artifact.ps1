# Post a tagged knowledge artifact to the shared fleet board.
# Usage: peer-artifact.ps1 -Tag bug -Title "Login redirect loop" -Body "Missing await in auth.ts:42"
#        peer-artifact.ps1 -Tag done -Title "Fixed crash on empty search" -Files @("src/search.ts")
#        peer-artifact.ps1 -Tag bug -Title "Critical" -Body "..." -Notify  → also notifies other sessions
param(
  [Parameter(Mandatory)][string]$Tag,
  [Parameter(Mandatory)][string]$Title,
  [string]$Body,
  [string[]]$Files,
  [switch]$Notify
)

$me = & "$PSScriptRoot\peer-id.ps1" | ConvertFrom-Json
if ($me.uuid -eq "unknown") { throw "Not a Claude Code session (CLAUDE_CODE_SESSION_ID not set)" }

# Post artifact
$board = "$env:USERPROFILE\.claude\peer-artifacts.jsonl"
$entry = @{
  uuid  = $me.uuid
  name  = $me.name
  tag   = $Tag
  title = $Title
  body  = if ($Body)  { $Body }  else { $null }
  files = if ($Files) { @($Files) } else { $null }
  at    = (Get-Date -Format "o")
} | ConvertTo-Json -Compress

Add-Content $board $entry
Write-Output $entry

# Notify other sessions via message log
if ($Notify) {
  $statusBoard = "$env:USERPROFILE\.claude\peer-status.jsonl"
  if (Test-Path $statusBoard) {
    $others = @{}
    foreach ($line in (Get-Content $statusBoard)) {
      $s = try { $line | ConvertFrom-Json } catch { $null }
      if (-not $s -or $s.name -eq $me.name) { continue }
      $others[$s.uuid] = $s
    }
    foreach ($s in $others.Values) {
      $n = & "$PSScriptRoot\peer-next.ps1"
      $note = @{
        dir = "out"; from = $me.name; to = $s.name
        msg = "[artifact:$Tag] $Title"
        type = "notify"; msgId = $n
        refs = $null
        at = (Get-Date -Format "o")
      } | ConvertTo-Json -Compress
      Add-Content "$env:USERPROFILE\.claude\peer-messages.jsonl" $note
    }
    Write-Output "# notify: sent to $($others.Count) sessions"
  }
}
