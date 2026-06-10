# Prepare a peer message command. Outputs the formatted text ready for send_to_tab.
# Usage: peer-send.ps1 -To "e886a337" -Msg "can you check login.ts?" -Type delegate
#        peer-send.ps1 -To "e886a337" -Msg "status?" -Type query
#        peer-send.ps1 -To "e886a337" -Msg "hey!"                    # defaults to chat
#        peer-send.ps1 -To "e886a337" -Msg "ack" -Refs "5"           # reply to msg #5
param(
  [Parameter(Mandatory)][string]$To,
  [Parameter(Mandatory)][string]$Msg,
  [ValidateSet("chat","delegate","query","notify","ack","correct")][string]$Type = "chat",
  [string]$Refs
)

# Single source of truth: peer-id.ps1 handles UUID, name, port, file naming
$me = & "$PSScriptRoot\peer-id.ps1" | ConvertFrom-Json
if ($me.uuid -eq "unknown") { throw "Not a Claude Code session (CLAUDE_CODE_SESSION_ID not set)" }

# Atomic increment via peer-next.ps1 (uses same peer-id.ps1 internally)
$n = & "$PSScriptRoot\peer-next.ps1"

# Log outbound
$entry = @{
  dir = "out"; from = $me.name; to = $To; msg = $Msg; type = $Type
  msgId = $n
  refs = if ($Refs) { $Refs } else { $null }
  at = (Get-Date -Format "o")
} | ConvertTo-Json -Compress
Add-Content "$env:USERPROFILE\.claude\peer-messages.jsonl" $entry

# Output the send_to_tab payload
$idPrefix = if ($Refs) { "re: $Refs" } else { "#${n}" }
if ($Type -eq "chat") {
  Write-Output "/peer-msg $($me.name) → $To ${idPrefix}: $Msg"
} else {
  Write-Output "/peer-msg $($me.name) → $To ${idPrefix} [$Type]: $Msg"
}
