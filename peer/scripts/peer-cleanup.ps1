# Clean up stale peer registrations from exited sessions.
# Usage: peer-cleanup.ps1               → remove entries with no heartbeat in 30+ min
#        peer-cleanup.ps1 -MaxAgeMin 60 → custom age threshold
#        peer-cleanup.ps1 -WhatIf       → show what would be removed
param([int]$MaxAgeMin = 30, [switch]$WhatIf)

$ErrorActionPreference = 'SilentlyContinue'
$home = $env:USERPROFILE
$cutoff = (Get-Date).AddMinutes(-$MaxAgeMin)
$removed = @()

# 1. Find alive sessions from peer-status.jsonl (last heartbeat wins per UUID)
$alive = @{}
$statusFile = "$home\.claude\peer-status.jsonl"
if (Test-Path $statusFile) {
  foreach ($line in (Get-Content $statusFile)) {
    $e = try { $line | ConvertFrom-Json } catch { $null }
    if (-not $e) { continue }
    $entryDate = try { Get-Date $e.at } catch { $null }
    if ($entryDate -and $entryDate -gt $cutoff) {
      $alive[$e.uuid] = $true
      if ($e.name -and $e.name -ne $e.uuid.Substring(0,8)) {
        $alive[$e.name] = $true  # also track by name
      }
    }
  }
}

# 2. Clean stale peer-id cache files
Get-ChildItem "$home\.claude\peer-id-*.txt" | ForEach-Object {
  try {
    $data = Get-Content $_.FullName -Raw | ConvertFrom-Json
    $uuid = $data.uuid
    $name = $data.name
    if ($uuid -and -not $alive[$uuid] -and -not $alive[$name]) {
      if ($WhatIf) { Write-Output "Would remove: $($_.Name) ($uuid)" }
      else { Remove-Item $_.FullName; $removed += $uuid }
    }
  } catch {}
}

# 3. Clean stale peer-tabs.json entries
$tabsFile = "$home\.claude\peer-tabs.json"
if ((Test-Path $tabsFile) -and -not $WhatIf) {
  $tabs = Get-Content $tabsFile -Raw | ConvertFrom-Json
  $cleaned = @{}
  $changed = $false
  foreach ($k in $tabs.PSObject.Properties.Name) {
    if (-not $alive[$k] -and $removed -contains $k) { $changed = $true; continue }
    $cleaned[$k] = $tabs.$k
  }
  if ($changed) { $cleaned | ConvertTo-Json -Compress | Out-File $tabsFile -Encoding utf8 }
}


# 4. Clean orphaned per-session inbox files (from dead sessions)
Get-ChildItem "$home\.claude\peer-inbox-*.jsonl" -ErrorAction SilentlyContinue | ForEach-Object {
  $name = # Clean up stale peer registrations from exited sessions.
# Usage: peer-cleanup.ps1               → remove entries with no heartbeat in 30+ min
#        peer-cleanup.ps1 -MaxAgeMin 60 → custom age threshold
#        peer-cleanup.ps1 -WhatIf       → show what would be removed
param([int]$MaxAgeMin = 30, [switch]$WhatIf)

$ErrorActionPreference = 'SilentlyContinue'
$home = $env:USERPROFILE
$cutoff = (Get-Date).AddMinutes(-$MaxAgeMin)
$removed = @()

# 1. Find alive sessions from peer-status.jsonl (last heartbeat wins per UUID)
$alive = @{}
$statusFile = "$home\.claude\peer-status.jsonl"
if (Test-Path $statusFile) {
  foreach ($line in (Get-Content $statusFile)) {
    $e = try { $line | ConvertFrom-Json } catch { $null }
    if (-not $e) { continue }
    $entryDate = try { Get-Date $e.at } catch { $null }
    if ($entryDate -and $entryDate -gt $cutoff) {
      $alive[$e.uuid] = $true
      if ($e.name -and $e.name -ne $e.uuid.Substring(0,8)) {
        $alive[$e.name] = $true  # also track by name
      }
    }
  }
}

# 2. Clean stale peer-id cache files
Get-ChildItem "$home\.claude\peer-id-*.txt" | ForEach-Object {
  try {
    $data = Get-Content $_.FullName -Raw | ConvertFrom-Json
    $uuid = $data.uuid
    $name = $data.name
    if ($uuid -and -not $alive[$uuid] -and -not $alive[$name]) {
      if ($WhatIf) { Write-Output "Would remove: $($_.Name) ($uuid)" }
      else { Remove-Item $_.FullName; $removed += $uuid }
    }
  } catch {}
}

# 3. Clean stale peer-tabs.json entries
$tabsFile = "$home\.claude\peer-tabs.json"
if ((Test-Path $tabsFile) -and -not $WhatIf) {
  $tabs = Get-Content $tabsFile -Raw | ConvertFrom-Json
  $cleaned = @{}
  $changed = $false
  foreach ($k in $tabs.PSObject.Properties.Name) {
    if (-not $alive[$k] -and $removed -contains $k) { $changed = $true; continue }
    $cleaned[$k] = $tabs.$k
  }
  if ($changed) { $cleaned | ConvertTo-Json -Compress | Out-File $tabsFile -Encoding utf8 }
}

if ($removed.Count -gt 0) {
  Write-Output "Cleaned $($removed.Count) stale registrations: $($removed -join ', ')"
} elseif ($WhatIf) {
  Write-Output "(dry run, no changes)"
} else {
  Write-Output "All registrations are fresh."
}
.BaseName -replace 'peer-inbox-', ''
  if (-not $alive[$name]) {
    if ($WhatIf) { Write-Output "Would remove inbox: $(# Clean up stale peer registrations from exited sessions.
# Usage: peer-cleanup.ps1               → remove entries with no heartbeat in 30+ min
#        peer-cleanup.ps1 -MaxAgeMin 60 → custom age threshold
#        peer-cleanup.ps1 -WhatIf       → show what would be removed
param([int]$MaxAgeMin = 30, [switch]$WhatIf)

$ErrorActionPreference = 'SilentlyContinue'
$home = $env:USERPROFILE
$cutoff = (Get-Date).AddMinutes(-$MaxAgeMin)
$removed = @()

# 1. Find alive sessions from peer-status.jsonl (last heartbeat wins per UUID)
$alive = @{}
$statusFile = "$home\.claude\peer-status.jsonl"
if (Test-Path $statusFile) {
  foreach ($line in (Get-Content $statusFile)) {
    $e = try { $line | ConvertFrom-Json } catch { $null }
    if (-not $e) { continue }
    $entryDate = try { Get-Date $e.at } catch { $null }
    if ($entryDate -and $entryDate -gt $cutoff) {
      $alive[$e.uuid] = $true
      if ($e.name -and $e.name -ne $e.uuid.Substring(0,8)) {
        $alive[$e.name] = $true  # also track by name
      }
    }
  }
}

# 2. Clean stale peer-id cache files
Get-ChildItem "$home\.claude\peer-id-*.txt" | ForEach-Object {
  try {
    $data = Get-Content $_.FullName -Raw | ConvertFrom-Json
    $uuid = $data.uuid
    $name = $data.name
    if ($uuid -and -not $alive[$uuid] -and -not $alive[$name]) {
      if ($WhatIf) { Write-Output "Would remove: $($_.Name) ($uuid)" }
      else { Remove-Item $_.FullName; $removed += $uuid }
    }
  } catch {}
}

# 3. Clean stale peer-tabs.json entries
$tabsFile = "$home\.claude\peer-tabs.json"
if ((Test-Path $tabsFile) -and -not $WhatIf) {
  $tabs = Get-Content $tabsFile -Raw | ConvertFrom-Json
  $cleaned = @{}
  $changed = $false
  foreach ($k in $tabs.PSObject.Properties.Name) {
    if (-not $alive[$k] -and $removed -contains $k) { $changed = $true; continue }
    $cleaned[$k] = $tabs.$k
  }
  if ($changed) { $cleaned | ConvertTo-Json -Compress | Out-File $tabsFile -Encoding utf8 }
}

if ($removed.Count -gt 0) {
  Write-Output "Cleaned $($removed.Count) stale registrations: $($removed -join ', ')"
} elseif ($WhatIf) {
  Write-Output "(dry run, no changes)"
} else {
  Write-Output "All registrations are fresh."
}
.Name)" }
    else {
      Remove-Item # Clean up stale peer registrations from exited sessions.
# Usage: peer-cleanup.ps1               → remove entries with no heartbeat in 30+ min
#        peer-cleanup.ps1 -MaxAgeMin 60 → custom age threshold
#        peer-cleanup.ps1 -WhatIf       → show what would be removed
param([int]$MaxAgeMin = 30, [switch]$WhatIf)

$ErrorActionPreference = 'SilentlyContinue'
$home = $env:USERPROFILE
$cutoff = (Get-Date).AddMinutes(-$MaxAgeMin)
$removed = @()

# 1. Find alive sessions from peer-status.jsonl (last heartbeat wins per UUID)
$alive = @{}
$statusFile = "$home\.claude\peer-status.jsonl"
if (Test-Path $statusFile) {
  foreach ($line in (Get-Content $statusFile)) {
    $e = try { $line | ConvertFrom-Json } catch { $null }
    if (-not $e) { continue }
    $entryDate = try { Get-Date $e.at } catch { $null }
    if ($entryDate -and $entryDate -gt $cutoff) {
      $alive[$e.uuid] = $true
      if ($e.name -and $e.name -ne $e.uuid.Substring(0,8)) {
        $alive[$e.name] = $true  # also track by name
      }
    }
  }
}

# 2. Clean stale peer-id cache files
Get-ChildItem "$home\.claude\peer-id-*.txt" | ForEach-Object {
  try {
    $data = Get-Content $_.FullName -Raw | ConvertFrom-Json
    $uuid = $data.uuid
    $name = $data.name
    if ($uuid -and -not $alive[$uuid] -and -not $alive[$name]) {
      if ($WhatIf) { Write-Output "Would remove: $($_.Name) ($uuid)" }
      else { Remove-Item $_.FullName; $removed += $uuid }
    }
  } catch {}
}

# 3. Clean stale peer-tabs.json entries
$tabsFile = "$home\.claude\peer-tabs.json"
if ((Test-Path $tabsFile) -and -not $WhatIf) {
  $tabs = Get-Content $tabsFile -Raw | ConvertFrom-Json
  $cleaned = @{}
  $changed = $false
  foreach ($k in $tabs.PSObject.Properties.Name) {
    if (-not $alive[$k] -and $removed -contains $k) { $changed = $true; continue }
    $cleaned[$k] = $tabs.$k
  }
  if ($changed) { $cleaned | ConvertTo-Json -Compress | Out-File $tabsFile -Encoding utf8 }
}

if ($removed.Count -gt 0) {
  Write-Output "Cleaned $($removed.Count) stale registrations: $($removed -join ', ')"
} elseif ($WhatIf) {
  Write-Output "(dry run, no changes)"
} else {
  Write-Output "All registrations are fresh."
}
.FullName -ErrorAction SilentlyContinue
      Remove-Item "$home\.claude\peer-inbox-cursor-$name.txt" -ErrorAction SilentlyContinue
    }
  }
}
if ($removed.Count -gt 0) {
  Write-Output "Cleaned $($removed.Count) stale registrations: $($removed -join ', ')"
} elseif ($WhatIf) {
  Write-Output "(dry run, no changes)"
} else {
  Write-Output "All registrations are fresh."
}
