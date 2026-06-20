<#
.SYNOPSIS
    defiant - Use Claude Code with cheap backends. Provider-agnostic.
    Thin wrapper around scripts/cli.mjs (Node.js unified launcher).
#>
[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments)]
    [string[]]$RemainingArgs
)

$ErrorActionPreference = 'Stop'

$cli = Join-Path $PSScriptRoot 'scripts\cli.mjs'
if (-not (Test-Path $cli)) {
    Write-Error 'cli.mjs not found at $cli'
    exit 1
}

$nodePath = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodePath) {
    Write-Error 'Node.js is not installed or not in PATH.'
    exit 1
}

& node $cli @RemainingArgs
exit $LASTEXITCODE
