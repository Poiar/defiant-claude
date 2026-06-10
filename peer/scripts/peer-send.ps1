# File-based peer message delivery.
# Writes the full message to ~/.claude/peer-inbox-<target>.jsonl,
# returns a tiny wake-up ping for send_to_tab.
#
# Usage: peer-send.ps1 -To "e886a337" -Msg "can you check login.ts?" -Type delegate
#        $ping = peer-send.ps1 -To "e886a337" -Msg "status?" -Type query
#        send_to_tab <tab-id> $ping
param(
  [Parameter(Mandatory)][string]$To,
  [Parameter(Mandatory)][string]$Msg,
  [ValidateSet("chat","delegate","query","notify","ack","correct")][string]$Type = "chat",
  [string]$Refs
)

$ErrorActionPreference = 'Stop'
$me = & "$PSScriptRoot\peer-id.ps1" | ConvertFrom-Json
if ($me.uuid -eq "unknown") { throw "Not a Claude Code session (CLAUDE_CODE_SESSION_ID not set)" }

$n = & "$PSScriptRoot\peer-next.ps1"

# 1. Write to target's per-session inbox file (mutex-protected)
$inbox = "$env:USERPROFILE\.claude\peer-inbox-$To.jsonl"
$mtx = New-Object System.Threading.Mutex($false, "Global\peer-inbox-$To")
try {
  [void]$mtx.WaitOne()
  $entry = [ordered]@{
  from  = $me.name
  to    = $To
  msg   = $Msg
  type  = $Type
  msgId = $n
  refs  = if ($Refs) { $Refs } else { $null }
  at    = (Get-Date -Format "o")
} | ConvertTo-Json -Compress
  Add-Content $inbox $entry
} finally {
  [void]$mtx.ReleaseMutex()
  $mtx.Dispose()
}

# 2. Log to shared audit trail
if ($Refs) {
  & "$PSScriptRoot\peer-log.ps1" -Dir out -From $me.name -To $To -Msg $Msg -Type $Type -MsgId $n -Refs $Refs
} else {
  & "$PSScriptRoot\peer-log.ps1" -Dir out -From $me.name -To $To -Msg $Msg -Type $Type -MsgId $n
}

# 3. Return only the wake-up ping — "you have mail"
Write-Output "/peer-check"
