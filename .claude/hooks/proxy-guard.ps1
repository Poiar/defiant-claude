# PreToolUse hook: block proxy-killing commands from within a session.
# The proxy IS the API connection — killing it kills the session.
# This hook MUST NOT crash — any parse error defaults to ALLOW (fail-open),
# so the script is written defensively.

# PowerShell's $input is an automatic variable (pipeline enumerator) and
# CANNOT be assigned to. Read it without overwriting.
$raw = try { $input | Out-String } catch { '' }
if (-not $raw) {
  Write-Output '{"decision":"allow"}'
  exit 0
}

$ctx = try { $raw | ConvertFrom-Json } catch { $null }
if (-not $ctx) {
  Write-Output '{"decision":"allow"}'
  exit 0
}

$tool = $ctx.tool_name -as [string]
$cmd  = $ctx.tool_input.command -as [string]

if (($tool -ne 'Bash' -and $tool -ne 'PowerShell') -or -not $cmd) {
  Write-Output '{"decision":"allow"}'
  exit 0
}

# Allow-list: safe commands whose ARGUMENTS may contain blocked words.
# e.g. `git commit -m "fix Stop-Process bug"` — the message mentions
# Stop-Process but the command can't kill anything.
$ALLOW = @(
  '^git\s+(commit|add|diff|log|show|stash|branch|checkout|switch|restore|tag|status|push|pull|fetch|merge|rebase|config|remote|worktree)',
  '^echo\s',
  '^Write-(Output|Host|Verbose|Debug|Information|Error|Warning)\s',
  '^Get-(Content|ChildItem|Item|Location|Date|Process|Service|NetTCPConnection)\s*$',
  '^Select-Object\s',
  '^Where-Object\s',
  '^ForEach-Object\s',
  '^Get-Command\s',
  '^Test-Path\s',
)

$cmdTrimmed = $cmd.Trim()
foreach ($pat in $ALLOW) {
  if ($cmdTrimmed -match $pat) {
    Write-Output '{"decision":"allow"}'
    exit 0
  }
}

# Patterns that kill or restart the proxy.
# Be BROAD — a false positive is a minor inconvenience; a false negative
# kills the session. The user can always run dangerous commands from
# another terminal.
$BLOCK = @(
  # Direct proxy killers
  'restart-proxy',
  'start-proxy',

  # Any form of process killing that could hit node
  'taskkill',
  'Stop-Process',
  'killall',

  # Unix-style kill signals targeting node or by PID
  'kill\s+-9',
  'kill\s+-SIG',
  'kill\s+\d{2,}',

  # npm/npx commands that restart
  'npm\s+(run\s+)?restart',
  'npx\s+kill',

  # Combined find-and-kill patterns
  'Get-Process.*node.*Stop',
  'Get-Process.*node.*kill',
  'ps\s+aux.*grep.*node',
  'pgrep.*node',

  # Port-based killing (hits proxy by port)
  'lsof.*:\d{4,}.*kill',
  'netstat.*:\d{4,}.*kill',

  # Anything that restarts the Claude Code harness
  'claude.*restart',
  'cc.*restart'
)

$matched = $false
foreach ($pat in $BLOCK) {
  if ($cmd -match $pat) { $matched = $true; break }
}

if ($matched) {
  $reason = 'BLOCKED: This command would kill or restart the proxy. The proxy IS the Claude Code API connection — killing it kills your session. Run this command from a separate terminal instead.'
  Write-Output ('{"decision":"deny","reason":"' + $reason + '"}')
  exit 2
}

Write-Output '{"decision":"allow"}'
exit 0
