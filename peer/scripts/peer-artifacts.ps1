# Read/search the shared artifact board.
# Usage: peer-artifacts.ps1                  → last 20 artifacts
#        peer-artifacts.ps1 -Tag bug         → filter by tag
#        peer-artifacts.ps1 -Name "e886a337" → from a specific session
#        peer-artifacts.ps1 -Tail 5          → last 5 entries
#        peer-artifacts.ps1 -Tag done -Tail 3 → combine filters
#        peer-artifacts.ps1 -Tags            → list all used tags with counts
param([string]$Tag, [string]$Name, [int]$Tail = 20, [switch]$Tags)

$board = "$env:USERPROFILE\.claude\peer-artifacts.jsonl"
if (-not (Test-Path $board)) {
  if ($Tags) { Write-Output "{}" } else { Write-Output "[]" }
  exit 0
}

if ($Tags) {
  $counts = @{}
  foreach ($line in (Get-Content $board)) {
    $e = try { $line | ConvertFrom-Json } catch { $null }
    if (-not $e) { continue }
    $counts[$e.tag] = [int]$counts[$e.tag] + 1
  }
  ConvertTo-Json $counts -Compress
  exit 0
}

$result = foreach ($line in (Get-Content $board -Tail $Tail)) {
  $e = try { $line | ConvertFrom-Json } catch { $null }
  if (-not $e) { continue }
  if ($Tag -and $e.tag -ne $Tag) { continue }
  if ($Name -and $e.name -ne $Name) { continue }
  $e
}

# Reverse so newest first
$result = @($result)
if ($result.Count -gt 1) { $result = $result[$($result.Count - 1)..0] }
ConvertTo-Json @($result) -Compress
