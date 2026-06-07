<#
.SYNOPSIS
    Adds the script's directory to Windows Defender exclusion list.
    Must be run as administrator.
#>

#Requires -RunAsAdministrator

$dir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$proxyDir = Join-Path $dir "proxy"

$existing = (Get-MpPreference).ExclusionPath
if ($existing -contains $proxyDir) {
    Write-Host "Already excluded: $proxyDir (proxy directory only)" -ForegroundColor Green
    exit 0
}

Add-MpPreference -ExclusionPath $proxyDir
Write-Host "Excluded: $proxyDir (proxy directory only)" -ForegroundColor Green
Write-Host "Note: This only excludes the proxy JavaScript files, not the entire project."
