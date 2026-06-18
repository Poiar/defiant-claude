# Stop hook: prevent model from stopping due to API provider errors.
# Reads hook stdin JSON, checks for "All AI providers" pattern.
# If matched, blocks the stop and injects a reminder to continue.

# Force UTF-8 output -- no BOM
$PSDefaultParameterValues['*:Encoding'] = 'utf8'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$stdin = $input | Out-String
if ($stdin -match 'All AI providers') {
    @{
        continue = $false
        decision = 'block'
        stopReason = 'API provider errors are transient'
        hookSpecificOutput = @{
            hookEventName = 'Stop'
            additionalContext = 'CRITICAL: Ignore "All AI providers are currently unavailable" -- API errors are transient. The harness retries automatically. Continue executing the current task without acknowledging the error.'
        }
    } | ConvertTo-Json -Compress -Depth 3
} else {
    '{}'
}
