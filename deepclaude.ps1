<#
.SYNOPSIS
    deepclaude — Use Claude Code with cheap backends. Provider-agnostic.
    Thin wrapper around scripts/cli.mjs (Node.js unified launcher).
#>
param(
    [Parameter(ValueFromRemainingArguments)]
    [string[]]$Args
)

$ErrorActionPreference = "Stop"
try { Set-PSReadLineOption -HistorySaveStyle SaveAtExit -ErrorAction Stop } catch {}

$cli = Join-Path $PSScriptRoot "scripts\cli.mjs"
if (-not (Test-Path $cli)) {
    Write-Host "ERROR: cli.mjs not found at $cli" -ForegroundColor Red
    exit 1
}

$nodePath = try { (Get-Command node -ErrorAction Stop).Source } catch { $null }
if (-not $nodePath) {
    Write-Host "ERROR: Node.js is not installed or not in PATH." -ForegroundColor Red
    exit 1
}

& node $cli @Args
exit $LASTEXITCODE
