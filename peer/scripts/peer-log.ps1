# Append a peer message entry to the shared JSONL log.
# Types: chat (default, free-text), delegate, query, notify, ack
param(
  [Parameter(Mandatory)] [string]$Dir,    # "in" or "out"
  [Parameter(Mandatory)] [string]$From,
  [Parameter(Mandatory)] [string]$To,
  [Parameter(Mandatory)] [string]$Msg,
  [int]$MsgId,
  [string]$Refs = "",
  [ValidateSet("chat","delegate","query","notify","ack","correct")][string]$Type = "chat"
)

$entry = @{
  dir = $Dir; from = $From; to = $To; msg = $Msg; type = $Type
  msgId = if ($MsgId) { $MsgId } else { $null }
  refs = if ($Refs) { $Refs } else { $null }
  at = (Get-Date -Format "o")
} | ConvertTo-Json -Compress

Add-Content "$env:USERPROFILE\.claude\peer-messages.jsonl" $entry
