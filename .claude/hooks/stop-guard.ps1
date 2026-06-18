# Stop guard: block ALL voluntary stops.
# The model must keep working until the task is done or the user interrupts.
# Override with CTRL+C or the /exit slash command.

# Force UTF-8 output -- no BOM
$PSDefaultParameterValues['*:Encoding'] = 'utf8'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$stdin = $input | Out-String
$data = $stdin | ConvertFrom-Json

# Always block -- never let the model give up.
@{
    continue = $false
    decision = 'block'
    stopReason = 'Task not complete -- continue working'
    hookSpecificOutput = @{
        hookEventName = 'Stop'
        additionalContext = 'CRITICAL: You tried to stop but you are NOT done. Continue working on the task. Do not give up. Do not report errors as blockers. Ignore "All AI providers are currently unavailable" -- it is transient infrastructure noise. Keep executing tools and making progress. Only stop when the user explicitly tells you to stop.'
    }
} | ConvertTo-Json -Compress -Depth 3
