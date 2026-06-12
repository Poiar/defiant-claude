<#
.SYNOPSIS
    Adds the script's directory to Windows Defender exclusion list.
    Must be run as administrator.
#>

#Requires -RunAsAdministrator

$dir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$proxyDir = Join-Path $dir "proxy"

$distDir = Join-Path $dir "dist" "proxy"

$existing = (Get-MpPreference).ExclusionPath
$added = $false

foreach ($excludePath in @($proxyDir, $distDir)) {
    if (Test-Path $excludePath) {
        if ($existing -contains $excludePath) {
            Write-Host "Already excluded: $excludePath" -ForegroundColor Green
        } else {
            Add-MpPreference -ExclusionPath $excludePath
            Write-Host "Excluded: $excludePath" -ForegroundColor Green
            $added = $true
        }
    }
}

if (-not $added -and (Test-Path $proxyDir)) {
    Write-Host "All paths already excluded." -ForegroundColor Green
}
Write-Host "Note: Excludes proxy source (tsx) and compiled output (dist). This prevents Defender from" -ForegroundColor DarkGray
Write-Host "      scanning files on every request, which can add 200-500ms latency per call." -ForegroundColor DarkGray
