<#
.SYNOPSIS
    deepclaude -- Use Claude Code with cheap backends. Provider-agnostic: mix models from different APIs in one config.

.USAGE
    # Named configs (via -b)
    deepclaude                      # DeepSeek V4 Pro (default)
    deepclaude -b or                # OpenRouter (DeepSeek)
    deepclaude -b fw                # Fireworks AI (fastest)
    deepclaude -b oc                # OpenCode Zen
    deepclaude -b ds+oc             # DeepSeek main + OpenCode subs
    deepclaude -b ds+oc             # DeepSeek main + OpenCode subs
    deepclaude -b anthropic         # Normal Claude Code

    # Model aliases: sonnet, opus, haiku, v4, flash (short names resolve to full model IDs)
    # Ad-hoc positional: providerKey:modelId for opus sonnet haiku subagent fable
    deepclaude ds:deepseek-v4-pro                                              # 1 spec -> all 5 slots
    deepclaude ds:deepseek-v4-pro oc:big-pickle                                # 2 specs -> first 3 / last 2
    deepclaude ds:deepseek-v4-pro oc:big-pickle or:z-ai/glm-4.5-air:free       # 3 specs -> opus, rest=second, sub/fable=third
    deepclaude ds:deepseek-v4-pro ds:deepseek-v4-pro oc:big-pickle or:z-ai/glm-4.5-air:free  # 4 specs -> sub/fable share last
    deepclaude ds:deepseek-v4-pro ds:deepseek-v4-pro oc:big-pickle or:z-ai/glm-4.5-air:free mm:mimo-v2.5-pro  # 5 specs -> direct

    # Remote control (starts proxy + browser-based Claude Code)
    deepclaude --remote                                 # Default config
    deepclaude --remote -b or                           # Named config
    deepclaude --remote -b anthropic                    # Anthropic direct
    deepclaude --remote ds:deepseek-v4-pro oc:big-pickle # Ad-hoc config

    # Persistent proxy + mid-session switching
    deepclaude --persist -b ds+oc    # Keep proxy alive after CC exits
    deepclaude --switch ds+oc        # Switch running proxy to different config
    deepclaude --switch ds:deepseek-v4-pro oc:big-pickle  # Switch to ad-hoc config
    deepclaude --models              # List all available model IDs
    deepclaude --stop-proxy          # Kill the persistent proxy

    # Info / debugging
    deepclaude --status             # Show keys, providers, and active slot mapping
    deepclaude --stats              # Show proxy stats (requests, success rate, latency)
    deepclaude --probe [file]       # Test each configured provider with a minimal prompt
    deepclaude --dry-run [file]     # Show resolved routing table without starting proxy
    deepclaude --dashboard          # Print health dashboard URL (use with --open)
    deepclaude --doctor             # System health check (prereqs, keys, proxy test)
    deepclaude --cost               # Pricing comparison
    deepclaude --benchmark          # Parallel latency test across all configs
    deepclaude -h                   # This help
    deepclaude --lint               # Self-lint with PSScriptAnalyzer
    deepclaude --lint-config         # Validate providers.json configuration
    deepclaude --log-all            # Log all requests (failures always logged)
    deepclaude --skip-startup-check # Skip the provider health check on proxy startup
    deepclaude --no-thinking        # Disable extended thinking for all models
    deepclaude --thinking-budget 64000  # Set thinking budget to 64K tokens
    deepclaude --subagent-model oc:big-pickle  # Set a dedicated subagent model
    deepclaude --subagent-model     # Clear the dedicated subagent model
    deepclaude --fix-av             # Print AV exclusion commands
#>

param(
    [Parameter(Position=0)]
    [Alias("b")]
    [string]$Backend,
    [string]$Effort = "max",
    [Alias("r")]
    [switch]$Remote,
    [switch]$Status,
    [switch]$Cost,
    [switch]$Benchmark,
    [Alias("h")]
    [switch]$Help,
    [switch]$Lint,
    [switch]$LintConfig,
    [switch]$FixAv,
    [switch]$Persist,
    [string]$Switch,
    [string]$SetSlot,
    [string]$SubagentModel,
    [switch]$Models,
    [switch]$StopProxy,
    [switch]$Version,
    [switch]$Doctor,
    [switch]$InstallStatusline,
    [switch]$Stats,
    [string]$ProbeFile,
    [switch]$DryRun,
    [switch]$Dashboard,
    [switch]$Open,
    [switch]$LogAll,
    [switch]$SkipStartupCheck,
    [switch]$Logs,
    [switch]$Health,
    [switch]$NoThinking,
    [int]$ThinkingBudget = 0,
    [Parameter(ValueFromRemainingArguments)]
    [string[]]$ModelSpecs
)

$ErrorActionPreference = "Stop"

# Stop sharing command history with other pwsh sessions immediately.
# PSReadLine defaults to SaveIncrementally, which writes every command
# to a shared file — causing tab cross-contamination of Up-arrow history.
try { Set-PSReadLineOption -HistorySaveStyle SaveAtExit -ErrorAction Stop } catch {}

# Require PowerShell 7+ (uses ??, ForEach-Object -Parallel, ternary operator)
if ($PSVersionTable.PSVersion.Major -lt 7) {
    Write-Host "ERROR: deepclaude requires PowerShell 7+. You're running $($PSVersionTable.PSVersion)." -ForegroundColor Red
    Write-Host "Install from: https://github.com/PowerShell/PowerShell" -ForegroundColor DarkGray
    exit 1
}

# Normalize --flag arguments (accept both --flag and -Flag forms)
# Uses if/elseif instead of switch() — PowerShell switch statement creates a
# scoping conflict when a $Switch variable exists, so assignments don't stick.
if ($Backend -match '^--(.+)$') {
    $flag = $Matches[1]
    if ($flag -eq 'persist')             { $Persist = $true }
    elseif ($flag -eq 'switch' -and $ModelSpecs -and $ModelSpecs.Count -gt 0) {
        $Switch = $ModelSpecs[0]
        $ModelSpecs = if ($ModelSpecs.Count -gt 1) { $ModelSpecs[1..($ModelSpecs.Count-1)] } else { @() }
    }
    elseif ($flag -eq 'set-slot' -and $ModelSpecs -and $ModelSpecs.Count -gt 0) {
        $SetSlot = $ModelSpecs[0]
        $ModelSpecs = if ($ModelSpecs.Count -gt 1) { $ModelSpecs[1..($ModelSpecs.Count-1)] } else { @() }
    }
    elseif ($flag -eq 'subagent-model') {
        if ($ModelSpecs -and $ModelSpecs.Count -gt 0) {
            $SubagentModel = $ModelSpecs[0]
            $ModelSpecs = if ($ModelSpecs.Count -gt 1) { $ModelSpecs[1..($ModelSpecs.Count-1)] } else { @() }
        } else {
            $SubagentModel = ''
        }
    }
    elseif ($flag -eq 'effort' -and $ModelSpecs -and $ModelSpecs.Count -gt 0) {
        $Effort = $ModelSpecs[0]
        if ($Effort -notin @('low', 'medium', 'high', 'max')) {
            Write-Host "ERROR: Invalid effort level '$Effort'. Valid values: low, medium, high, max" -ForegroundColor Red
            exit 1
        }
        $ModelSpecs = if ($ModelSpecs.Count -gt 1) { $ModelSpecs[1..($ModelSpecs.Count-1)] } else { @() }
    }
    elseif ($flag -eq 'models')          { $Models = $true }
    elseif ($flag -eq 'stop-proxy')      { $StopProxy = $true }
    elseif ($flag -eq 'remote')          { $Remote = $true }
    elseif ($flag -eq 'status')          { $Status = $true }
    elseif ($flag -eq 'cost')            { $Cost = $true }
    elseif ($flag -eq 'benchmark')       { $Benchmark = $true }
    elseif ($flag -eq 'help')            { $Help = $true }
    elseif ($flag -eq 'lint')            { $Lint = $true }
    elseif ($flag -eq 'lint-config')     { $LintConfig = $true }
    elseif ($flag -eq 'fix-av')          { $FixAv = $true }
    elseif ($flag -eq 'version')         { $Version = $true }
    elseif ($flag -eq 'doctor')          { $Doctor = $true }
    elseif ($flag -eq 'install-statusline') { $InstallStatusline = $true }
    elseif ($flag -eq 'stats')           { $Stats = $true }
    elseif ($flag -eq 'probe' -and $ModelSpecs -and $ModelSpecs.Count -gt 0) {
        $ProbeFile = $ModelSpecs[0]
        $ModelSpecs = if ($ModelSpecs.Count -gt 1) { $ModelSpecs[1..($ModelSpecs.Count-1)] } else { @() }
    }
    elseif ($flag -eq 'probe')           { $ProbeFile = '' }
    elseif ($flag -eq 'dry-run' -or $flag -eq 'what-if') {
        $DryRun = $true
        if ($ModelSpecs -and $ModelSpecs.Count -gt 0 -and $ModelSpecs[0] -notmatch '^-|:') {
            $DryRunFile = $ModelSpecs[0]
            $ModelSpecs = if ($ModelSpecs.Count -gt 1) { $ModelSpecs[1..($ModelSpecs.Count-1)] } else { @() }
        }
    }
    elseif ($flag -eq 'dashboard')       { $Dashboard = $true }
    elseif ($flag -eq 'open')            { $Open = $true }
    elseif ($flag -eq 'log-all')         { $LogAll = $true }
    elseif ($flag -eq 'skip-startup-check') { $SkipStartupCheck = $true }
    elseif ($flag -eq 'logs' -or $flag -eq 'tail') { $Logs = $true }
    elseif ($flag -eq 'health')          { $Health = $true }
    elseif ($flag -eq 'no-thinking')     { $NoThinking = $true }
    elseif ($flag -eq 'thinking-budget' -and $ModelSpecs -and $ModelSpecs.Count -gt 0) {
        $ThinkingBudget = [int]$ModelSpecs[0]
        if ($ThinkingBudget -lt 0) {
            Write-Host "ERROR: --thinking-budget must be >= 0" -ForegroundColor Red
            exit 1
        }
        $ModelSpecs = if ($ModelSpecs.Count -gt 1) { $ModelSpecs[1..($ModelSpecs.Count-1)] } else { @() }
    }
    else {
        Write-Host "ERROR: Unknown flag '--$flag'. Use --help for available flags." -ForegroundColor Red
        exit 1
    }
    $Backend = $null
}

# Second pass: scan $ModelSpecs for flags that arrived via ValueFromRemainingArguments.
# When using -b CONFIG --flag, PowerShell consumes -b CONFIG as $Backend and leaves
# --flag in $ModelSpecs — so $DryRun, $Persist, etc. are never set. Process leading
# flag-like entries here, stopping at the first positional spec.
while ($ModelSpecs -and $ModelSpecs.Count -gt 0 -and $ModelSpecs[0] -match '^--(.+)$') {
    $flag = $Matches[1]
    $ModelSpecs = if ($ModelSpecs.Count -gt 1) { $ModelSpecs[1..($ModelSpecs.Count-1)] } else { @() }

    if ($flag -eq 'persist' -and -not $Persist)       { $Persist = $true }
    elseif ($flag -eq 'switch' -and $ModelSpecs -and $ModelSpecs.Count -gt 0) {
        if (-not $Switch) { $Switch = $ModelSpecs[0]; $ModelSpecs = if ($ModelSpecs.Count -gt 1) { $ModelSpecs[1..($ModelSpecs.Count-1)] } else { @() } }
        else { Write-Host "WARNING: --switch already set; ignoring second --switch" -ForegroundColor Yellow }
    }
    elseif ($flag -eq 'set-slot' -and $ModelSpecs -and $ModelSpecs.Count -gt 0) {
        if (-not $SetSlot) { $SetSlot = $ModelSpecs[0]; $ModelSpecs = if ($ModelSpecs.Count -gt 1) { $ModelSpecs[1..($ModelSpecs.Count-1)] } else { @() } }
        else { Write-Host "WARNING: --set-slot already set; ignoring second --set-slot" -ForegroundColor Yellow }
    }
    elseif ($flag -eq 'subagent-model') {
        if ($ModelSpecs -and $ModelSpecs.Count -gt 0) {
            if (-not $PSBoundParameters.ContainsKey('SubagentModel')) { $SubagentModel = $ModelSpecs[0]; $ModelSpecs = if ($ModelSpecs.Count -gt 1) { $ModelSpecs[1..($ModelSpecs.Count-1)] } else { @() } }
            else { $ModelSpecs = if ($ModelSpecs.Count -gt 1) { $ModelSpecs[1..($ModelSpecs.Count-1)] } else { @() } }
        } else {
            $SubagentModel = ''
        }
    }
    elseif ($flag -eq 'effort' -and $ModelSpecs -and $ModelSpecs.Count -gt 0) {
        $val = $ModelSpecs[0]
        if ($val -notin @('low', 'medium', 'high', 'max')) {
            Write-Host "ERROR: Invalid effort level '$val'. Valid values: low, medium, high, max" -ForegroundColor Red
            exit 1
        }
        $Effort = $val
        $ModelSpecs = if ($ModelSpecs.Count -gt 1) { $ModelSpecs[1..($ModelSpecs.Count-1)] } else { @() }
    }
    elseif ($flag -eq 'models' -and -not $Models)         { $Models = $true }
    elseif ($flag -eq 'stop-proxy' -and -not $StopProxy)   { $StopProxy = $true }
    elseif ($flag -eq 'remote' -and -not $Remote)           { $Remote = $true }
    elseif ($flag -eq 'status' -and -not $Status)           { $Status = $true }
    elseif ($flag -eq 'cost' -and -not $Cost)               { $Cost = $true }
    elseif ($flag -eq 'benchmark' -and -not $Benchmark)     { $Benchmark = $true }
    elseif ($flag -eq 'help' -and -not $Help)               { $Help = $true }
    elseif ($flag -eq 'lint' -and -not $Lint)               { $Lint = $true }
    elseif ($flag -eq 'lint-config' -and -not $LintConfig)   { $LintConfig = $true }
    elseif ($flag -eq 'fix-av' -and -not $FixAv)            { $FixAv = $true }
    elseif ($flag -eq 'version' -and -not $Version)         { $Version = $true }
    elseif ($flag -eq 'doctor' -and -not $Doctor)           { $Doctor = $true }
    elseif ($flag -eq 'install-statusline' -and -not $InstallStatusline) { $InstallStatusline = $true }
    elseif ($flag -eq 'stats' -and -not $Stats)             { $Stats = $true }
    elseif ($flag -eq 'probe' -and $ModelSpecs -and $ModelSpecs.Count -gt 0) {
        if (-not $PSBoundParameters.ContainsKey('ProbeFile')) { $ProbeFile = $ModelSpecs[0]; $ModelSpecs = if ($ModelSpecs.Count -gt 1) { $ModelSpecs[1..($ModelSpecs.Count-1)] } else { @() } }
        else { $ModelSpecs = if ($ModelSpecs.Count -gt 1) { $ModelSpecs[1..($ModelSpecs.Count-1)] } else { @() } }
    }
    elseif ($flag -eq 'probe' -and -not $PSBoundParameters.ContainsKey('ProbeFile')) { $ProbeFile = '' }
    elseif ($flag -eq 'dry-run' -or $flag -eq 'what-if') {
        if (-not $DryRun) {
            $DryRun = $true
            if ($ModelSpecs -and $ModelSpecs.Count -gt 0 -and $ModelSpecs[0] -notmatch '^-|:') {
                if (-not $DryRunFile) { $DryRunFile = $ModelSpecs[0]; $ModelSpecs = if ($ModelSpecs.Count -gt 1) { $ModelSpecs[1..($ModelSpecs.Count-1)] } else { @() } }
            }
        }
    }
    elseif ($flag -eq 'dashboard' -and -not $Dashboard)     { $Dashboard = $true }
    elseif ($flag -eq 'open' -and -not $Open)               { $Open = $true }
    elseif ($flag -eq 'log-all' -and -not $LogAll)           { $LogAll = $true }
    elseif ($flag -eq 'skip-startup-check' -and -not $SkipStartupCheck) { $SkipStartupCheck = $true }
    elseif ($flag -eq 'logs' -or $flag -eq 'tail') {
        if (-not $Logs) { $Logs = $true }
    }
    elseif ($flag -eq 'health' -and -not $Health)           { $Health = $true }
    elseif ($flag -eq 'no-thinking' -and -not $NoThinking)   { $NoThinking = $true }
    elseif ($flag -eq 'thinking-budget' -and $ModelSpecs -and $ModelSpecs.Count -gt 0) {
        $val = [int]$ModelSpecs[0]
        if ($val -lt 0) {
            Write-Host "ERROR: --thinking-budget must be >= 0" -ForegroundColor Red
            exit 1
        }
        $ThinkingBudget = $val
        $ModelSpecs = if ($ModelSpecs.Count -gt 1) { $ModelSpecs[1..($ModelSpecs.Count-1)] } else { @() }
    }
    else {
        Write-Host "ERROR: Unknown flag '--$flag'. Use --help for available flags." -ForegroundColor Red
        exit 1
    }
}

# Validate --effort value (also accepts -effort from flag normalization above)
if ($Effort -notin @('low', 'medium', 'high', 'max')) {
    Write-Host "ERROR: Invalid effort level '$Effort'. Valid values: low, medium, high, max" -ForegroundColor Red
    exit 1
}

# State directory for persistent proxy
$DeepClaudeDir = Join-Path $HOME ".deepclaude"
$ProxyStateFile = Join-Path $DeepClaudeDir "proxy.json"
$CurrentRoutesFile = Join-Path $DeepClaudeDir "current-routes.json"
$SlotOverridesFile = Join-Path $DeepClaudeDir "slot-overrides.json"
$ThinkingOverridesFile = Join-Path $DeepClaudeDir "thinking-overrides.json"
$SubagentModelFile = Join-Path $DeepClaudeDir "subagent-model.json"
$FixAvBatchFile = Join-Path $DeepClaudeDir "fix-av.cmd"
$LauncherMjs = Join-Path $PSScriptRoot "proxy\launcher.mjs"

function Invoke-LauncherMjs {
    $tmpErr = Join-Path $env:TEMP "launcher-$([System.Guid]::NewGuid()).err"
    $result = node $LauncherMjs @args 2>$tmpErr
    if ($LASTEXITCODE -ne 0) {
        $errText = if (Test-Path $tmpErr) { Get-Content $tmpErr -Raw } else { '' }
        Remove-Item $tmpErr -ErrorAction SilentlyContinue
        Write-Host "ERROR: launcher.mjs failed: $errText" -ForegroundColor Red
        exit 1
    }
    Remove-Item $tmpErr -ErrorAction SilentlyContinue
    return $result
}

# --- Initialize slot overrides with validation ---
# Calls launcher.mjs init-overrides and validates the result:
# - All 5 slots (opus/sonnet/haiku/subagent/fable) must have direct keys
# - _configName must be present
# - The written file must match the returned object (round-trip verification)
# If validation fails, the function logs the discrepancy and exits.
function Initialize-SlotOverrides {
    param([string]$Name, [string]$Specs)
    if ($Name) {
        $resultJson = Invoke-LauncherMjs "init-overrides", "--name=$Name"
    } elseif ($Specs) {
        $resultJson = Invoke-LauncherMjs "init-overrides", "--specs=$Specs"
    } else {
        Write-Host "INTERNAL ERROR: Initialize-SlotOverrides requires --Name or --Specs" -ForegroundColor Red
        exit 1
    }
    $result = $resultJson | ConvertFrom-Json

    # Verify all 5 slots have direct keys
    $slots = @("opus", "sonnet", "haiku", "subagent", "fable")
    $missing = @()
    foreach ($s in $slots) {
        if (-not $result.$s) { $missing += $s }
    }
    if ($missing) {
        Write-Host "ERROR: init-overrides missing direct keys: $($missing -join ', ')" -ForegroundColor Red
        Write-Host "  Result: $resultJson" -ForegroundColor DarkGray
        Write-Host "  The slot-overrides.json file may be corrupt. Delete ~/.deepclaude/slot-overrides.json and retry." -ForegroundColor Yellow
        exit 1
    }

    # Verify _defaults matches direct keys (when no user overrides are active)
    $mismatched = @()
    foreach ($s in $slots) {
        if ($result._defaults.$s -and $result.$s -ne $result._defaults.$s) {
            $mismatched += "$s (direct=$($result.$s), default=$($result._defaults.$s))"
        }
    }
    if ($mismatched) {
        Write-Host "  Slot overrides active (user customizations): $($mismatched -join '; ')" -ForegroundColor DarkGray
    }

    # Verify _configName is present and reasonable
    if (-not $result._configName) {
        Write-Host "ERROR: init-overrides missing _configName field" -ForegroundColor Red
        exit 1
    }

    # Round-trip: read the file and verify it matches the returned object
    if (Test-Path $SlotOverridesFile) {
        try {
            $onDisk = Get-Content $SlotOverridesFile -Raw | ConvertFrom-Json
            foreach ($s in $slots) {
                if ($onDisk.$s -ne $result.$s) {
                    Write-Host "ERROR: init-overrides write mismatch: slot $s on disk='$($onDisk.$s)', returned='$($result.$s)'" -ForegroundColor Red
                    exit 1
                }
            }
            if ($onDisk._configName -ne $result._configName) {
                Write-Host "ERROR: init-overrides write mismatch: _configName on disk='$($onDisk._configName)', returned='$($result._configName)'" -ForegroundColor Red
                exit 1
            }
        } catch {
            Write-Host "WARNING: Could not verify slot-overrides.json round-trip: $_" -ForegroundColor Yellow
        }
    }

    return $result
}

# Ensure state directory exists
if (-not (Test-Path $DeepClaudeDir)) {
    New-Item -ItemType Directory -Path $DeepClaudeDir -Force | Out-Null
}

# Clean up stale .tmp files from interrupted writes
Get-ChildItem $DeepClaudeDir -Filter "*.tmp" -ErrorAction SilentlyContinue | Remove-Item -Force

# --- Tail proxy logs ---
if ($Logs) {
    $logPath = Join-Path $DeepClaudeDir "proxy.log"
    if (-not (Test-Path $logPath)) {
        Write-Host "No proxy log found at $logPath" -ForegroundColor Yellow
        Write-Host "Start the proxy first with: deepclaude --persist" -ForegroundColor DarkGray
        exit 1
    }
    Write-Host "Tailing $logPath (Ctrl+C to stop)..." -ForegroundColor Cyan
    Write-Host "---" -ForegroundColor DarkGray
    try {
        Get-Content $logPath -Tail 50 -Wait
    } catch {
        # User pressed Ctrl+C or terminal closed
    }
    exit 0
}

# --- Health check ---
if ($Health) {
    $stateFile = Join-Path $DeepClaudeDir "proxy.json"
    if (-not (Test-Path $stateFile)) {
        # Hook-friendly: exit 0 so SessionStart hooks don't error on clean state.
        # Claude Code hooks treat any non-zero exit as a failure.
        exit 0
    }
    $state = Get-Content $stateFile -Raw | ConvertFrom-Json
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$($state.port)/health" -TimeoutSec 5
    $providers = $health.providers
    $healthy = 0; $down = 0; $total = 0
    foreach ($p in $providers.PSObject.Properties) {
        $total++
        $cb = $p.Value.circuitBreaker
        if ($cb -eq 'OPEN') { $down++ } else { $healthy++ }
    }
    $spendFile = Join-Path $DeepClaudeDir "spend.json"
    $sessionSpend = ''
    if (Test-Path $spendFile) {
        try {
            $sp = Get-Content $spendFile -Raw | ConvertFrom-Json
            if ($sp.sessions -and $sp.sessions[0].total) {
                $sessionSpend = " | `$$([math]::Round($sp.sessions[0].total, 2)) session"
            }
        } catch {}
    }
    Write-Host "$healthy/$total up ${sessionSpend}" -ForegroundColor $(if ($down -eq 0) { 'Green' } elseif ($healthy -gt 0) { 'Yellow' } else { 'Red' })
    if ($down -gt 0) {
        $openList = ($providers.PSObject.Properties | Where-Object { $_.Value.circuitBreaker -eq 'OPEN' }).Name -join ', '
        Write-Host "  down: $openList" -ForegroundColor Red
    }
    exit 0
}

# Gather all positional specs: first goes to $Backend, rest to $ModelSpecs.
# Because $ModelSpecs captures remaining arguments (ValueFromRemainingArguments),
# it can contain flags that weren't consumed by the flag-normalization block
# (e.g., --dry-run, --subagent-model <val>, etc.). Filter those out so they
# don't break the named-config resolve path ($AllSpecs.Count -eq 1 check).
$AllSpecs = @()
if ($Backend) { $AllSpecs += $Backend }
if ($ModelSpecs) { $AllSpecs += $ModelSpecs }
# Strip leading/trailing whitespace and filter out flag-looking entries.
# @(...) forces array — a single-element pipeline result would otherwise
# unroll to a scalar string, breaking $AllSpecs[0] (returns first char).
$AllSpecs = @($AllSpecs | ForEach-Object { $_ -replace '^\s+|\s+$', '' } | Where-Object { $_ -and $_ -notmatch '^-' })

if (-not $AllSpecs -and -not $Status -and -not $Cost -and -not $Benchmark -and -not $Help -and -not $Lint -and -not $LintConfig -and -not $FixAv -and -not $Switch -and -not $SetSlot -and -not $SubagentModel -and -not $Models -and -not $StopProxy -and -not $Version -and -not $Doctor -and -not $Stats -and -not $PSBoundParameters.ContainsKey('ProbeFile') -and -not $DryRun -and -not $Logs -and -not $Health) {
    if ($env:DEEPCLAUDE_DEFAULT_BACKEND) {
        $AllSpecs = @($env:DEEPCLAUDE_DEFAULT_BACKEND)
    } elseif ($env:CHEAPCLAUDE_DEFAULT_BACKEND) {
        $AllSpecs = @($env:CHEAPCLAUDE_DEFAULT_BACKEND)
    } else {
        Write-Host "  WARNING: No config specified and DEEPCLAUDE_DEFAULT_BACKEND not set. Defaulting to 'ds'." -ForegroundColor Yellow
        Write-Host "  Set `$env:DEEPCLAUDE_DEFAULT_BACKEND to your preferred config to suppress this warning." -ForegroundColor DarkGray
        $AllSpecs = @("ds")
    }
}

# Propagate --log-all to the proxy via environment variable
if ($LogAll) { $env:DEEPCLAUDE_LOG_ALL_REQUESTS = 'true' }
if ($SkipStartupCheck) { $env:DEEPCLAUDE_SKIP_STARTUP_CHECK = 'true' }

# --- API Keys ---
# Load from process env (inherited from parent shell) or fall back to
# Windows registry (set via setx).  Push every found key into $env: so
# child processes (proxy, claude) inherit them — no silent reg fallback
# needed downstream.
$ApiKeyNames = @(
    "DEEPSEEK_API_KEY",
    "OPENROUTER_API_KEY",
    "FIREWORKS_API_KEY",
    "OPENCODE_API_KEY",
    "ALIBABA_DASHSCOPE_API_KEY",
    "KIMI_API_KEY",
    "MIMO_API_KEY",
    "UMANS_API_KEY",
    "GROQ_API_KEY",
    "MISTRAL_API_KEY",
    "MINIMAX_API_KEY",
    "ZAI_API_KEY",
    "BYTEPLUS_API_KEY",
    "SILICONFLOW_API_KEY",
    "NOVITA_API_KEY",
    "ANTHROPIC_API_KEY"
)
$ApiKeys = @{}
foreach ($kn in $ApiKeyNames) {
    $val = (Get-Item "Env:\$kn" -ErrorAction SilentlyContinue).Value
    if (-not $val) { $val = [Environment]::GetEnvironmentVariable($kn, "User") }
    if ($val) { Set-Content "Env:\$kn" $val; $ApiKeys[$kn] = $val }
    else      { $ApiKeys[$kn] = $null }
}
$DeepSeekKey    = $ApiKeys["DEEPSEEK_API_KEY"]
$OpenRouterKey  = $ApiKeys["OPENROUTER_API_KEY"]
$FireworksKey   = $ApiKeys["FIREWORKS_API_KEY"]
$OpenCodeKey    = $ApiKeys["OPENCODE_API_KEY"]
$AlibabaKey     = $ApiKeys["ALIBABA_DASHSCOPE_API_KEY"]
$KimiKey        = $ApiKeys["KIMI_API_KEY"]
$MimoKey        = $ApiKeys["MIMO_API_KEY"]
$UmansKey       = $ApiKeys["UMANS_API_KEY"]
$GroqKey        = $ApiKeys["GROQ_API_KEY"]
$MistralKey     = $ApiKeys["MISTRAL_API_KEY"]
$MiniMaxKey     = $ApiKeys["MINIMAX_API_KEY"]
$ZaiKey         = $ApiKeys["ZAI_API_KEY"]
$BytePlusKey    = $ApiKeys["BYTEPLUS_API_KEY"]
$SiliconFlowKey = $ApiKeys["SILICONFLOW_API_KEY"]
$NovitaKey      = $ApiKeys["NOVITA_API_KEY"]
$AnthropicKey   = $ApiKeys["ANTHROPIC_API_KEY"]

# Set env vars only for providers in the active config
function Set-UsedProviderEnv {
    param($resolved)
    if (-not $resolved) { return }
    foreach ($kv in $resolved.providers.GetEnumerator()) {
        Set-Content "Env:$($kv.Value.keyName)" -Value $kv.Value.key
    }
    # Also push env vars for fallback providers not in the active config,
    # so the proxy child process inherits all available keys
    foreach ($p in $Providers.Values) {
        if ($p.key) {
            Set-Content "Env:$($p.keyName)" -Value $p.key
        }
    }
}

function Clear-AnthropicEnv {
    foreach ($v in @("ANTHROPIC_BASE_URL","ANTHROPIC_AUTH_TOKEN","ANTHROPIC_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL","ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL","CLAUDE_CODE_SUBAGENT_MODEL",
        "ANTHROPIC_API_KEY","CLAUDE_CODE_AUTO_COMPACT_WINDOW",
        "CLAUDE_CODE_MAX_CONTEXT_TOKENS","CLAUDE_CONTEXT_COMPRESSION","DISABLE_COMPACT")) {
        Remove-Item "Env:$v" -ErrorAction SilentlyContinue
    }
}

# --- Slot overrides (sentinel key system) ---
function Write-ThinkingOverrides {
    # Build thinking overrides JSON from --no-thinking / --thinking-budget flags.
    # Delegate to launcher.mjs for the actual logic
    $argsList = @("thinking-overrides")
    if ($NoThinking) { $argsList += "--no-thinking" }
    if ($ThinkingBudget -gt 0) { $argsList += "--budget=$ThinkingBudget" } else { $argsList += "--budget=0" }
    $result = Invoke-LauncherMjs $argsList | ConvertFrom-Json
    if ($result.messages) {
        foreach ($msg in $result.messages) {
            Write-Host "  $msg" -ForegroundColor $(
                if ($msg -match 'DISABLED') { 'Yellow' } else { 'Cyan' }
            )
        }
    }
}

# Initialize-SlotOverrides removed — superseded by proxy/launcher.mjs init-overrides

# --- Persistent proxy state management ---
function Get-ProxyState {
    if (-not (Test-Path $ProxyStateFile)) { return $null }
    try {
        $state = Get-Content $ProxyStateFile -Raw | ConvertFrom-Json
        $proc = Get-Process -Id $state.pid -ErrorAction SilentlyContinue
        if (-not $proc) { Clear-ProxyState; return $null }
        $tcp = [System.Net.Sockets.TcpClient]::new()
        $connect = $tcp.BeginConnect("127.0.0.1", $state.port, $null, $null)
        $connected = $connect.AsyncWaitHandle.WaitOne(500, $false)
        if (-not $connected -or -not $tcp.Connected) { $tcp.Close(); Clear-ProxyState; return $null }
        $tcp.Close()
        return $state
    } catch { Clear-ProxyState; return $null }
}

function Save-ProxyState {
    param([int]$ProcessId, [int]$Port, [string]$RoutesFile)
    $state = @{
        pid        = $ProcessId
        port       = $Port
        routesFile = $RoutesFile
        startedAt  = (Get-Date).ToString("o")
    } | ConvertTo-Json
    Set-Content -Path $ProxyStateFile -Value $state -NoNewline
}

function Clear-ProxyState {
    Remove-Item $ProxyStateFile -ErrorAction SilentlyContinue
}

function Test-ContextLengthError($msg) {
    if ($msg -match "maximum context length") {
        Write-Host "`nERROR: Context window exceeded. Consider enabling context compression (add 'contextCompression: true' to ~/.claude/settings.json) or reducing input size." -ForegroundColor Red
    }
}

function Write-AtomicFile($path, $json) {
    try {
        # Advisory file lock to prevent concurrent sessions from corrupting
        # state files (slot-overrides.json, current-routes.json, etc.)
        $lockFile = $path + ".lock"
        $maxRetries = 10
        for ($retry = 0; $retry -lt $maxRetries; $retry++) {
            try {
                if (Test-Path $lockFile) {
                    $lockContent = Get-Content $lockFile -Raw -ErrorAction SilentlyContinue
                    $lockPid = 0
                    if ($lockContent -match 'pid=(\d+)') { $lockPid = [int]$Matches[1] }
                    # Check if locking PID is still alive on this system
                    $stale = $true
                    if ($lockPid -gt 0) {
                        try { $proc = Get-Process -Id $lockPid -ErrorAction Stop; $stale = $false } catch { $stale = $true }
                    }
                    if ($stale) { Remove-Item $lockFile -Force -ErrorAction SilentlyContinue }
                    else { Start-Sleep -Milliseconds 50; continue }
                }
                "pid=$PID`nts=$(Get-Date -Format o)" | Out-File $lockFile -Encoding utf8 -NoNewline
                break
            } catch { Start-Sleep -Milliseconds 50 }
        }
        $tmpFile = $path + ".tmp"
        [System.IO.File]::WriteAllText($tmpFile, $json)
        # Use .NET Move with overwrite to avoid the Remove-Item→Move-Item race
        # window where the file doesn't exist (hot-reload sees ENOENT).
        [System.IO.File]::Move($tmpFile, $path, $true)
        Remove-Item $lockFile -Force -ErrorAction SilentlyContinue
        # Restrict permissions on Unix — state files contain route/provider config
        if ($IsLinux -or $IsMacOS) {
            try { chmod 600 $path 2>$null } catch {}
        }
    } catch {
        try { Remove-Item ($path + ".lock") -Force -ErrorAction SilentlyContinue } catch {}
        Write-Host "  WARNING: Failed to write $path : $_" -ForegroundColor Yellow
    }
}

function Stop-PersistentProxy {
    [CmdletBinding(SupportsShouldProcess)]
    param()
    $state = Get-ProxyState
    if (-not $state) {
        Write-Host "  No persistent proxy is running." -ForegroundColor Yellow
        return
    }
    if ($PSCmdlet.ShouldProcess("proxy on port $($state.port)", "Stop")) {
        try {
            $proc = Get-Process -Id $state.pid -ErrorAction Stop
            $proc.Kill()
            $proc.Dispose()
        } catch { $null = $_ }
        Clear-ProxyState
        Write-Host "  Proxy stopped." -ForegroundColor Green
    }
}

# --- Provider Registry (loaded from providers.json) ---
$ScriptRoot = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$Registry = Get-Content (Join-Path $ScriptRoot "proxy\providers.json") -Raw | ConvertFrom-Json

# Key lookup — resolves keys loaded above from env vars (kept for backward compat)
$keyLookup = @{
    ds = $DeepSeekKey; or = $OpenRouterKey; fw = $FireworksKey
    oc = $OpenCodeKey; al = $AlibabaKey; km = $KimiKey
    mm = $MimoKey; um = $UmansKey; gr = $GroqKey
    mt = $MistralKey; mx = $MiniMaxKey; za = $ZaiKey
    bp = $BytePlusKey; sf = $SiliconFlowKey; nv = $NovitaKey
    an = $AnthropicKey
}

$Providers = @{}
foreach ($prop in $Registry.providers.PSObject.Properties) {
    $pk = $prop.Name
    $def = $prop.Value
    $entry = @{
        name    = $def.displayName
        url     = $def.endpoint
        key     = $keyLookup[$pk]
        keyName = $def.keyEnv
        auth    = $def.authHeader
        format  = $def.wireFormat
    }
    if ($def.fallback) { $entry.fallback = $def.fallback }
    if ($def.extraHeaders) { $entry.extraHeaders = $def.extraHeaders }
    if ($def.streamUsageReporting) { $entry.streamUsageReporting = $def.streamUsageReporting }
    $Providers[$pk] = $entry
}

# --- Per-model context window limits (tokens, from providers.json) ---
$ModelCtx = @{}
foreach ($prop in $Registry.contextLimits.PSObject.Properties) {
    $ModelCtx[$prop.Name] = [int]$prop.Value
}

# --- Per-model compaction window (tokens, from providers.json) ---
# If a model has a compactionWindow, use it. Otherwise fall back to contextLimits.
# DeepSeek models use 950K to push compaction near the context wall — compaction
# rewrites history, invalidating the disk cache prefix (cache miss = 50x more expensive).
$CompactionWindow = @{}
if ($Registry.compactionWindow) {
    foreach ($prop in $Registry.compactionWindow.PSObject.Properties) {
        if ($prop.Name.StartsWith('_')) { continue }
        $CompactionWindow[$prop.Name] = [int]$prop.Value
    }
}

# --- Configuration Registry (from providers.json) ---
# Each config maps model slots to "providerKey:modelId"
$Configs = [ordered]@{}
foreach ($prop in $Registry.configs.PSObject.Properties) {
    $cfg = $prop.Value
    $Configs[$prop.Name] = @{
        name     = $cfg.name
        opus     = $cfg.opus
        sonnet   = $cfg.sonnet
        haiku    = $cfg.haiku
        subagent = $cfg.sub
        fable    = $cfg.fable
    }
}

# --- Resolve a config into runtime format ---
function Resolve-Config($configName) {
    $config = $Configs[$configName]
    if (-not $config) { throw "Unknown config '$configName'. Known: $($Configs.Keys -join ', ')" }

    $resolved = @{
        name         = $config.name
        slots        = @{}
        modelProviders = @{}  # modelId -> providerKey
        providers    = @{}    # providerKey -> providerInfo
        defaultProvider = $null
    }

    foreach ($slot in @("opus","sonnet","haiku","subagent","fable")) {
        $val = $config[$slot]
        if ($val -match '^(.+?):(.+)$') {
            $provKey = $Matches[1]
            $modelId = $Matches[2]
            $provider = $Providers[$provKey]
            if (-not $provider) { Write-Host "ERROR: Unknown provider '$provKey' in config '$configName' slot '$slot'" -ForegroundColor Red; exit 1 }
            if (-not $provider.key) {
                Write-Host "  Get a key from your provider's dashboard." -ForegroundColor DarkGray
                Write-Host "  Then: setx $($provider.keyName) `"sk-...`"" -ForegroundColor DarkGray
                Write-Host "ERROR: $($provider.keyName) not set (needed by config '$configName')" -ForegroundColor Red
                exit 1
            }
            $resolved.slots[$slot] = @{ model = $modelId; provider = $provKey }
            $resolved.modelProviders[$modelId] = $provKey
            $resolved.providers[$provKey] = $provider
        } else {
            Write-Host "ERROR: Invalid model spec in config '$configName' slot '$slot': expected 'providerKey:modelId', got '$val'" -ForegroundColor Red
            exit 1
        }
    }

    # Default provider = provider of the opus slot
    $resolved.defaultProvider = $resolved.slots["opus"].provider
    $resolved.isMultiProvider = ($resolved.providers.Count -gt 1)

    return $resolved
}

# --- Build ad-hoc config from positional "providerKey:modelId" specs ---
function Build-AdHocConfig($specs) {
    $slots = @("opus", "sonnet", "haiku", "subagent", "fable")
    $config = @{
        name = ""
        slots = @{}
        modelProviders = @{}
        providers = @{}
        defaultProvider = $null
        isMultiProvider = $false
    }

    for ($i = 0; $i -lt 5; $i++) {
        # Map slot index -> spec index based on spec count:
        #   1 spec:  [0, 0, 0, 0, 0]     all same
        #   2 specs: [0, 0, 0, 1, 1]     first 3 / last 2
        #   3 specs: [0, 1, 1, 2, 2]     opus, rest second, sub/fable third
        #   4 specs: [0, 1, 2, 3, 3]     sub/fable share last
        #   5 specs: [0, 1, 2, 3, 4]     direct mapping
        $idx = switch ($specs.Count) {
            1 { 0 }
            2 { if ($i -lt 3) { 0 } else { 1 } }
            3 { if ($i -eq 0) { 0 } elseif ($i -le 2) { 1 } else { 2 } }
            4 { if ($i -lt 3) { $i } else { 3 } }
            default { $i }
        }
        $spec = $specs[$idx]

        if ($spec -match '^(.+?):(.+)$') {
            $provKey = $Matches[1]
            $modelId = $Matches[2]
        } else {
            throw "Invalid model spec '$spec': expected providerKey:modelId format (e.g. ds:deepseek-v4-pro)"
        }

        $provider = $Providers[$provKey]
        if (-not $provider) { throw "Unknown provider '$provKey' in spec '$spec'. Known: $($Providers.Keys -join ', ')" }
        if (-not $provider.key) {
            Write-Host "  Get a key from your provider's dashboard." -ForegroundColor DarkGray
            Write-Host "  Then: setx $($provider.keyName) `"sk-...`"" -ForegroundColor DarkGray
            throw "$($provider.keyName) not set (needed for spec '$spec')"
        }

        $slot = $slots[$i]
        $config.slots[$slot] = @{ model = $modelId; provider = $provKey }
        $config.modelProviders[$modelId] = $provKey
        $config.providers[$provKey] = $provider
    }

    $config.defaultProvider = $config.slots["opus"].provider
    $config.isMultiProvider = ($config.providers.Count -gt 1)

    # Build display name from specs
    $parts = foreach ($s in $specs) {
        if ($s -match '^(.+?):(.+)$') { "$($Matches[2]) ($($Providers[$Matches[1]].name))" }
    }
    $config.name = "Ad-hoc: " + ($parts -join " | ")

    return $config
}

# Build-RoutesJson removed — superseded by proxy/launcher.mjs build-routes

# --- Standalone AV fix batch file ---
# Written on every launch to ~/.deepclaude/fix-av.cmd.  This survives
# Windows Defender quarantine because AV only targets executable content in
# the proxy directory, not plain-text files in the user's home directory.
# If deepclaude gets deleted, the user can still run this file as admin to
# add the exclusion and then re-clone/re-install.
function Write-FixAvBatch {
    $myPath = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
    $proxyDir = Join-Path $myPath "proxy"
    $nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
    if (-not $nodeExe) { $nodeExe = "node.exe" }

    $batch = @"
@echo off
REM ================================================================
REM  deepclaude — Windows Defender Exclusion Helper
REM  Run this as ADMINISTRATOR if the proxy was blocked or deleted.
REM ================================================================
echo.
echo  This script adds Windows Defender exclusions for deepclaude.
echo  Run it in an ADMIN PowerShell window, OR simply paste the
echo  commands below into an admin PowerShell yourself:
echo.
echo  ----- Copy from here -----
echo  Add-MpPreference -ExclusionPath "$proxyDir"
echo  Add-MpPreference -ExclusionProcess "$nodeExe"
echo  ----- End copy ---------
echo.
echo  After adding exclusions, re-install deepclaude (git pull / npm install)
echo  if files were quarantined, then relaunch.
echo.
powershell -Command "Add-MpPreference -ExclusionPath '$proxyDir'; Add-MpPreference -ExclusionProcess '$nodeExe'; Write-Host 'Exclusions added.' -ForegroundColor Green"
pause
"@
    try {
        Set-Content -Path $FixAvBatchFile -Value $batch -NoNewline
    } catch {
        # Disk full or permissions — non-fatal
    }
}

# --- Start the HTTP routing proxy (delegates to proxy/start-proxy.js) ---
function Show-ProxyWarning {
    # On Windows, Defender may quarantine the proxy script before it starts.
    # This is a catch-22: if the proxy is deleted, you can't run --fix-av.
    # We proactively write a standalone fix-av.cmd to ~/.deepclaude/ that
    # survives quarantine (AV only targets executable paths, not text files
    # in the user's home directory).
    Write-Host "`n  ==============================================================================" -ForegroundColor Yellow
    Write-Host "  WINDOWS DEFENDER MAY BLOCK THE PROXY." -ForegroundColor Yellow
    Write-Host "  If the proxy fails to start or gets deleted, open an ADMIN PowerShell and run:" -ForegroundColor Yellow
    Write-Host "    $FixAvBatchFile" -ForegroundColor White
    Write-Host "  (That file was just written to your home dir — it survives AV deletion.)" -ForegroundColor DarkGray
    Write-Host "  ==============================================================================`n" -ForegroundColor Yellow
    Write-FixAvBatch
}

function Start-RoutingProxy {
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [string]$RoutesFile,
        [switch]$Persist
    )

    $PSCmdlet.ShouldProcess("127.0.0.1", "Start routing proxy") | Out-Null

    $myDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
    $proxyScript = Join-Path $myDir "proxy\start-proxy.ts"

    if (-not (Test-Path $proxyScript)) {
        throw "Proxy script not found at: $proxyScript"
    }

    $outFile = if ($Persist) {
        Join-Path $DeepClaudeDir "proxy-startup.txt"
    } else {
        Join-Path $env:TEMP "deepclaude-proxy-$([System.Guid]::NewGuid()).out"
    }
    $errFile = Join-Path $env:TEMP "deepclaude-proxy-$([System.Guid]::NewGuid()).err"

    $nodePath = try { (Get-Command node -ErrorAction Stop).Source } catch {
        throw "Node.js is not installed or not in PATH. Install Node.js from https://nodejs.org and ensure it's in your PATH."
    }

    $tsxBin = Join-Path $myDir "node_modules\.bin\tsx.cmd"
    if (-not (Test-Path $tsxBin)) {
        throw "Dependencies not installed. Run 'npm install' in '$myDir' first."
    }
    $proc = Start-Process -FilePath $tsxBin `
        -ArgumentList ($proxyScript, '--routes', $RoutesFile, '--overrides', $SlotOverridesFile, '--providers', (Join-Path $myDir 'proxy\providers.json'), '--thinking-overrides', $ThinkingOverridesFile) `
        -NoNewWindow `
        -RedirectStandardOutput $outFile `
        -RedirectStandardError $errFile `
        -PassThru

    # Wait for port output
    Write-Host -NoNewline "Starting proxy"
    $waited = 0
    $port = $null
    while (((-not (Test-Path $outFile)) -or (Get-Item $outFile).Length -eq 0) -and $waited -lt 150) {
        Write-Host -NoNewline "."
        Start-Sleep -Milliseconds 100
        $waited++
    }
    Write-Host ""

    $portStr = Get-Content $outFile -Raw
    if (-not $Persist) {
        Remove-Item $outFile -ErrorAction SilentlyContinue
    }

    if ($portStr -match 'PORT:(\d+)') {
        $port = [int]$Matches[1]
        Remove-Item $errFile -ErrorAction SilentlyContinue
    } else {
        $errStr = if (Test-Path $errFile) { Get-Content $errFile -Raw } else { '' }
        Remove-Item $errFile -ErrorAction SilentlyContinue
        if (-not $proc.HasExited) { try { $proc.Kill() } catch { $null = $_ } }
        $proc.Dispose()

        # If another proxy is already running, try to reuse it
        if ($errStr -match 'already running.*PID (\d+)') {
            $existingPid = [int]$Matches[1]
            $existingState = Get-ProxyState
            if ($existingState -and $existingState.pid -eq $existingPid) {
                Write-Host "  Reusing existing proxy on port $($existingState.port) (PID $existingPid)" -ForegroundColor DarkGray
                return @{ Port = $existingState.port; Process = $null; Persist = $true }
            }
            # Validate via Get-ProxyState which checks PID aliveness + TCP connect.
            $existingState = Get-ProxyState
            if ($existingState) {
                Write-Host "  Reusing existing proxy on port $($existingState.port) (PID $($existingState.pid))" -ForegroundColor DarkGray
                return @{ Port = $existingState.port; Process = $null; Persist = $true }
            }
            # PID file is stale — remove it
            $pidFile = Join-Path $DeepClaudeDir "proxy.pid"
            Remove-Item $pidFile -ErrorAction SilentlyContinue
        }

        throw "Proxy failed to start. Output: '$portStr' Stderr: '$errStr'"
    }

    # Verify proxy is actually responding
    try {
        $null = Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -TimeoutSec 3
    } catch {
        Write-Host "WARNING: Proxy port $port is not responding. Windows Defender may have blocked it." -ForegroundColor Yellow
        Write-Host "Run this in an admin PowerShell: $FixAvBatchFile" -ForegroundColor White
        Write-Host "(That file survives AV deletion of the deepclaude directory.)" -ForegroundColor DarkGray
    }

    return @{ Port = $port; Process = $proc; Persist = $Persist.IsPresent }
}

function Stop-RoutingProxy {
    [CmdletBinding(SupportsShouldProcess)]
    param($proxyInfo)
    $PSCmdlet.ShouldProcess("127.0.0.1", "Stop routing proxy") | Out-Null
    if (-not $proxyInfo) { return }
    if ($proxyInfo.Persist) {
        Write-Host "  Proxy is persistent (port $($proxyInfo.Port)). Use 'deepclaude --stop-proxy' to stop it." -ForegroundColor DarkGray
        return
    }
    if ($proxyInfo.Process) {
        try {
            if (-not $proxyInfo.Process.HasExited) { $proxyInfo.Process.Kill() }
            $proxyInfo.Process.Dispose()
        } catch { $null = $_ }
    }
}

function Start-Watchdog {
    param($ProxyProcess, $ProxyPort, $StateFile, $MaxRestarts, [switch]$Persist)
    return Start-Job -Name "DeepClaudeWatchdog" -ScriptBlock {
        param($Pid, $Port, $StateFile, $MaxRestarts, $Persist)
        $pollMs = 5000
        $restartCount = 0
        while ($true) {
            Start-Sleep -Milliseconds $pollMs
            $procAlive = Get-Process -Id $Pid -ErrorAction SilentlyContinue
            if (-not $procAlive) {
                if (-not (Test-Path $StateFile)) {
                    Write-Host "Proxy (PID $Pid) exited and state file is gone. Watchdog exiting." -ForegroundColor DarkGray
                    return
                }
                $restartCount++
                if ($restartCount -gt $MaxRestarts) {
                    Write-Host "ERROR: Proxy restarted $MaxRestarts times. Watchdog giving up." -ForegroundColor Red
                    return
                }
                Write-Host "Proxy (PID $Pid) is no longer running. Restarting (attempt $restartCount of $MaxRestarts)..." -ForegroundColor Yellow
                Start-Sleep -Seconds 2
                try {
                    $newProxy = Start-RoutingProxy -RoutesFile $using:CurrentRoutesFile -Persist:$Persist
                    if ($newProxy -and $newProxy.Process) {
                        Save-ProxyState -ProcessId $newProxy.Process.Id -Port $newProxy.Port -RoutesFile $using:CurrentRoutesFile
                        $Pid = $newProxy.Process.Id
                        Write-Host "Proxy restarted on port $($newProxy.Port) (new PID $($newProxy.Process.Id))." -ForegroundColor Green
                    }
                } catch {
                    Write-Host "  Failed to restart proxy: $_" -ForegroundColor Red
                    Start-Sleep -Seconds 10
                }
            }
        }
    } -ArgumentList $ProxyProcess.Id, $ProxyPort, $StateFile, $MaxRestarts, $Persist.IsPresent
}

function Get-KeyDisplay($k) {
    if (-not $k) { return "MISSING" }
    return "set (****" + $k.Substring($k.Length - [Math]::Min(4, $k.Length)) + ")"
}

# --- Status ---
if ($Status) {
    Write-Host "`n  deepclaude - Backend Status" -ForegroundColor Cyan
    Write-Host "  ============================" -ForegroundColor DarkGray
    Write-Host "`n  Keys:" -ForegroundColor Yellow
    Write-Host "    DEEPSEEK_API_KEY:           $(Get-KeyDisplay $DeepSeekKey)"
    Write-Host "    OPENROUTER_API_KEY:         $(Get-KeyDisplay $OpenRouterKey)"
    Write-Host "    FIREWORKS_API_KEY:          $(Get-KeyDisplay $FireworksKey)"
    Write-Host "    OPENCODE_API_KEY:           $(Get-KeyDisplay $OpenCodeKey)"
    Write-Host "    ALIBABA_DASHSCOPE_API_KEY:  $(Get-KeyDisplay $AlibabaKey)"
    Write-Host "    KIMI_API_KEY:               $(Get-KeyDisplay $KimiKey)"
    Write-Host "    MIMO_API_KEY:               $(Get-KeyDisplay $MimoKey)"
    Write-Host "    UMANS_API_KEY:              $(Get-KeyDisplay $UmansKey)"
    Write-Host "    GROQ_API_KEY:               $(Get-KeyDisplay $GroqKey)"
    Write-Host "    MISTRAL_API_KEY:            $(Get-KeyDisplay $MistralKey)"
    Write-Host "    MINIMAX_API_KEY:            $(Get-KeyDisplay $MiniMaxKey)"
    Write-Host "    ZAI_API_KEY:                $(Get-KeyDisplay $ZaiKey)"
    Write-Host "    BYTEPLUS_API_KEY:           $(Get-KeyDisplay $BytePlusKey)"
    Write-Host "    SILICONFLOW_API_KEY:        $(Get-KeyDisplay $SiliconFlowKey)"
    Write-Host "    NOVITA_API_KEY:             $(Get-KeyDisplay $NovitaKey)"
    Write-Host "    ANTHROPIC_API_KEY:          $(Get-KeyDisplay $AnthropicKey)"
    Write-Host "`n  Configurations:" -ForegroundColor Yellow
    foreach ($kv in $Configs.GetEnumerator()) {
        $label = if ($kv.Key -eq "ds") { " (default)" } else { "" }
        $provKeys = @()
        foreach ($s in @("opus","sonnet","haiku","subagent","fable")) {
            $val = $kv.Value[$s]
            if ($val -match '^(.+?):') { $pk = $Matches[1]; if ($pk -notin $provKeys) { $provKeys += $pk } }
        }
        $provNames = ($provKeys | ForEach-Object { $Providers[$_].name }) -join " + "
        Write-Host "    $($kv.Key.PadRight(10)) $($kv.Value.name)$label  [$provNames]"
    }
    # Show active slot overrides
    if (Test-Path $SlotOverridesFile) {
        try {
            $overrides = Get-Content $SlotOverridesFile -Raw | ConvertFrom-Json
            $slots = @("opus","sonnet","haiku","subagent","fable")
            $slotLines = foreach ($s in $slots) {
                $val = if ($overrides.$s) { $overrides.$s } elseif ($overrides._defaults.$s) { $overrides._defaults.$s } else { "—" }
                $pk = ($val -split ':')[0]
                $pname = if ($pk -and $Providers[$pk]) { $Providers[$pk].name } else { $null }
                if ($pname) {
                    "    $($s.PadRight(10)) $val  ->  $pname"
                } else {
                    "    $($s.PadRight(10)) $val"
                }
            }
            Write-Host "`n  Active slot mapping:" -ForegroundColor Yellow
            Write-Host ($slotLines -join "`n")
            $activeKeys = $overrides.PSObject.Properties.Name | Where-Object { $_ -ne '_defaults' }
            if ($activeKeys) {
                Write-Host "`n  Custom overrides: $($activeKeys -join ', ')" -ForegroundColor DarkGray
            }
        } catch { $null = $_ }
    }
    Write-Host ""
    exit 0
}

# --- Stats ---
if ($Stats) {
    Write-Host "`n  deepclaude - Proxy Stats" -ForegroundColor Cyan
    Write-Host "  ===========================" -ForegroundColor DarkGray

    if (-not (Test-Path $ProxyStateFile)) {
        Write-Host "`n  No proxy running. Start a proxy first with any backend." -ForegroundColor Yellow
        Write-Host ""
        exit 0
    }

    try {
        $state = Get-Content $ProxyStateFile -Raw | ConvertFrom-Json
        $port = $state.port
        $pid = $state.pid

        $procAlive = try { (Get-Process -Id $pid -ErrorAction Stop) -ne $null } catch { $false }
        if (-not $procAlive) {
            Write-Host "  Proxy process (PID $pid) is no longer running." -ForegroundColor Red
            Write-Host "  Removing stale state file..." -ForegroundColor DarkGray
            Remove-Item $ProxyStateFile -Force
            exit 1
        }

        $health = Invoke-RestMethod -Uri "http://127.0.0.1:${port}/health" -TimeoutSec 5

        Write-Host "`n  Proxy: 127.0.0.1:$port (PID $pid)" -ForegroundColor Green
        Write-Host "  Uptime: $([math]::Round($health.uptime / 1000))s"
        Write-Host ""

        $providers = $health.providers
        if ($providers.PSObject.Properties.Count -eq 0) {
            Write-Host "  No requests recorded yet." -ForegroundColor DarkGray
        } else {
            Write-Host "  Provider    Req  OK  Fail   Rate  Cache  AvgTime" -ForegroundColor Yellow
            Write-Host "  ----------  ---  --- -----  -----  -----  -------"
            foreach ($prop in ($providers.PSObject.Properties | Sort-Object Name)) {
                $k = $prop.Name
                $v = $prop.Value
                $rate = if ($v.requests -gt 0) { "{0:P0}" -f ($v.successes / $v.requests) } else { "—" }
                $avg = if ($v.avgMs -gt 0) { "$($v.avgMs)ms" } else { "—" }
                $cacheStr = if ($v.cacheHitRate) { "$($v.cacheHitRate)%" } else { "—" }
                $healthIcon = if ($v.fails -eq 0) { "●" } elseif ($v.requests -lt 3) { "○" } elseif ($v.fails / $v.requests -lt 0.5) { "●" } else { "◐" }
                $color = if ($v.fails -eq 0) { "Green" } elseif ($v.requests -lt 3) { "DarkGray" } elseif ($v.fails / $v.requests -lt 0.25) { "Green" } elseif ($v.fails / $v.requests -lt 0.5) { "Yellow" } else { "Red" }
                Write-Host ("  {0,-3} {1,-8}  {2,3}  {3,3} {4,5}  {5,5}  {6,5}  {7,5}" -f $healthIcon,
                    ($k.PadRight(8)), $v.requests, $v.successes, $v.fails, $rate, $cacheStr, $avg) -ForegroundColor $color
            }
            Write-Host ""
            Write-Host "  ● healthy  ○ new/unknown  ◐ degraded (>50% failures)" -ForegroundColor DarkGray
            Write-Host "  Cache: KV disk cache hit % (DeepSeek: 98%+ typical)" -ForegroundColor DarkGray
        }
    } catch {
        Write-Host "  Failed to reach proxy:" $_.Exception.Message -ForegroundColor Red
        exit 1
    }
    Write-Host ""
    exit 0
}

# --- Probe ---
if ($PSBoundParameters.ContainsKey('ProbeFile')) {
    $myDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
    $tsxBin = Join-Path $myDir "node_modules\.bin\tsx.cmd"
    $proxyScript = Join-Path $myDir "proxy\start-proxy.ts"

    if ($ProbeFile) {
        $routesFile = $ProbeFile
    } else {
        # Build routes from current config
        if ($AllSpecs.Count -eq 1 -and $Configs.Contains($AllSpecs[0])) {
            $r = Resolve-Config $AllSpecs[0]
        } elseif ($AllSpecs.Count -eq 1 -and $AllSpecs[0] -notmatch '^[a-z][a-z0-9_-]*:.+$') {
                        [Console]::Error.WriteLine("ERROR: Unknown config '$($AllSpecs[0])'. Known: $($Configs.Keys -join ', ')")
                        [Console]::Error.WriteLine("  To specify models directly, use providerKey:modelId format (e.g. ds:deepseek-v4-pro)")
            exit 1
        } elseif ($AllSpecs.Count -gt 0) {
            $r = Build-AdHocConfig $AllSpecs
        } else {
            $defaultCfg = if ($env:DEEPCLAUDE_DEFAULT_BACKEND) { $env:DEEPCLAUDE_DEFAULT_BACKEND } elseif ($env:CHEAPCLAUDE_DEFAULT_BACKEND) { $env:CHEAPCLAUDE_DEFAULT_BACKEND } else { "ds" }
            $r = Resolve-Config $defaultCfg
        }
        Set-UsedProviderEnv $r
        if ($AllSpecs.Count -eq 1 -and $Configs.Contains($AllSpecs[0])) {
            $routesJson = Invoke-LauncherMjs "build-routes", "--name=$($AllSpecs[0])"
        } else {
            $routesJson = Invoke-LauncherMjs "build-routes", "--specs=$($AllSpecs -join ',')"
        }
        $routesFile = Join-Path $DeepClaudeDir "probe-routes.json"
        Write-AtomicFile $routesFile $routesJson
    }
    & $tsxBin $proxyScript --probe $routesFile
    exit $LASTEXITCODE
}

# --- Dry Run ---
if ($DryRun) {
    $myDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
    $tsxBin = Join-Path $myDir "node_modules\.bin\tsx.cmd"
    $proxyScript = Join-Path $myDir "proxy\start-proxy.ts"

    if ($AllSpecs.Count -eq 1 -and $Configs.Contains($AllSpecs[0])) {
        $r = Resolve-Config $AllSpecs[0]
        $routesJson = Invoke-LauncherMjs "build-routes", "--name=$($AllSpecs[0])"
    } elseif ($AllSpecs.Count -eq 1 -and $AllSpecs[0] -notmatch '^[a-z][a-z0-9_-]*:.+$') {
        # Single arg that isn't a known config and isn't a valid model spec
                    [Console]::Error.WriteLine("ERROR: Unknown config '$($AllSpecs[0])'. Known: $($Configs.Keys -join ', ')")
                    [Console]::Error.WriteLine("  To specify models directly, use providerKey:modelId format (e.g. ds:deepseek-v4-pro)")
        exit 1
    } elseif ($AllSpecs.Count -gt 0) {
        $r = Build-AdHocConfig $AllSpecs
        $routesJson = Invoke-LauncherMjs "build-routes", "--specs=$($AllSpecs -join ',')"
    } else {
        $defaultCfg = if ($env:DEEPCLAUDE_DEFAULT_BACKEND) { $env:DEEPCLAUDE_DEFAULT_BACKEND } elseif ($env:CHEAPCLAUDE_DEFAULT_BACKEND) { $env:CHEAPCLAUDE_DEFAULT_BACKEND } else { "ds" }
        $r = Resolve-Config $defaultCfg
        $routesJson = Invoke-LauncherMjs "build-routes", "--name=$defaultCfg"
    }
    Set-UsedProviderEnv $r
    $routesFile = Join-Path $DeepClaudeDir "dryrun-routes.json"
    Write-AtomicFile $routesFile $routesJson
    & $tsxBin $proxyScript --dry-run $routesFile
    exit $LASTEXITCODE
}

# --- Cost ---
if ($Cost) {
    Write-Host "`n  Model Pricing (per million tokens)" -ForegroundColor Cyan
    Write-Host "  ===================================" -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "  Model                                      Input/M     CacheHit/M  CacheMiss/M  Output/M" -ForegroundColor Yellow
    Write-Host "  ---------------                            --------    ----------  -----------  --------"
    $costData = $Registry.pricing
    if ($costData) {
        foreach ($prop in $costData.PSObject.Properties) {
            $model = $prop.Name
            if ($model.StartsWith('_')) { continue }
            $p = $prop.Value
            $inp = if (-not $p.input) { "free" } else { "`$$($p.input.ToString('F3'))" }
            $out = if (-not $p.output) { "free" } else { "`$$($p.output.ToString('F2'))" }
            $cacheHit = if ($p.input_cache_hit) { "`$$($p.input_cache_hit.ToString('F4'))" } else { "—" }
            $cacheMiss = if ($p.input_cache_miss) { "`$$($p.input_cache_miss.ToString('F3'))" } else { "—" }
            $displayName = if ($model.Length -gt 37) { $model.Substring(0, 37) } else { $model }
            Write-Host ("  {0,-37} {1,-10} {2,-10} {3,-11} {4}" -f $displayName, $inp, $cacheHit, $cacheMiss, $out) -ForegroundColor Green
        }
    } else {
        Write-Host "  (pricing data not available in providers.json)" -ForegroundColor Yellow
    }
    Write-Host ""
    Write-Host "  Data sourced from proxy/providers.json pricing section. Cache-hit pricing varies by provider." -ForegroundColor DarkGray
    Write-Host ""
    exit 0
}

# --- Help ---
if ($Help) {
    Write-Host "deepclaude - Claude Code with cheap backends (provider-agnostic)"
    Write-Host ""
    Write-Host "Usage: deepclaude [spec1] [spec2] [spec3] [spec4] [spec5]   (positional mode)"
    Write-Host "       deepclaude [-b backend] [--status] [--doctor] [--version]"
    Write-Host ""
    Write-Host "  Each positional arg is providerKey:modelId, mapping to opus/sonnet/haiku/subagent/fable."
    Write-Host "  Model aliases: sonnet, opus, haiku, v4, flash, ... (short names resolve to full model IDs)"
    Write-Host "  Fewer than 5 specs repeats the last one for remaining slots."
    Write-Host ""
    Write-Host "  Examples:"
    Write-Host "    deepclaude ds:deepseek-v4-pro ds:deepseek-v4-pro oc:big-pickle or:z-ai/glm-4.5-air:free"
    Write-Host "    deepclaude ds:deepseek-v4-pro oc:big-pickle    (opus/sonnet=DS, haiku/sub=OC)"
    Write-Host "    deepclaude ds:deepseek-v4-pro                  (all 5 slots use DS)"
    Write-Host "    deepclaude -b ds+oc                            (named mixed config)"
    Write-Host "    deepclaude -b or                               (named config)"
    Write-Host ""
    Write-Host "  Named configs: $($Configs.Keys -join ', '), anthropic"
    Write-Host "  --status        Show keys and configurations"
    Write-Host "  --stats         Show proxy request stats and health"
    Write-Host "  --cost          Pricing comparison"
    Write-Host "  --benchmark     Latency test"
    Write-Host "  --persist       Keep proxy running after CC exits (enables --switch)"
    Write-Host "  --remote        Browser-based remote control (starts proxy automatically)"
    Write-Host "  --switch CONFIG  Switch active config of a running persistent proxy"
    Write-Host "  --models        List all available models (for use with /model in CC)"
    Write-Host "  --set-slot SLOT MODEL  Override a slot's model: opus/sonnet/haiku/subagent/fable"
    Write-Host "                     e.g. --set-slot haiku or:z-ai/glm-4.5-air:free"
    Write-Host "                     e.g. --set-slot sonnet   (no model = clear override)"
    Write-Host "  --stop-proxy    Kill the persistent proxy"
    Write-Host "  --lint          Self-lint with PSScriptAnalyzer"
    Write-Host "  --lint-config   Validate providers.json configuration"
    Write-Host "  --log-all       Log all requests to ~/.deepclaude/requests.log"
    Write-Host "  --skip-startup-check  Skip the provider health check on proxy startup"
    Write-Host "  --no-thinking    Disable extended thinking for all models (save cost)"
    Write-Host "  --thinking-budget N   Set thinking budget in tokens (e.g. 64000)"
    Write-Host "  --logs, --tail   Tail the proxy log (~/.deepclaude/proxy.log)"
    Write-Host "  --health         Quick health check (one-line summary)"
    Write-Host "  --subagent-model MODEL  Set a dedicated subagent model (e.g., oc:big-pickle)"
    Write-Host "  --version       Print version and proxy path"
    Write-Host "  --effort LEVEL  Set Claude Code effort level (default: max). Values: low, medium, high, max."
    Write-Host "  --fix-av        Print AV exclusion commands"
    Write-Host "  --probe [FILE]  Test each configured provider with a minimal prompt"
    Write-Host "  --dry-run [FILE] Show resolved routing table without starting proxy"
    Write-Host "  --dashboard     Start proxy and print health dashboard URL"
    Write-Host "  --open          Open dashboard in browser (use with --dashboard)"
    Write-Host "  --doctor        Run system health check (prereqs, keys, proxy test)"
    Write-Host "  --install-statusline  Install status bar showing model, effort, context (requires restart)"
    Write-Host ""
    Write-Host "  Session switching workflow:"
    Write-Host "    1. deepclaude -b ds+oc --persist     # Start with proxy"
    Write-Host "    2. deepclaude --switch ds+oc          # Switch configs (from within CC)"
    Write-Host "    3. /model or:model-id                 # Switch opus model (in CC)"
    Write-Host "    4. deepclaude --set-slot haiku oc:big-pickle  # Switch haiku model"
    Write-Host "    5. deepclaude --stop-proxy            # Clean up when done"
    exit 0
}

# --- Version ---
if ($Version) {
    $myPath = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
    $scriptPath = Join-Path $myPath "deepclaude.ps1"
    $mtime = if (Test-Path $scriptPath) { (Get-Item $scriptPath).LastWriteTime.ToString("yyyy-MM-dd HH:mm") } else { "unknown" }

    # Read version from package.json, fallback to hardcoded default.
    $verStr = "v1.0.0"
    $pkgPath = Join-Path $myPath "package.json"
    if (Test-Path $pkgPath) {
        try { $verStr = "v" + ((Get-Content $pkgPath -Raw | ConvertFrom-Json).version) } catch {}
    }

    # Get short git hash from the repo directory.
    $gitHash = "unknown"
    try {
        $hash = git -C "$myPath" rev-parse --short HEAD 2>$null
        if ($hash) { $gitHash = $hash.Trim() }
    } catch {}

    Write-Host "deepclaude $verStr ($gitHash) ($mtime)"
    Write-Host "Proxy: $(Join-Path $myPath 'proxy\start-proxy.js')"
    exit 0
}

# --- Install Statusline ---
if ($InstallStatusline) {
    $myDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
    $sourceFile = Join-Path $myDir "statusline" "statusline.mjs"
    $claudeDir = Join-Path $HOME ".claude"
    $destFile = Join-Path $claudeDir "statusline.mjs"
    $settingsFile = Join-Path $claudeDir "settings.json"

    if (-not (Test-Path $sourceFile)) {
        Write-Host "ERROR: Statusline script not found at: $sourceFile" -ForegroundColor Red
        exit 1
    }

    # Ensure ~/.claude directory exists
    if (-not (Test-Path $claudeDir)) {
        New-Item -ItemType Directory -Path $claudeDir -Force | Out-Null
    }

    # Copy the single statusline script (Node.js, no platform wrapper needed)
    Copy-Item $sourceFile $destFile -Force
    Write-Host "  Copied statusline to: $destFile" -ForegroundColor Green

    # Read or create settings.json
    $settings = @{}
    if (Test-Path $settingsFile) {
        try {
            $raw = Get-Content $settingsFile -Raw -ErrorAction Stop
            if (-not [string]::IsNullOrWhiteSpace($raw)) {
                $settings = $raw | ConvertFrom-Json
            }
        } catch {
            Write-Host "  WARNING: Could not parse existing settings.json. Creating new one." -ForegroundColor Yellow
            $settings = @{}
        }
    }

    # Add/merge statusLine config — node runs .mjs directly, no platform wrapper needed
    $statusLineConfig = @{
        type = "command"
        command = "node `"$($destFile -replace '\\', '/')`""
    }

    if ($settings -is [PSCustomObject]) {
        $settings | Add-Member -NotePropertyName "statusLine" -NotePropertyValue $statusLineConfig -Force
    } else {
        $settings["statusLine"] = $statusLineConfig
    }

    $settings | ConvertTo-Json -Depth 5 | Set-Content -Path $settingsFile -NoNewline
    Write-Host "  Updated $settingsFile with statusLine config." -ForegroundColor Green
    Write-Host "  Statusline installed! Restart Claude Code to see the status bar." -ForegroundColor Cyan
    exit 0
}

# --- Doctor ---
if ($Doctor) {
    $myDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
    $proxyScript = Join-Path $myDir "proxy\start-proxy.ts"
    $allOk = $true
    $pass = "$([char]0x1b)[32mPASS$([char]0x1b)[0m"
    $fail = "$([char]0x1b)[31mFAIL$([char]0x1b)[0m"
    $warn = "$([char]0x1b)[33mWARN$([char]0x1b)[0m"

    Write-Host "`n  deepclaude System Check" -ForegroundColor Cyan
    Write-Host "  ======================" -ForegroundColor DarkGray

    # 1. Node.js
    Write-Host "`n  Prerequisites:" -ForegroundColor Yellow
    $nodePath = try { (Get-Command node -ErrorAction Stop).Source } catch { $null }
    if ($nodePath) {
        $nodeVer = & node -v
        Write-Host "    Node.js           $pass  $nodePath ($nodeVer)"
    } else {
        Write-Host "    Node.js           $fail  Not found in PATH. Install from https://nodejs.org"
        $allOk = $false
    }

    # 2. Proxy script
    if (Test-Path $proxyScript) {
        Write-Host "    Proxy script      $pass  $proxyScript"
    } else {
        Write-Host "    Proxy script      $fail  Not found at $proxyScript"
        $allOk = $false
    }

    # 3. State directory
    if (-not (Test-Path $DeepClaudeDir)) {
        New-Item -ItemType Directory -Path $DeepClaudeDir -Force | Out-Null
    }

    # 4. Stale .tmp files
    $staleTmps = Get-ChildItem $DeepClaudeDir -Filter "*.tmp" -ErrorAction SilentlyContinue
    if ($staleTmps) {
        Write-Host "    Stale .tmp files  $warn  $($staleTmps.Count) found (cleaned)"
        $staleTmps | Remove-Item -Force
    }

    # 5. API keys
    Write-Host "`n  API Keys:" -ForegroundColor Yellow
    $keyProviders = @("ds","or","fw","oc","an","al","km","mm","um","gr","mt","mx","za","bp","sf","nv")
    $keysOk = 0
    $keysTotal = 0
    foreach ($pk in $keyProviders) {
        $pv = $Providers[$pk]
        $keysTotal++
        if ($pv.key) {
            Write-Host "    $($pv.keyName.PadRight(28)) $pass  (****$($pv.key.Substring($pv.key.Length - [Math]::Min(4,$pv.key.Length))))"
            $keysOk++
        } else {
            Write-Host "    $($pv.keyName.PadRight(28)) $warn  Not set (provider '$pk' unavailable)"
        }
    }
    Write-Host "    $keysOk/$keysTotal keys configured"

    # 6. Slot overrides
    Write-Host "`n  Slot Overrides:" -ForegroundColor Yellow
    if (Test-Path $SlotOverridesFile) {
        try {
            $overrides = Get-Content $SlotOverridesFile -Raw | ConvertFrom-Json
            $validSlots = @("opus","sonnet","haiku","subagent","fable")
            $overrideOk = $true
            foreach ($slot in $validSlots) {
                $val = if ($overrides.$slot) { $overrides.$slot }
                       elseif ($overrides._defaults.$slot) { $overrides._defaults.$slot }
                       else { $null }
                if (-not $val) {
                    Write-Host "    $($slot.PadRight(10)) $fail  No mapping"
                    $overrideOk = $false
                } else {
                    $provKey = $val.Split(':')[0]
                    $model = $val.Substring($provKey.Length + 1)
                    $provOk = $Providers.ContainsKey($provKey) -and $Providers[$provKey].key
                    if ($provOk) {
                        Write-Host "    $($slot.PadRight(10)) $pass  $val  ->  $($Providers[$provKey].name)"
                    } else {
                        Write-Host "    $($slot.PadRight(10)) $warn  $val (provider '$provKey' unavailable)"
                    }
                }
            }
            if (-not $overrideOk) { $allOk = $false }
        } catch {
            Write-Host "    $fail  Corrupt JSON in $SlotOverridesFile"
            $allOk = $false
        }
    } else {
        Write-Host "    $warn  No slot-overrides.json (will be created on first launch)"
    }

    # Show dedicated subagent model
    if (Test-Path $SubagentModelFile) {
        try {
            $subData = Get-Content $SubagentModelFile -Raw | ConvertFrom-Json
            if ($subData.providerKey -and $subData.modelId) {
                $subVal = "$($subData.providerKey):$($subData.modelId)"
                $subProvName = if ($Providers.ContainsKey($subData.providerKey)) { $Providers[$subData.providerKey].name } else { $null }
                if ($subProvName) {
                    Write-Host "`n  Subagent model: $subVal  ->  $subProvName (dedicated)" -ForegroundColor Green
                } else {
                    Write-Host "`n  Subagent model: $subVal (dedicated)" -ForegroundColor Green
                }
            }
        } catch { $null = $_ }
    } else {
        Write-Host "`n  Subagent model: config default" -ForegroundColor DarkGray
    }

    # 7. Proxy startup test
    if ($nodePath -and (Test-Path $proxyScript)) {
        Write-Host "`n  Proxy Test:" -ForegroundColor Yellow
        # Find best available config for proxy test
        $doctorConfigName = $null
        $defaultBackend = if ($env:DEEPCLAUDE_DEFAULT_BACKEND) { $env:DEEPCLAUDE_DEFAULT_BACKEND } elseif ($env:CHEAPCLAUDE_DEFAULT_BACKEND) { $env:CHEAPCLAUDE_DEFAULT_BACKEND } else { $null }
        if ($defaultBackend -and $Configs.Contains($defaultBackend)) {
            try { $r = Resolve-Config $defaultBackend; if ($r) { $doctorConfigName = $defaultBackend } } catch { Write-Host "    Config '$defaultBackend' not available: $_" -ForegroundColor DarkGray }
        }
        if (-not $doctorConfigName) {
            foreach ($kv in $Configs.GetEnumerator()) {
                try { $r = Resolve-Config $kv.Key; if ($r) { $doctorConfigName = $kv.Key; break } } catch { Write-Host "    Config '$($kv.Key)' not available: $_" -ForegroundColor DarkGray }
            }
        }
        if (-not $doctorConfigName) { $doctorConfigName = "ds" }
        try {
            $doctorResolved = Resolve-Config $doctorConfigName
            Set-UsedProviderEnv $doctorResolved
            Show-ProxyWarning
            $testRoutesJson = Invoke-LauncherMjs "build-routes", "--name=$doctorConfigName"
            $testRoutesFile = Join-Path $DeepClaudeDir "doctor-test-routes.json"
            Write-AtomicFile $testRoutesFile $testRoutesJson

            $testProxy = Start-RoutingProxy -RoutesFile $testRoutesFile
            $testUrl = "http://127.0.0.1:$($testProxy.Port)/health"
            try {
                $health = Invoke-RestMethod -Uri $testUrl -Method GET -TimeoutSec 5
                Write-Host "    Health endpoint   $pass  http://127.0.0.1:$($testProxy.Port) (uptime $($health.uptime)ms)"
            } catch {
                Write-Host "    Health endpoint   $fail  Proxy started but /health failed: $($_.Exception.Message)"
                $allOk = $false
            }
            Stop-RoutingProxy $testProxy
            Remove-Item $testRoutesFile -ErrorAction SilentlyContinue

            # Also test provider API key validity via probe
            Write-Host "`n  Key Validation (probe each provider):" -ForegroundColor Yellow
            $probeRoutesJson = Invoke-LauncherMjs "build-routes", "--name=$doctorConfigName"
            $probeRoutesFile = Join-Path $DeepClaudeDir "doctor-probe-routes.json"
            Write-AtomicFile $probeRoutesFile $probeRoutesJson
            $probeOut = & $tsxBin $proxyScript --probe $probeRoutesFile 2>&1
            if ($LASTEXITCODE -eq 0) {
                Write-Host $probeOut
            } else {
                $allOk = $false
            }
            Remove-Item $probeRoutesFile -ErrorAction SilentlyContinue
        } catch {
            if ($_.Exception.Message -match "not set") {
                Write-Host "    $warn  No valid API keys configured. Skipping proxy test."
            } else {
                Write-Host "    Proxy startup     $fail  $($_.Exception.Message)"
                $allOk = $false
            }
        }
    }

    # Summary
    if ($allOk) {
        Write-Host "`n  Result: All checks passed. Ready to launch.`n" -ForegroundColor Green
    } else {
        Write-Host "`n  Result: Some checks failed. See above for details.`n" -ForegroundColor Red
    }
    exit $(if ($allOk) { 0 } else { 1 })
}

# --- Lint ---
if ($Lint) {
    $myPath = $MyInvocation.MyCommand.Path
    Write-Host "`n  Linting: $myPath" -ForegroundColor Cyan
    try {
        $issues = Invoke-ScriptAnalyzer -Path $myPath -Severity Error,Warning | Where-Object {
            $_.RuleName -notin @('PSAvoidUsingWriteHost', 'PSUseBOMForUnicodeEncodedFile')
        }
        if ($issues) {
            Write-Host "`n  Issues found:" -ForegroundColor Red
            $issues | Format-Table Line, Severity, RuleName, Message -AutoSize
            exit 1
        }
        Write-Host "  No issues found." -ForegroundColor Green
    } catch [System.Management.Automation.CommandNotFoundException] {
        Write-Host "PSScriptAnalyzer not installed. Run: Install-Module -Name PSScriptAnalyzer -Force" -ForegroundColor Yellow
    }
    exit 0
}

# --- Lint Config ---
if ($LintConfig) {
    $myDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
    $tsxBin = Join-Path $myDir "node_modules\.bin\tsx.cmd"
    $lintScript = Join-Path $myDir "proxy\config-lint.ts"
    $nodePath = try { (Get-Command node -ErrorAction Stop).Source } catch { $null }
    if (-not $nodePath) {
        Write-Host "ERROR: Node.js is not installed or not in PATH." -ForegroundColor Red
        exit 1
    }
    if (-not (Test-Path $tsxBin)) {
        Write-Host "ERROR: Dependencies not installed. Run 'npm install' first." -ForegroundColor Red
        exit 1
    }
    if (-not (Test-Path $lintScript)) {
        Write-Host "ERROR: Config lint script not found at: $lintScript" -ForegroundColor Red
        exit 1
    }
    & $tsxBin $lintScript
    exit $LASTEXITCODE
}

# --- Fix AV ---
if ($FixAv) {
    $myPath = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
    $proxyDir = Join-Path $myPath "proxy"

    # Always write the standalone rescue script so it exists even if
    # deepclaude itself gets quarantined after this run.
    Write-FixAvBatch

    Write-Host "`n  deepclaude -- AV Exclusion Helper`n" -ForegroundColor Cyan

    Write-Host "  The multi-provider proxy is at:" -ForegroundColor Yellow
    Write-Host "    $proxyDir`n"

    Write-Host "  Run these in an admin PowerShell window:`n" -ForegroundColor Yellow

    Write-Host "  # Exclude the proxy directory (files on disk)" -ForegroundColor DarkGray
    Write-Host "  Add-MpPreference -ExclusionPath `"$proxyDir`"" -ForegroundColor White
    Write-Host ""

    Write-Host "  # If behavioral detection still triggers, also exclude node.exe:" -ForegroundColor DarkGray
    Write-Host "  # Add-MpPreference -ExclusionProcess `"node.exe`"" -ForegroundColor DarkGray
    Write-Host ""

    try {
        $excluded = (Get-MpPreference).ExclusionPath -contains $proxyDir
        if ($excluded) {
            Write-Host "  Status: $proxyDir is already excluded." -ForegroundColor Green
        } else {
            $parentExcluded = (Get-MpPreference).ExclusionPath | Where-Object { $proxyDir.StartsWith($_) }
            if ($parentExcluded) {
                Write-Host "  Status: Parent directory '$parentExcluded' is excluded (covers proxy)." -ForegroundColor Green
            } else {
                Write-Host "  Status: Not yet excluded." -ForegroundColor Yellow
            }
        }
    } catch {
        Write-Host "  (Cannot check current exclusions — run as admin to verify)" -ForegroundColor DarkGray
    }
    Write-Host ""
    Write-Host "  If deepclaude itself was deleted by AV, a standalone fix script" -ForegroundColor Yellow
    Write-Host "  was written to: $FixAvBatchFile" -ForegroundColor White
    Write-Host "  Run it as admin, then re-clone or re-install deepclaude." -ForegroundColor Yellow
    Write-Host ""
    exit 0
}

# --- Benchmark ---
if ($Benchmark) {
    Write-Host "`n  Latency Benchmark" -ForegroundColor Cyan
    Write-Host "  ==================" -ForegroundColor DarkGray

    # Pre-resolve configs (can't call script functions in -Parallel runspaces)
    $benchJobs = foreach ($id in @("ds","or","fw","oc","km","mm","um","gr","mt","mx","za","bp","sf","nv")) {
        try {
            $r = Resolve-Config $id
            if (-not $r) { continue }
            $opus = $r.slots["opus"]
            $prov = $r.providers[$opus.provider]
            @{
                id = $id
                name = $r.name
                url = $prov.url
                key = $prov.key
                auth = $prov.auth
                model = $opus.model
            }
        } catch { continue }
    }

    $results = $benchJobs | ForEach-Object -Parallel {
        $b = $_
        $headers = if ($b.auth -eq "bearer") {
            @{ "Authorization" = "Bearer $($b.key)"; "content-type" = "application/json"; "anthropic-version" = "2023-06-01" }
        } else {
            @{ "x-api-key" = $b.key; "content-type" = "application/json"; "anthropic-version" = "2023-06-01" }
        }
        $body = (@{ model = $b.model; max_tokens = 32; messages = @(@{ role = "user"; content = "Reply: ok" }) } | ConvertTo-Json -Depth 5)
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        try {
            $null = Invoke-RestMethod -Uri "$($b.url)/v1/messages" -Method POST -Headers $headers -Body $body -TimeoutSec 30
            $sw.Stop()
            @{ id = $b.id; name = $b.name; ok = $true; ms = $sw.ElapsedMilliseconds }
        } catch {
            $sw.Stop()
            $code = if ($_.Exception.Response) { $_.Exception.Response.StatusCode.value__ } else { "timeout" }
            @{ id = $b.id; name = $b.name; ok = $false; code = $code; ms = $sw.ElapsedMilliseconds }
        }
    } -ThrottleLimit 6

    foreach ($r in $results) {
        if ($r.ok) {
            Write-Host "  $($r.name) OK ($($r.ms)ms)" -ForegroundColor Green
        } else {
            Write-Host "  $($r.name) FAIL ($($r.code), $($r.ms)ms)" -ForegroundColor Red
        }
    }
    Write-Host ""
    exit 0
}

# --- Stop Proxy ---
if ($StopProxy) {
    Stop-PersistentProxy
    exit 0
}

# --- Set Slot ---
if ($SetSlot -or $PSBoundParameters.ContainsKey('SetSlot')) {
    $setParts = $SetSlot -split '\s+', 2
    $slotName = $setParts[0]
    $slotModel = if ($setParts.Count -gt 1) { $setParts[1] }
                  elseif ($ModelSpecs -and $ModelSpecs.Count -gt 0) { $ModelSpecs[0] }
                  else { $null }

    $validSlots = @("opus","sonnet","haiku","subagent","fable")
    if ($slotName -notin $validSlots) {
        Write-Host "ERROR: Invalid slot '$slotName'. Use: opus, sonnet, haiku, subagent, fable" -ForegroundColor Red
        exit 1
    }

    # Read current overrides (or start fresh)
    $overrides = @{}
    if (Test-Path $SlotOverridesFile) {
        try { $overrides = Get-Content $SlotOverridesFile -Raw | ConvertFrom-Json } catch { $null = $_ }
    }

    if (-not $slotModel) {
        # Clear override: remove the slot key, _defaults handles the fallback
        $overrides.PSObject.Properties.Remove($slotName)
        $defaultModel = if ($overrides._defaults -and $overrides._defaults.$slotName) { $overrides._defaults.$slotName } else { "unknown" }
        Write-Host "`n  Cleared $slotName override (reverts to $defaultModel)." -ForegroundColor Green
    } else {
        # Validate format
        if ($slotModel -notmatch '^[a-z][a-z0-9_-]*:.+$') {
            Write-Host "ERROR: Model must be in providerKey:modelId format (e.g. or:z-ai/glm-4.5-air:free)" -ForegroundColor Red
            exit 1
        }
        $provKey = $slotModel.Split(':')[0]
        if (-not $Providers.ContainsKey($provKey)) {
            Write-Host "ERROR: Unknown provider '$provKey'. Known: $($Providers.Keys -join ', ')" -ForegroundColor Red
            exit 1
        }
        if (-not $Providers[$provKey].key) {
            Write-Host "ERROR: No API key set for provider '$provKey'." -ForegroundColor Red
            exit 1
        }

        $overrides | Add-Member -NotePropertyName $slotName -NotePropertyValue $slotModel -Force
        Write-Host "`n  Set $slotName override: $slotModel" -ForegroundColor Green

        # Warn if model not in known context limits (statusline won't show context %)
        $colonIdx = $slotModel.IndexOf(':')
        $plainModel = if ($colonIdx -ge 0) { $slotModel.Substring($colonIdx + 1) } else { $slotModel }
        $plainModel = $plainModel -replace '\[1m\]', ''
        if (-not $ModelCtx.ContainsKey($plainModel)) {
            Write-Host "  Note: Model '$plainModel' not in context-limit registry. Statusline won't show context usage." -ForegroundColor DarkYellow
        }
    }

    $overridesJson = $overrides | ConvertTo-Json
    Write-AtomicFile $SlotOverridesFile $overridesJson

    # Update routes file so the proxy routes this slot to the correct provider.
    # Without this, the proxy rewrites the model name but still routes by the
    # stale slot→provider mapping in current-routes.json → 400 from wrong provider.
    if (Test-Path $CurrentRoutesFile) {
        try {
            $routes = Get-Content $CurrentRoutesFile -Raw | ConvertFrom-Json
            $provKey = $slotModel.Split(':')[0]
            $modelId = $slotModel.Substring($provKey.Length + 1)
            $routes.slots.$slotName = "${slotName}:${provKey}:${modelId}"
            $routes.routes | Add-Member -NotePropertyName $modelId -NotePropertyValue @{
                provider = $provKey; rewrite = $modelId
            } -Force
            # Add provider entry if missing from routes
            if (-not $routes.providers.$provKey) {
                $p = $Providers[$provKey]
                if ($p) {
                    $routes.providers | Add-Member -NotePropertyName $provKey -NotePropertyValue @{
                        url = $p.url; keyEnv = $p.keyName; auth = $p.auth
                        format = if ($p.format) { $p.format } else { "anthropic" }
                        fallback = if ($p.fallback) { $p.fallback } else { $null }
                    } -Force
                }
            }
            $routes | ConvertTo-Json -Depth 5 | Out-File $CurrentRoutesFile -Encoding utf8 -NoNewline
        } catch {
            Write-Host "  WARNING: Failed to update routes file: $_" -ForegroundColor DarkYellow
        }
    }

    if ($slotName -eq 'opus') {
        Write-Host "  Note: For opus, /model also works directly in Claude Code." -ForegroundColor DarkGray
    }
    if ($slotName -eq 'fable') {
        Write-Host "  Note: For fable, /model also works directly in Claude Code." -ForegroundColor DarkGray
    }
    $proxyState = Get-ProxyState
    if ($proxyState) {
        Write-Host "  Proxy is running -- change takes effect immediately.`n" -ForegroundColor DarkGray
    } else {
        Write-Host "  No proxy running. Override saved for next launch.`n" -ForegroundColor DarkGray
    }
    exit 0
}

# --- Subagent Model ---
if ($SubagentModel -or $PSBoundParameters.ContainsKey('SubagentModel')) {
    if (-not $SubagentModel) {
        if (Test-Path $SubagentModelFile) {
            Remove-Item $SubagentModelFile -Force
            Write-Host "`n  Cleared dedicated subagent model.`n" -ForegroundColor Green
        } else {
            Write-Host "`n  No dedicated subagent model is set.`n" -ForegroundColor Yellow
        }
        exit 0
    }

    if ($SubagentModel -notmatch '^[a-z][a-z0-9_-]*:.+$') {
        Write-Host "ERROR: Subagent model must be in providerKey:modelId format (e.g. oc:big-pickle)" -ForegroundColor Red
        exit 1
    }
    $subProvKey = $SubagentModel.Split(':')[0]
    if (-not $Providers.ContainsKey($subProvKey)) {
        Write-Host "ERROR: Unknown provider '$subProvKey'. Known: $($Providers.Keys -join ', ')" -ForegroundColor Red
        exit 1
    }
    if (-not $Providers[$subProvKey].key) {
        Write-Host "ERROR: No API key set for provider '$subProvKey'." -ForegroundColor Red
        exit 1
    }

    $subData = @{ providerKey = $subProvKey; modelId = $SubagentModel.Substring($subProvKey.Length + 1) } | ConvertTo-Json
    Write-AtomicFile $SubagentModelFile $subData
    Write-Host "`n  Set dedicated subagent model: $SubagentModel`n" -ForegroundColor Green

    $proxyState = Get-ProxyState
    if ($proxyState) {
        Write-Host "  Proxy is running -- change takes effect immediately.`n" -ForegroundColor DarkGray
    } else {
        Write-Host "  No proxy running. Subagent model saved for next launch.`n" -ForegroundColor DarkGray
    }
    exit 0
}

# --- Models ---
if ($Models) {
    Write-Host "`n  deepclaude - Available Models" -ForegroundColor Cyan
    Write-Host "  ================================" -ForegroundColor DarkGray
    $byProvider = @{}
    foreach ($cfg in $Configs.Values) {
        foreach ($slot in @("opus","sonnet","haiku","subagent","fable")) {
            $val = $cfg[$slot]
            if ($val -match '^(.+?):(.+)$') {
                $provKey = $Matches[1]
                $modelId = $Matches[2]
                if (-not $byProvider.ContainsKey($provKey)) { $byProvider[$provKey] = @{} }
                $byProvider[$provKey][$modelId] = $true
            }
        }
    }
    foreach ($pk in $byProvider.Keys | Sort-Object) {
        $prov = $Providers[$pk]
        $keyStatus = if ($prov.key) { "set" } else { "MISSING" }
        Write-Host "`n  $($prov.name) ($pk) [key: $keyStatus]:" -ForegroundColor Yellow
        foreach ($m in $byProvider[$pk].Keys | Sort-Object) {
            Write-Host "    $($pk):$m" -ForegroundColor White
        }
    }
    $proxyState = Get-ProxyState
    if ($proxyState) {
        Write-Host "`n  Persistent proxy: RUNNING on port $($proxyState.port)" -ForegroundColor Green

        # Show slot overrides if any
        if (Test-Path $SlotOverridesFile) {
            try {
                $overrides = Get-Content $SlotOverridesFile -Raw | ConvertFrom-Json
                $overrideKeys = $overrides.PSObject.Properties.Name
                if ($overrideKeys.Count -gt 0) {
                    Write-Host "`n  Slot overrides:" -ForegroundColor Yellow
                    foreach ($k in $overrideKeys | Where-Object { $_ -ne '_defaults' } | Sort-Object) {
                        Write-Host "    $($k.PadRight(12)) $($overrides.$k)" -ForegroundColor White
                    }
                }
            } catch { $null = $_ }
        }
    } else {
        Write-Host "`n  Persistent proxy: NOT RUNNING" -ForegroundColor DarkGray
    }
    Write-Host "`n  Use /model providerKey:modelId in Claude Code to switch opus or fable." -ForegroundColor DarkGray
    Write-Host "  Use deepclaude --set-slot SLOT MODEL to switch sonnet/haiku/subagent." -ForegroundColor DarkGray
    Write-Host "  Use deepclaude --switch CONFIG to change all slot mappings at once.`n" -ForegroundColor DarkGray
    exit 0
}

# --- Switch ---
if ($Switch -or $PSBoundParameters.ContainsKey('Switch')) {
    $switchTarget = $Switch
    if (-not $switchTarget) {
        Write-Host "Usage: deepclaude --switch CONFIG-NAME" -ForegroundColor Yellow
        Write-Host "Configs: $($Configs.Keys -join ', ')" -ForegroundColor DarkGray
        Write-Host "Or: deepclaude --switch providerKey:modelId ..." -ForegroundColor DarkGray
        exit 1
    }

    if ($Configs.Contains($switchTarget)) {
        $switchResolved = Resolve-Config $switchTarget
    } else {
        $specs = $switchTarget -split '\s+'
        $switchResolved = Build-AdHocConfig $specs
    }

    if (-not $switchResolved) {
        Write-Host "ERROR: Could not resolve config '$switchTarget'" -ForegroundColor Red
        exit 1
    }

    # Push env vars only for providers in this config
    Set-UsedProviderEnv $switchResolved

    $proxyState = Get-ProxyState

    # Build routes and slot overrides via launcher.mjs
    if ($Configs.Contains($switchTarget)) {
        $routesJson = Invoke-LauncherMjs "build-routes", "--name=$switchTarget"
        Initialize-SlotOverrides -Name $switchTarget | Out-Null
    } else {
        $specs = $switchTarget -split '\s+'
        $routesJson = Invoke-LauncherMjs "build-routes", "--specs=$($specs -join ',')"
        Initialize-SlotOverrides -Specs ($specs -join ',') | Out-Null
    }

    $routesFile = $CurrentRoutesFile
    Write-AtomicFile $routesFile $routesJson

    if (-not $proxyState) {
        Write-Host "`n  Starting persistent proxy for $($switchResolved.name)..." -ForegroundColor Cyan
        Show-ProxyWarning
        Write-ThinkingOverrides
        $proxyInfo = Start-RoutingProxy -RoutesFile $routesFile -Persist
        Save-ProxyState -ProcessId $proxyInfo.Process.Id -Port $proxyInfo.Port -RoutesFile $routesFile
        Write-Host "  Proxy on port $($proxyInfo.Port)" -ForegroundColor Green
    } else {
        Write-Host "`n  Proxy routes updated to: $($switchResolved.name)" -ForegroundColor Green
    }

    Write-Host "  Slot mappings:" -ForegroundColor DarkGray
    foreach ($slot in @("opus","sonnet","haiku","subagent","fable")) {
        $s = $switchResolved.slots[$slot]
        $provName = $switchResolved.providers[$s.provider].name
        Write-Host "    $($slot.PadRight(10)) $($s.provider):$($s.model)  ->  $provName" -ForegroundColor DarkGray
    }
    Write-Host "`n  Use /model providerKey:modelId in Claude Code to switch individual models." -ForegroundColor DarkGray
    Write-Host "  Use 'deepclaude --stop-proxy' to stop the proxy when done.`n" -ForegroundColor DarkGray
    exit 0
}

# --- Resolve the config (named or ad-hoc) ---
$IsAnthropic = ($AllSpecs.Count -eq 1 -and $AllSpecs[0] -eq "anthropic")
$resolved = $null

if (-not $IsAnthropic -and $AllSpecs.Count -gt 0) {
    if ($AllSpecs.Count -eq 1 -and $Configs.Contains($AllSpecs[0])) {
        $resolved = Resolve-Config $AllSpecs[0]
    } elseif ($AllSpecs.Count -eq 1 -and $AllSpecs[0] -notmatch '^[a-z][a-z0-9_-]*:.+$') {
        # Single arg that isn't a known config name and isn't a valid
        # providerKey:modelId spec — fail instead of silently falling through.
                    [Console]::Error.WriteLine("ERROR: Unknown config '$($AllSpecs[0])'. Known: $($Configs.Keys -join ', ')")
                    [Console]::Error.WriteLine("  To specify models directly, use providerKey:modelId format (e.g. ds:deepseek-v4-pro)")
        exit 1
    } else {
        $resolved = Build-AdHocConfig $AllSpecs
    }
    if (-not $resolved) {
        Write-Host "ERROR: Could not resolve configuration '$($AllSpecs -join ' ')'" -ForegroundColor Red
        exit 1
    }

    # Push env vars only for providers in the active config
    Set-UsedProviderEnv $resolved
}

# Set Claude Code effort level for all launch paths
$env:CLAUDE_CODE_EFFORT_LEVEL = $Effort

# --- Launch ---
if ($Open -and -not $Dashboard) {
    Write-Host "  NOTE: --open only has effect with --dashboard" -ForegroundColor DarkGray
}

# --- Remote ---
if ($Remote) {
    if ($IsAnthropic) {
        Write-Host "`n  Launching remote control (Anthropic)...`n" -ForegroundColor Cyan
        Clear-AnthropicEnv
        & claude --effort $Effort --dangerously-skip-permissions remote-control @ModelSpecs
        exit 0
    }

    Write-Host "`n  Starting routing proxy for $($resolved.name)..." -ForegroundColor Cyan

    # Build routes and slot overrides via launcher.mjs
    if ($AllSpecs.Count -eq 1 -and $Configs.Contains($AllSpecs[0])) {
        $routesJson = Invoke-LauncherMjs "build-routes", "--name=$($AllSpecs[0])"
        Initialize-SlotOverrides -Name $AllSpecs[0] | Out-Null
    } else {
        $routesJson = Invoke-LauncherMjs "build-routes", "--specs=$($AllSpecs -join ',')"
        Initialize-SlotOverrides -Specs ($AllSpecs -join ',') | Out-Null
    }

    $proxyState = Get-ProxyState

    if ($proxyState) {
        Write-AtomicFile $CurrentRoutesFile $routesJson
        $proxyPort = $proxyState.port
        $proxyInfo = @{ Port = $proxyPort; Process = $null; Persist = $true }
        Write-Host "  Reusing persistent proxy on port $proxyPort" -ForegroundColor DarkGray
    } else {
        Write-AtomicFile $CurrentRoutesFile $routesJson
        Show-ProxyWarning
        $proxyInfo = Start-RoutingProxy -RoutesFile $CurrentRoutesFile -Persist
        Save-ProxyState -ProcessId $proxyInfo.Process.Id -Port $proxyInfo.Port -RoutesFile $CurrentRoutesFile
        $proxyPort = $proxyInfo.Port
        Write-Host "  Proxy on :$proxyPort (persistent)" -ForegroundColor DarkGray
    }

    $provNames = ($resolved.providers.Values | ForEach-Object { $_.name }) -join " + "
    Write-Host "  Providers: $provNames" -ForegroundColor DarkGray
    Write-Host "  Launching remote control...`n" -ForegroundColor Cyan

    if ($Dashboard) {
        Write-Host "  Dashboard: http://127.0.0.1:${proxyPort}/dashboard" -ForegroundColor Cyan
        if ($Open) {
            Start-Process "http://127.0.0.1:${proxyPort}/dashboard"
        }
    }

    # Use launcher.mjs for env vars (handles [1m] suffix, compaction window, etc.)
    $resolvedOpus = $resolved.slots['opus'].model
    $resolvedSonnet = $resolved.slots['sonnet'].model
    $resolvedHaiku = $resolved.slots['haiku'].model
    $resolvedSub = $resolved.slots['subagent'].model
    $resolvedFable = $resolved.slots['fable'].model
    $envJson = Invoke-LauncherMjs "env-vars", "--port=$proxyPort", "--opus=$resolvedOpus", "--sonnet=$resolvedSonnet", "--haiku=$resolvedHaiku", "--subagent=$resolvedSub", "--fable=$resolvedFable" | ConvertFrom-Json
    foreach ($kv in $envJson.PSObject.Properties) {
        if ($kv.Name -eq '_unset') { continue }
        Set-Content "Env:$($kv.Name)" -Value $kv.Value
    }
    foreach ($uk in $envJson._unset) {
        Remove-Item "Env:$uk" -ErrorAction SilentlyContinue
    }

    try {
        & claude --effort $Effort --dangerously-skip-permissions remote-control @ModelSpecs
    } catch {
        Test-ContextLengthError $_.Exception.Message
        throw $_
    }
    Remove-Job -Name "DeepClaudeWatchdog" -Force -ErrorAction SilentlyContinue
    exit 0
}

# --- Launch (Anthropic) ---
if ($IsAnthropic) {
    Clear-AnthropicEnv
    Write-Host "`n  Launching Claude Code (normal Anthropic)...`n" -ForegroundColor Cyan
    try {
        & claude --effort $Effort --dangerously-skip-permissions @ModelSpecs
    } catch {
        Test-ContextLengthError $_.Exception.Message
        throw $_
    }
    exit 0
}

# --- Launch (non-Anthropic config) ---
# Always route through proxy so /model providerKey:modelId switching works
Write-Host "`n  Launching Claude Code via $($resolved.name)..." -ForegroundColor Cyan
$provNames = ($resolved.providers.Values | ForEach-Object { $_.name }) -join " + "
Write-Host "  Providers: $provNames" -ForegroundColor DarkGray
Write-Host "  Routing:" -ForegroundColor DarkGray
foreach ($slot in @("opus","sonnet","haiku","subagent","fable")) {
    $s = $resolved.slots[$slot]
    $provName = $resolved.providers[$s.provider].name
    Write-Host "    $($slot.PadRight(10)) $($s.provider):$($s.model)  ->  $provName" -ForegroundColor DarkGray
}
Write-Host ""

# Build routes and slot overrides via launcher.mjs
if ($AllSpecs.Count -eq 1 -and $Configs.Contains($AllSpecs[0])) {
    $routesJson = Invoke-LauncherMjs "build-routes", "--name=$($AllSpecs[0])"
    Initialize-SlotOverrides -Name $AllSpecs[0] | Out-Null
} else {
    $routesJson = Invoke-LauncherMjs "build-routes", "--specs=$($AllSpecs -join ',')"
    Initialize-SlotOverrides -Specs ($AllSpecs -join ',') | Out-Null
}

$proxyState = Get-ProxyState

Write-AtomicFile $CurrentRoutesFile $routesJson

if ($proxyState) {
    # Reuse persistent proxy
    $proxyPort = $proxyState.port
    $proxyInfo = @{ Port = $proxyPort; Process = $null; Persist = $true }
    Write-Host "  Reusing persistent proxy on :$proxyPort" -ForegroundColor DarkGray
    # Apply thinking overrides to running proxy (hot-reload picks up the file)
    Write-ThinkingOverrides
} else {
    # Start new proxy (persistent if --persist flag set)
    Show-ProxyWarning
    Write-ThinkingOverrides
    $proxyInfo = Start-RoutingProxy -RoutesFile $CurrentRoutesFile -Persist:$Persist
    if ($Persist) {
        Save-ProxyState -ProcessId $proxyInfo.Process.Id -Port $proxyInfo.Port -RoutesFile $CurrentRoutesFile
        Write-Host "  Proxy on :$($proxyInfo.Port) (persistent)" -ForegroundColor DarkGray
    } else {
        Write-Host "  Proxy on :$($proxyInfo.Port)" -ForegroundColor DarkGray
    }
}

# Set env vars via launcher.mjs (handles [1m] suffix, compaction window, etc.)
$resolvedOpus = $resolved.slots['opus'].model
$resolvedSonnet = $resolved.slots['sonnet'].model
$resolvedHaiku = $resolved.slots['haiku'].model
$resolvedSub = $resolved.slots['subagent'].model
$resolvedFable = $resolved.slots['fable'].model
$envJson = Invoke-LauncherMjs "env-vars", "--port=$($proxyInfo.Port)", "--opus=$resolvedOpus", "--sonnet=$resolvedSonnet", "--haiku=$resolvedHaiku", "--subagent=$resolvedSub", "--fable=$resolvedFable" | ConvertFrom-Json
foreach ($kv in $envJson.PSObject.Properties) {
    if ($kv.Name -eq '_unset') { continue }
    Set-Content "Env:$($kv.Name)" -Value $kv.Value
}
foreach ($uk in $envJson._unset) {
    Remove-Item "Env:$uk" -ErrorAction SilentlyContinue
}

if ($Dashboard) {
    Write-Host "  Dashboard: http://127.0.0.1:$($proxyInfo.Port)/dashboard" -ForegroundColor Cyan
    if ($Open) {
        Start-Process "http://127.0.0.1:$($proxyInfo.Port)/dashboard"
    }
}

if ($env:DEEPCLAUDE_WATCHDOG -eq 'true' -and $proxyInfo.Process) {
    $watchdog = Start-Watchdog -ProxyProcess $proxyInfo.Process -ProxyPort $proxyInfo.Port -StateFile $ProxyStateFile -MaxRestarts 5 -Persist:$Persist
}

try {
    & claude --effort $Effort --dangerously-skip-permissions @ModelSpecs
} catch {
    Test-ContextLengthError $_.Exception.Message
    throw $_
} finally {
    if ($proxyInfo) { Stop-RoutingProxy $proxyInfo }
    Remove-Job -Name "DeepClaudeWatchdog" -Force -ErrorAction SilentlyContinue
    Clear-AnthropicEnv
}
