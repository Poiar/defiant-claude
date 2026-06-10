# Atomically increment msgN and return the new ID. Thread-safe via mutex.
# Uses the session's UUID-derived peer-id file (not port-based).

$me = & "$PSScriptRoot\peer-id.ps1" | ConvertFrom-Json
if ($me.uuid -eq "unknown") { throw "Not a Claude Code session (CLAUDE_CODE_SESSION_ID not set)" }

$cache = "$env:USERPROFILE\.claude\peer-id-$($me.uuid.Substring(0,8)).txt"

$mtx = New-Object System.Threading.Mutex($false, "Global\peer-msgN-$($me.uuid.Substring(0,8))")
try {
  [void]$mtx.WaitOne()
  if (-not (Test-Path $cache)) { throw "peer-id not set; run peer-id.ps1 first" }
  $data = Get-Content $cache -Raw | ConvertFrom-Json
  $data.msgN = [int]$data.msgN + 1
  $data | ConvertTo-Json -Compress | Out-File $cache -Encoding utf8
  Write-Output $data.msgN
} finally {
  [void]$mtx.ReleaseMutex()
}
