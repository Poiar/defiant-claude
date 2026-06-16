# PreToolUse hook: block proxy-killing commands from within a session.
# Prevents: restart-proxy, taskkill/Stop-Process on proxy, kill signals.
# The proxy IS the API connection — killing it kills the session.

$input = $null
try {
  $input = $input | Out-String
  $ctx = $input | ConvertFrom-Json
} catch { Write-Output '{"decision":"allow"}'; exit 0 }

$tool = $ctx.tool_name -as [string]
$cmd = $ctx.tool_input.command -as [string]

if (($tool -ne 'Bash' -and $tool -ne 'PowerShell') -or -not $cmd) {
  Write-Output '{"decision":"allow"}'
  exit 0
}

# Patterns that kill the proxy
$BLOCK = @(
  'restart-proxy',
  'taskkill.*node',
  'Stop-Process.*node',
  'kill.*\d+.*proxy',
  'kill.*start-proxy',
  'killall.*node',
)

$matched = $false
foreach ($pat in $BLOCK) {
  if ($cmd -match $pat) { $matched = $true; break }
}

if ($matched) {
  Write-Output '{"decision":"deny","reason":"BLOCKED: This command would kill or restart the proxy. The proxy IS the Claude Code API connection — killing it kills your session. To deploy new code: commit + push, then restart with `dc` from another terminal."}'
  exit 2
}

Write-Output '{"decision":"allow"}'
exit 0
