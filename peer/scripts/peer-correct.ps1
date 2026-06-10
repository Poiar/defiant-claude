# Fix a wrong tab→session mapping after receiving a [correct] reply.
# Usage: peer-correct.ps1 -WrongUuid "6b71329d" -CorrectUuid "85c334ae" -TabId "ac831cb3-..."
#        peer-correct.ps1 -WrongUuid "6b71329d" -CorrectUuid "85c334ae"  (auto-finds tab from wrong UUID)
param(
  [Parameter(Mandatory)][string]$WrongUuid,
  [Parameter(Mandatory)][string]$CorrectUuid
)

$ErrorActionPreference = 'Stop'
$tabMap = "$env:USERPROFILE\.claude\peer-tabs.json"

# 1. Find the tab we used — it's mapped to the wrong UUID
$tabId = ""
if (Test-Path $tabMap) {
  try {
    $map = Get-Content $tabMap -Raw | ConvertFrom-Json
    $wrongEntry = $map.$WrongUuid
    if ($wrongEntry) { $tabId = $wrongEntry.tabId }
  } catch {}
}

if (-not $tabId) {
  Write-Error "No tab mapping found for $WrongUuid — can't fix"
  exit 1
}

# 2. Rewrite: correct UUID gets the tab, remove wrong entry
$map = @{}
if (Test-Path $tabMap) {
  try {
    $raw = Get-Content $tabMap -Raw | ConvertFrom-Json
    foreach ($k in $raw.PSObject.Properties.Name) { $map[$k] = $raw.$k }
  } catch {}
}

$map[$CorrectUuid] = @{ tabId = $tabId; at = (Get-Date -Format "o") }
$map.Remove($WrongUuid)

$map | ConvertTo-Json -Compress | Out-File $tabMap -Encoding utf8

# 3. Remove stale peer-id cache so wrong UUID re-identifies next time
Remove-Item "$env:USERPROFILE\.claude\peer-id-$WrongUuid.txt" -ErrorAction SilentlyContinue

Write-Output "Fixed: $CorrectUuid → $tabId  (removed stale $WrongUuid)"
