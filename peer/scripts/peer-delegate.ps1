# Prepare a structured delegation message. Outputs formatted /peer-msg text.
# Usage: peer-delegate.ps1 -To "e886a337" -Task "check login redirect" -Files @("src/auth/login.ts","src/middleware.ts") -Ctx "Auth was refactored last week" -Deadline 5m
param(
  [Parameter(Mandatory)][string]$To,
  [Parameter(Mandatory)][string]$Task,
  [string[]]$Files,
  [string]$Ctx,
  [string]$Deadline,
  [string]$Refs
)

$me = & "$PSScriptRoot\peer-id.ps1" | ConvertFrom-Json
if ($me.uuid -eq "unknown") { throw "Not a Claude Code session (CLAUDE_CODE_SESSION_ID not set)" }

# Atomic increment via peer-next.ps1
$n = & "$PSScriptRoot\peer-next.ps1"

# Build structured payload
$payload = @{task = $Task}
if ($Files)    { $payload.files = @($Files) }
if ($Ctx)      { $payload.ctx = $Ctx }
if ($Deadline) { $payload.deadline = $Deadline }
$body = $payload | ConvertTo-Json -Compress

# Log outbound
$entry = @{
  dir = "out"; from = $me.name; to = $To; msg = $body; type = "delegate"
  msgId = $n
  refs = if ($Refs) { $Refs } else { $null }
  at = (Get-Date -Format "o")
} | ConvertTo-Json -Compress
Add-Content "$env:USERPROFILE\.claude\peer-messages.jsonl" $entry

# Output the send_to_tab payload
$idPrefix = if ($Refs) { "re: $Refs" } else { "#${n}" }
Write-Output "/peer-msg $($me.name) → $To ${idPrefix} [delegate]: $body"
