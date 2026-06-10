# Write this session's status to the shared fleet board.
# Usage: peer-status.ps1 idle [-Task "waiting"] [-Project "deepclaude"] [-Caps @("playwright","bash")]
#        peer-status.ps1 busy -Task "fixing auth" -Caps @("playwright","read")
#        peer-status.ps1 dnd
param(
  [Parameter(Mandatory)][ValidateSet("idle","busy","dnd")][string]$Status,
  [string]$Task,
  [string]$Project,
  [string[]]$Caps
)

$me = & "$PSScriptRoot\peer-id.ps1" | ConvertFrom-Json
if ($me.uuid -eq "unknown") { throw "Not a Claude Code session (CLAUDE_CODE_SESSION_ID not set)" }

$board = "$env:USERPROFILE\.claude\peer-status.jsonl"
$entry = @{
  uuid    = $me.uuid
  name    = $me.name
  status  = $Status
  project = if ($Project) { $Project } else { $null }
  task    = if ($Task)   { $Task }   else { $null }
  caps    = if ($Caps)   { @($Caps) } else { $null }
  at      = (Get-Date -Format "o")
} | ConvertTo-Json -Compress

Add-Content $board $entry
Write-Output $entry
