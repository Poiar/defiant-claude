<#
.SYNOPSIS
    Adds the script's directory to Windows Defender exclusion list.
    Must be run as administrator.
#>

#Requires -RunAsAdministrator

$dir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }

$existing = (Get-MpPreference).ExclusionPath
if ($existing -contains $dir) {
    Write-Host "Already excluded: $dir" -ForegroundColor Green
    exit 0
}

Add-MpPreference -ExclusionPath $dir
Write-Host "Excluded: $dir" -ForegroundColor Green
