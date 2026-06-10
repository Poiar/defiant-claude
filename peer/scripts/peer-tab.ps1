# Look up a session UUID's tab UUID for direct send_to_tab.
# Usage: peer-tab.ps1 dde3c451     → af779d9c-aaf2-459e-bf2c-473479bebf9e
#        peer-tab.ps1 dde3c451 -Json → {"tabId":"af779d9c-...","at":"..."}
param([string]$Uuid, [switch]$Json)

$tabMap = "$env:USERPROFILE\.claude\peer-tabs.json"
if (-not (Test-Path $tabMap)) {
  if ($Json) { Write-Output "{}" } else { Write-Output "" }
  exit 1
}

$map = @{}
try {
  $raw = Get-Content $tabMap -Raw | ConvertFrom-Json
  foreach ($k in $raw.PSObject.Properties.Name) { $map[$k] = $raw.$k }
} catch {}

$entry = $map[$Uuid]
if (-not $entry) {
  if ($Json) { Write-Output "{}" } else { Write-Output "" }
  exit 1
}

if ($Json) {
  ConvertTo-Json $entry -Compress
} else {
  Write-Output $entry.tabId
}
