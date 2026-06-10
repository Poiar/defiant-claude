# Safe proxy restart — run from a NON-Claude terminal tab.
# This kills the old proxy and starts a fresh one with the latest config.
# Never run this from inside a Claude Code session or you'll kill yourself.

param([switch]$WhatIf)

$h = $env:USERPROFILE
$proxyDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "=== Safe Proxy Restart ===" -ForegroundColor Cyan

# 1. Kill old proxy
$pidFile = "$h\.deepclaude\proxy.pid"
if (Test-Path $pidFile) {
    $raw = Get-Content $pidFile -Raw
    $oldPid = try { [int]($raw.Split(':')[0]) } catch { 0 }
    if ($oldPid -and (Get-Process -Id $oldPid -ErrorAction SilentlyContinue)) {
        Write-Host "Killing old proxy PID $oldPid..." -ForegroundColor Yellow
        if (-not $WhatIf) { Stop-Process -Id $oldPid -Force }
    }
    Start-Sleep -Seconds 2
}

# 2. Start fresh proxy with all flags
$tsx = 'C:\OC\deepclaude\node_modules\.bin\tsx.cmd'
$script = 'C:\OC\deepclaude\proxy\start-proxy.ts'
$rf = "$h\.deepclaude\current-routes.json"
$of = "$h\.deepclaude\slot-overrides.json"
$pf = 'C:\OC\deepclaude\proxy\providers.json'
$out = "$h\.deepclaude\proxy-startup.txt"

Write-Host "Starting new proxy..." -ForegroundColor Cyan
New-Item -ItemType File -Path $out -Force | Out-Null

if (-not $WhatIf) {
    $proc = Start-Process -FilePath $tsx `
        -ArgumentList ($script, '--routes', $rf, '--overrides', $of, '--providers', $pf) `
        -NoNewWindow -PassThru
    Start-Sleep -Seconds 5

    $raw = Get-Content $out -Raw
    if ($raw -match 'PORT:(\d+)') {
        $newPort = $Matches[1]
        "$($proc.Id):$newPort" | Out-File $pidFile -Encoding utf8
        Write-Host "Proxy on port $newPort, PID $($proc.Id)" -ForegroundColor Green
        Write-Host ""
        Write-Host "Restart your Claude Code sessions — they still point to the old port." -ForegroundColor Yellow
    } else {
        Write-Host "FAILED to detect port. Output: $raw" -ForegroundColor Red
    }
} else {
    Write-Host "Dry run — would restart proxy."
}
