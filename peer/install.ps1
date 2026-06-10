# Install peer messaging system from repo to ~/.claude/
# Usage: .\peer\install.ps1         → copy scripts + skills
#        .\peer\install.ps1 -DryRun → show what would change

param([switch]$DryRun)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$h = $env:USERPROFILE
$skillsDir = "$h\.claude\skills"
$scriptsDir = "$h\.claude\scripts"

$copied = @()

# Scripts
Get-ChildItem "$repo\peer\scripts\*.ps1" | ForEach-Object {
    $dest = Join-Path $scriptsDir $_.Name
    $srcContent = Get-Content $_.FullName -Raw
    $destContent = if (Test-Path $dest) { Get-Content $dest -Raw } else { $null }
    if ($srcContent -ne $destContent) {
        if (-not $DryRun) { Copy-Item $_.FullName $dest -Force }
        $copied += "script  $($_.Name)"
    }
}

# Skills
Get-ChildItem "$repo\peer\skills" -Directory | ForEach-Object {
    $skillSrc = Join-Path $_.FullName "skill.md"
    if (-not (Test-Path $skillSrc)) { return }
    $destDir = Join-Path $skillsDir $_.Name
    $destFile = Join-Path $destDir "skill.md"
    $srcContent = Get-Content $skillSrc -Raw
    $destContent = if (Test-Path $destFile) { Get-Content $destFile -Raw } else { $null }
    if ($srcContent -ne $destContent) {
        if (-not $DryRun) {
            New-Item -ItemType Directory -Force -Path $destDir | Out-Null
            Copy-Item $skillSrc $destFile -Force
        }
        $copied += "skill  $($_.Name)"
    }
}

if ($copied.Count -eq 0) {
    Write-Output "Peer system already up to date."
} elseif ($DryRun) {
    Write-Output "Would copy $($copied.Count) files:"
    $copied | ForEach-Object { Write-Output "  $_" }
} else {
    Write-Output "Installed $($copied.Count) files:"
    $copied | ForEach-Object { Write-Output "  $_" }
}
