<#
.SYNOPSIS
    deepclaude -- Use Claude Code with cheap backends. Provider-agnostic: mix models from different APIs in one config.

.USAGE
    # Named configs (via -b)
    deepclaude                      # DeepSeek V4 Pro (default)
    deepclaude -b or                # OpenRouter (owl-alpha)
    deepclaude -b or2               # OpenRouter (DeepSeek)
    deepclaude -b or3               # OpenRouter (best free)
    deepclaude -b fw                # Fireworks AI (fastest)
    deepclaude -b oc                # OpenCode Zen
    deepclaude -b ds+oc             # DeepSeek main + OpenCode subs
    deepclaude -b ds+or             # DeepSeek main + OpenRouter subs
    deepclaude -b anthropic         # Normal Claude Code

    # Model aliases: sonnet, opus, haiku, v4, flash (short names resolve to full model IDs)
    # Ad-hoc positional: providerKey:modelId for opus sonnet haiku subagent
    deepclaude ds:deepseek-v4-pro                                              # 1 spec -> all slots
    deepclaude ds:deepseek-v4-pro oc:big-pickle                                # 2 specs -> first half / second half
    deepclaude ds:deepseek-v4-pro oc:big-pickle or:z-ai/glm-4.5-air:free       # 3 specs -> last repeats
    deepclaude ds:deepseek-v4-pro ds:deepseek-v4-pro oc:big-pickle or:z-ai/glm-4.5-air:free  # 4 specs -> direct

    # Remote control (starts proxy + browser-based Claude Code)
    deepclaude --remote                                 # Default config
    deepclaude --remote -b or                           # Named config
    deepclaude --remote -b anthropic                    # Anthropic direct
    deepclaude --remote ds:deepseek-v4-pro oc:big-pickle # Ad-hoc config

    # Persistent proxy + mid-session switching
    deepclaude --persist -b ds+oc    # Keep proxy alive after CC exits
    deepclaude --switch ds+or        # Switch running proxy to different config
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
    [Parameter(ValueFromRemainingArguments)]
    [string[]]$ModelSpecs
)

$ErrorActionPreference = "Stop"

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
    elseif ($flag -eq 'dry-run' -or $flag -eq 'what-if') { $DryRun = $true }
    elseif ($flag -eq 'dashboard')       { $Dashboard = $true }
    elseif ($flag -eq 'open')            { $Open = $true }
    elseif ($flag -eq 'log-all')         { $LogAll = $true }
    elseif ($flag -eq 'skip-startup-check') { $SkipStartupCheck = $true }
    else {
        Write-Host "ERROR: Unknown flag '--$flag'. Use --help for available flags." -ForegroundColor Red
        exit 1
    }
    $Backend = $null
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
$SubagentModelFile = Join-Path $DeepClaudeDir "subagent-model.json"

# Ensure state directory exists
if (-not (Test-Path $DeepClaudeDir)) {
    New-Item -ItemType Directory -Path $DeepClaudeDir -Force | Out-Null
}

# Clean up stale .tmp files from interrupted writes
Get-ChildItem $DeepClaudeDir -Filter "*.tmp" -ErrorAction SilentlyContinue | Remove-Item -Force

# Gather all positional specs: first goes to $Backend, rest to $ModelSpecs
$AllSpecs = @()
if ($Backend) { $AllSpecs += $Backend }
if ($ModelSpecs) { $AllSpecs += $ModelSpecs }

if (-not $AllSpecs -and -not $Status -and -not $Cost -and -not $Benchmark -and -not $Help -and -not $Lint -and -not $LintConfig -and -not $FixAv -and -not $Switch -and -not $SetSlot -and -not $SubagentModel -and -not $Models -and -not $StopProxy -and -not $Version -and -not $Doctor -and -not $Stats -and -not $PSBoundParameters.ContainsKey('ProbeFile') -and -not $DryRun) {
    $AllSpecs = @(if ($env:DEEPCLAUDE_DEFAULT_BACKEND) { $env:DEEPCLAUDE_DEFAULT_BACKEND } elseif ($env:CHEAPCLAUDE_DEFAULT_BACKEND) { $env:CHEAPCLAUDE_DEFAULT_BACKEND } else { "ds" })
}

# Propagate --log-all to the proxy via environment variable
if ($LogAll) { $env:DEEPCLAUDE_LOG_ALL_REQUESTS = 'true' }
if ($SkipStartupCheck) { $env:DEEPCLAUDE_SKIP_STARTUP_CHECK = 'true' }

# --- API Keys ---
$DeepSeekKey = if ($env:DEEPSEEK_API_KEY) { $env:DEEPSEEK_API_KEY } else {
    [Environment]::GetEnvironmentVariable("DEEPSEEK_API_KEY", "User")
}
$OpenRouterKey = if ($env:OPENROUTER_API_KEY) { $env:OPENROUTER_API_KEY } else {
    [Environment]::GetEnvironmentVariable("OPENROUTER_API_KEY", "User")
}
$FireworksKey = if ($env:FIREWORKS_API_KEY) { $env:FIREWORKS_API_KEY } else {
    [Environment]::GetEnvironmentVariable("FIREWORKS_API_KEY", "User")
}
$OpenCodeKey = if ($env:OPENCODE_API_KEY) { $env:OPENCODE_API_KEY } else {
    [Environment]::GetEnvironmentVariable("OPENCODE_API_KEY", "User")
}
$AlibabaKey = if ($env:ALIBABA_DASHSCOPE_API_KEY) { $env:ALIBABA_DASHSCOPE_API_KEY } else {
    [Environment]::GetEnvironmentVariable("ALIBABA_DASHSCOPE_API_KEY", "User")
}
$KimiKey = if ($env:KIMI_API_KEY) { $env:KIMI_API_KEY } else {
    [Environment]::GetEnvironmentVariable("KIMI_API_KEY", "User")
}
$MimoKey = if ($env:MIMO_API_KEY) { $env:MIMO_API_KEY } else {
    [Environment]::GetEnvironmentVariable("MIMO_API_KEY", "User")
}
$UmansKey = if ($env:UMANS_API_KEY) { $env:UMANS_API_KEY } else {
    [Environment]::GetEnvironmentVariable("UMANS_API_KEY", "User")
}
$GroqKey = if ($env:GROQ_API_KEY) { $env:GROQ_API_KEY } else {
    [Environment]::GetEnvironmentVariable("GROQ_API_KEY", "User")
}
$MistralKey = if ($env:MISTRAL_API_KEY) { $env:MISTRAL_API_KEY } else {
    [Environment]::GetEnvironmentVariable("MISTRAL_API_KEY", "User")
}
$MiniMaxKey = if ($env:MINIMAX_API_KEY) { $env:MINIMAX_API_KEY } else {
    [Environment]::GetEnvironmentVariable("MINIMAX_API_KEY", "User")
}
$ZaiKey = if ($env:ZAI_API_KEY) { $env:ZAI_API_KEY } else {
    [Environment]::GetEnvironmentVariable("ZAI_API_KEY", "User")
}
$BytePlusKey = if ($env:BYTEPLUS_API_KEY) { $env:BYTEPLUS_API_KEY } else {
    [Environment]::GetEnvironmentVariable("BYTEPLUS_API_KEY", "User")
}
$SiliconFlowKey = if ($env:SILICONFLOW_API_KEY) { $env:SILICONFLOW_API_KEY } else {
    [Environment]::GetEnvironmentVariable("SILICONFLOW_API_KEY", "User")
}
$NovitaKey = if ($env:NOVITA_API_KEY) { $env:NOVITA_API_KEY } else {
    [Environment]::GetEnvironmentVariable("NOVITA_API_KEY", "User")
}

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
function Initialize-SlotOverrides {
    param($resolved)
    $defaults = @{}
    foreach ($slot in @("opus","sonnet","haiku","subagent")) {
        $s = $resolved.slots[$slot]
        $defaults[$slot] = "$($s.provider):$($s.model)"
    }

    $existing = @{}
    if (Test-Path $SlotOverridesFile) {
        try { $existing = Get-Content $SlotOverridesFile -Raw | ConvertFrom-Json } catch { $null = $_ }
    }

    # Merge: existing overrides win over new defaults
    $merged = @{ _defaults = $defaults }
    foreach ($slot in @("opus","sonnet","haiku","subagent")) {
        if ($existing.PSObject.Properties.Name -contains $slot) {
            $merged[$slot] = $existing.$slot
        }
    }

    $merged | ConvertTo-Json | Set-Content -Path $SlotOverridesFile -NoNewline
}

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
        $tmpFile = $path + ".tmp"
        [System.IO.File]::WriteAllText($tmpFile, $json)
        if (Test-Path $path) { Remove-Item $path }
        Move-Item -Force $tmpFile $path
        # Restrict permissions on Unix — state files contain route/provider config
        if ($IsLinux -or $IsMacOS) {
            try { chmod 600 $path 2>$null } catch {}
        }
    } catch {
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
    $Providers[$pk] = $entry
}

# --- Per-model context window limits (tokens, from providers.json) ---
$ModelCtx = @{}
foreach ($prop in $Registry.contextLimits.PSObject.Properties) {
    $ModelCtx[$prop.Name] = [int]$prop.Value
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
    }
}

# --- Resolve a config into runtime format ---
function Resolve-Config($configName) {
    $config = $Configs[$configName]
    if (-not $config) { return $null }

    $resolved = @{
        name         = $config.name
        slots        = @{}
        modelProviders = @{}  # modelId -> providerKey
        providers    = @{}    # providerKey -> providerInfo
        defaultProvider = $null
    }

    foreach ($slot in @("opus","sonnet","haiku","subagent")) {
        $val = $config[$slot]
        if ($val -match '^(.+?):(.+)$') {
            $provKey = $Matches[1]
            $modelId = $Matches[2]
            $provider = $Providers[$provKey]
            if (-not $provider) { throw "Unknown provider '$provKey' in config '$configName' slot '$slot'" }
            if (-not $provider.key) {
                Write-Host "  Get a key from your provider's dashboard." -ForegroundColor DarkGray
                Write-Host "  Then: setx $($provider.keyName) `"sk-...`"" -ForegroundColor DarkGray
                throw "$($provider.keyName) not set (needed by config '$configName')"
            }
            $resolved.slots[$slot] = @{ model = $modelId; provider = $provKey }
            $resolved.modelProviders[$modelId] = $provKey
            $resolved.providers[$provKey] = $provider
        } else {
            throw "Invalid model spec in config '$configName' slot '$slot': expected 'providerKey:modelId', got '$val'"
        }
    }

    # Default provider = provider of the opus slot
    $resolved.defaultProvider = $resolved.slots["opus"].provider
    $resolved.isMultiProvider = ($resolved.providers.Count -gt 1)

    return $resolved
}

# --- Build ad-hoc config from positional "providerKey:modelId" specs ---
function Build-AdHocConfig($specs) {
    $slots = @("opus", "sonnet", "haiku", "subagent")
    $config = @{
        name = ""
        slots = @{}
        modelProviders = @{}
        providers = @{}
        defaultProvider = $null
        isMultiProvider = $false
    }

    for ($i = 0; $i -lt 4; $i++) {
        # Map slot index -> spec index based on spec count:
        #   1 spec:  [0, 0, 0, 0]     all same
        #   2 specs: [0, 0, 1, 1]     first half / second half
        #   3 specs: [0, 1, 2, 2]     one each, last repeats
        #   4 specs: [0, 1, 2, 3]     direct mapping
        $idx = switch ($specs.Count) {
            1 { 0 }
            2 { if ($i -lt 2) { 0 } else { 1 } }
            3 { if ($i -eq 0) { 0 } elseif ($i -eq 1) { 1 } else { 2 } }
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

# --- Build routing JSON for multi-provider proxy ---
function Build-RoutesJson {
    param($resolved, [switch]$IncludeAllModels)

    $routes = @{}
    if ($IncludeAllModels) {
        # Include ALL models from ALL configs that have valid keys (for /model switching)
        $seen = @{}
        foreach ($cfg in $Configs.Values) {
            foreach ($slot in @("opus","sonnet","haiku","subagent")) {
                $val = $cfg[$slot]
                if ($val -match '^(.+?):(.+)$') {
                    $provKey = $Matches[1]
                    $modelId = $Matches[2]
                    $apiModelId = $modelId
                    if (-not $seen.ContainsKey($apiModelId) -and $Providers.ContainsKey($provKey) -and $Providers[$provKey].key) {
                        $seen[$apiModelId] = $true
                        $routes[$apiModelId] = @{ provider = $provKey; rewrite = $apiModelId }
                    }
                }
            }
        }
    } else {
        foreach ($kv in $resolved.modelProviders.GetEnumerator()) {
            $modelId = $kv.Key
            $apiModelId = $modelId
            $provKey = $kv.Value
            $routes[$apiModelId] = @{ provider = $provKey; rewrite = $apiModelId }
        }
    }

    $providerEntries = @{}
    if ($IncludeAllModels) {
        # Include ALL providers with valid keys so /model providerKey:modelId works
        foreach ($kv in $Providers.GetEnumerator()) {
            if ($kv.Value.key) {
                $fb = if ($kv.Value.fallback) { $kv.Value.fallback } else { $null }
                $providerEntries[$kv.Key] = @{
                    url      = $kv.Value.url
                    keyEnv   = $kv.Value.keyName
                    auth     = $kv.Value.auth
                    format   = if ($kv.Value.format) { $kv.Value.format } else { "anthropic" }
                    fallback = $fb
                }
            }
        }
    } else {
        foreach ($kv in $resolved.providers.GetEnumerator()) {
            $fb = if ($kv.Value.fallback) { $kv.Value.fallback } else { $null }
            $providerEntries[$kv.Key] = @{
                url      = $kv.Value.url
                keyEnv   = $kv.Value.keyName
                auth     = $kv.Value.auth
                format   = if ($kv.Value.format) { $kv.Value.format } else { "anthropic" }
                fallback = $fb
            }
        }
    }
    $slots = @{}
    foreach ($slot in @("opus","sonnet","haiku","subagent")) {
        $s = $resolved.slots[$slot]
        $slots[$slot] = "${slot}:$($s.provider):$($s.model)"
    }

    return @{
        slots           = $slots
        routes          = $routes
        providers       = $providerEntries
        defaultProvider = $resolved.defaultProvider
        contextLimits   = $ModelCtx
    } | ConvertTo-Json -Depth 5
}

# --- Start the HTTP routing proxy (delegates to proxy/start-proxy.js) ---
function Show-ProxyWarning {
    Write-Host "  NOTE: The proxy script may trigger Windows Defender." -ForegroundColor DarkYellow
    Write-Host "  If blocked, run: deepclaude --fix-av" -ForegroundColor DarkYellow
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
        -ArgumentList ($proxyScript, '--routes', $RoutesFile, '--overrides', $SlotOverridesFile) `
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
        throw "Proxy failed to start. Output: '$portStr' Stderr: '$errStr'"
    }

    # Verify proxy is actually responding
    try {
        $null = Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -TimeoutSec 3
    } catch {
        Write-Host "WARNING: Proxy port $port is not responding. Windows Defender may have blocked it." -ForegroundColor Yellow
        Write-Host "Run: deepclaude --fix-av" -ForegroundColor Yellow
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
    Write-Host "`n  Configurations:" -ForegroundColor Yellow
    foreach ($kv in $Configs.GetEnumerator()) {
        $label = if ($kv.Key -eq "ds") { " (default)" } else { "" }
        $provKeys = @()
        foreach ($s in @("opus","sonnet","haiku","subagent")) {
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
            $slots = @("opus","sonnet","haiku","subagent")
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
            Write-Host "  Provider         Req   OK   Fail   Rate   Avg" -ForegroundColor Yellow
            Write-Host "  ---------------  ----  ---  -----  -----  ---"
            foreach ($prop in ($providers.PSObject.Properties | Sort-Object Name)) {
                $k = $prop.Name
                $v = $prop.Value
                $rate = if ($v.requests -gt 0) { "{0:P0}" -f ($v.successes / $v.requests) } else { "—" }
                $avg = if ($v.avgMs -gt 0) { "$($v.avgMs)ms" } else { "—" }
                $healthIcon = if ($v.fails -eq 0) { "●" } elseif ($v.requests -lt 3) { "○" } elseif ($v.fails / $v.requests -lt 0.5) { "●" } else { "◐" }
                $color = if ($v.fails -eq 0) { "Green" } elseif ($v.requests -lt 3) { "DarkGray" } elseif ($v.fails / $v.requests -lt 0.25) { "Green" } elseif ($v.fails / $v.requests -lt 0.5) { "Yellow" } else { "Red" }
                Write-Host ("  {0,-3} {1,-14}  {2,4}  {3,3}  {4,5}  {5,5}  {6,4}" -f $healthIcon,
                    ($k.PadRight(14)), $v.requests, $v.successes, $v.fails, $rate, $avg) -ForegroundColor $color
            }
            Write-Host ""
            Write-Host "  ● healthy  ○ new/unknown  ◐ degraded (>50% failures)" -ForegroundColor DarkGray
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
        } elseif ($AllSpecs.Count -gt 0) {
            $r = Build-AdHocConfig $AllSpecs
        } else {
            $defaultCfg = if ($env:DEEPCLAUDE_DEFAULT_BACKEND) { $env:DEEPCLAUDE_DEFAULT_BACKEND } elseif ($env:CHEAPCLAUDE_DEFAULT_BACKEND) { $env:CHEAPCLAUDE_DEFAULT_BACKEND } else { "ds" }
            $r = Resolve-Config $defaultCfg
        }
        Set-UsedProviderEnv $r
        $routesJson = Build-RoutesJson $r -IncludeAllModels
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
    } elseif ($AllSpecs.Count -gt 0) {
        $r = Build-AdHocConfig $AllSpecs
    } else {
        $defaultCfg = if ($env:DEEPCLAUDE_DEFAULT_BACKEND) { $env:DEEPCLAUDE_DEFAULT_BACKEND } elseif ($env:CHEAPCLAUDE_DEFAULT_BACKEND) { $env:CHEAPCLAUDE_DEFAULT_BACKEND } else { "ds" }
        $r = Resolve-Config $defaultCfg
    }
    Set-UsedProviderEnv $r
    $routesJson = Build-RoutesJson $r -IncludeAllModels
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
    Write-Host "  Model                                      Input/M    Output/M" -ForegroundColor Yellow
    Write-Host "  ---------------                            --------   --------"
    $costData = $Registry.pricing
    if ($costData) {
        foreach ($prop in $costData.PSObject.Properties) {
            $model = $prop.Name
            $p = $prop.Value
            $inp = if ($p.input -eq 0) { "free" } else { "`$$($p.input.ToString('F2'))" }
            $out = if ($p.output -eq 0) { "free" } else { "`$$($p.output.ToString('F2'))" }
            Write-Host ("  {0,-37} {1,-10} {2}" -f $model, $inp, $out) -ForegroundColor Green
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
    Write-Host "Usage: deepclaude [spec1] [spec2] [spec3] [spec4]   (positional mode)"
    Write-Host "       deepclaude [-b backend] [--status] [--doctor] [--version]"
    Write-Host ""
    Write-Host "  Each positional arg is providerKey:modelId, mapping to opus/sonnet/haiku/subagent."
    Write-Host "  Model aliases: sonnet, opus, haiku, v4, flash, ... (short names resolve to full model IDs)"
    Write-Host "  Fewer than 4 specs repeats the last one for remaining slots."
    Write-Host ""
    Write-Host "  Examples:"
    Write-Host "    deepclaude ds:deepseek-v4-pro ds:deepseek-v4-pro oc:big-pickle or:z-ai/glm-4.5-air:free"
    Write-Host "    deepclaude ds:deepseek-v4-pro oc:big-pickle    (opus/sonnet=DS, haiku/sub=OC)"
    Write-Host "    deepclaude ds:deepseek-v4-pro                  (all slots use DS)"
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
    Write-Host "  --set-slot SLOT MODEL  Override a slot's model: opus/sonnet/haiku/subagent"
    Write-Host "                     e.g. --set-slot haiku or:z-ai/glm-4.5-air:free"
    Write-Host "                     e.g. --set-slot sonnet   (no model = clear override)"
    Write-Host "  --stop-proxy    Kill the persistent proxy"
    Write-Host "  --lint          Self-lint with PSScriptAnalyzer"
    Write-Host "  --lint-config   Validate providers.json configuration"
    Write-Host "  --log-all       Log all requests to ~/.deepclaude/requests.log"
    Write-Host "  --skip-startup-check  Skip the provider health check on proxy startup"
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
    Write-Host "    2. deepclaude --switch ds+or          # Switch configs (from within CC)"
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
    $version = "v1.0.0"
    $pkgPath = Join-Path $myPath "package.json"
    if (Test-Path $pkgPath) {
        try { $version = "v" + ((Get-Content $pkgPath -Raw | ConvertFrom-Json).version) } catch {}
    }

    # Get short git hash from the repo directory.
    $gitHash = "unknown"
    try {
        $hash = git -C "$myPath" rev-parse --short HEAD 2>$null
        if ($hash) { $gitHash = $hash.Trim() }
    } catch {}

    Write-Host "deepclaude $version ($gitHash) ($mtime)"
    Write-Host "Proxy: $(Join-Path $myPath 'proxy\start-proxy.js')"
    exit 0
}

# --- Install Statusline ---
if ($InstallStatusline) {
    $myDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
    if ($IsWindows) {
        $scriptExt = "ps1"
        $scriptType = "PowerShell"
    } else {
        $scriptExt = "sh"
        $scriptType = "shell"
    }
    $sourceFile = Join-Path $myDir "statusline" "statusline.$scriptExt"
    $claudeDir = Join-Path $HOME ".claude"
    $destFile = Join-Path $claudeDir "statusline.$scriptExt"
    $settingsFile = Join-Path $claudeDir "settings.json"

    if (-not (Test-Path $sourceFile)) {
        Write-Host "ERROR: Statusline script not found at: $sourceFile" -ForegroundColor Red
        exit 1
    }

    # Ensure ~/.claude directory exists
    if (-not (Test-Path $claudeDir)) {
        New-Item -ItemType Directory -Path $claudeDir -Force | Out-Null
    }

    # Copy statusline script
    Copy-Item $sourceFile $destFile -Force
    Write-Host "  Copied statusline script to: $destFile" -ForegroundColor Green

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

    # Add/merge statusLine config
    $statusLineConfig = @{
        type = "command"
        command = if ($IsWindows) { "pwsh -NoProfile -File `"$destFile`"" } else { "bash `"$destFile`"" }
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
    $keyProviders = @("ds","or","fw","oc","al","km","mm","um","gr","mt","mx","za","bp","sf","nv")
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
            $validSlots = @("opus","sonnet","haiku","subagent")
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
            try { $r = Resolve-Config $defaultBackend; if ($r) { $doctorConfigName = $defaultBackend } } catch {}
        }
        if (-not $doctorConfigName) {
            foreach ($kv in $Configs.GetEnumerator()) {
                try { $r = Resolve-Config $kv.Key; if ($r) { $doctorConfigName = $kv.Key; break } } catch {}
            }
        }
        if (-not $doctorConfigName) { $doctorConfigName = "ds" }
        try {
            $doctorResolved = Resolve-Config $doctorConfigName
            Set-UsedProviderEnv $doctorResolved
            Show-ProxyWarning
            $testRoutesJson = Build-RoutesJson $doctorResolved -IncludeAllModels
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
    exit 0
}

# --- Benchmark ---
if ($Benchmark) {
    Write-Host "`n  Latency Benchmark" -ForegroundColor Cyan
    Write-Host "  ==================" -ForegroundColor DarkGray

    # Pre-resolve configs (can't call script functions in -Parallel runspaces)
    $benchJobs = foreach ($id in @("ds","or","or2","or3","fw","oc","km","mm","um","gr","mt","mx","za","bp","sf","nv")) {
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

    $validSlots = @("opus","sonnet","haiku","subagent")
    if ($slotName -notin $validSlots) {
        Write-Host "ERROR: Invalid slot '$slotName'. Use: opus, sonnet, haiku, subagent" -ForegroundColor Red
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

    if ($slotName -eq 'opus') {
        Write-Host "  Note: For opus, /model also works directly in Claude Code." -ForegroundColor DarkGray
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
        foreach ($slot in @("opus","sonnet","haiku","subagent")) {
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
    Write-Host "`n  Use /model providerKey:modelId in Claude Code to switch opus." -ForegroundColor DarkGray
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
    $routesJson = Build-RoutesJson $switchResolved -IncludeAllModels

    $routesFile = $CurrentRoutesFile
    Write-AtomicFile $routesFile $routesJson

    if (-not $proxyState) {
        Write-Host "`n  Starting persistent proxy for $($switchResolved.name)..." -ForegroundColor Cyan
        Show-ProxyWarning
        $proxyInfo = Start-RoutingProxy -RoutesFile $routesFile -Persist
        Save-ProxyState -ProcessId $proxyInfo.Process.Id -Port $proxyInfo.Port -RoutesFile $routesFile
        Write-Host "  Proxy on port $($proxyInfo.Port)" -ForegroundColor Green
    } else {
        Write-Host "`n  Proxy routes updated to: $($switchResolved.name)" -ForegroundColor Green
    }

    Initialize-SlotOverrides $switchResolved

    Write-Host "  Slot mappings:" -ForegroundColor DarkGray
    foreach ($slot in @("opus","sonnet","haiku","subagent")) {
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

# Unique session ID for peer messaging — each terminal gets its own.
# Written once at launch so child processes (Claude Code) inherit it.
$env:DEEPCLAUDE_SESSION_ID = [Guid]::NewGuid().ToString()

# --- Remote ---
if ($Remote) {
    if ($IsAnthropic) {
        Write-Host "`n  Launching remote control (Anthropic)...`n" -ForegroundColor Cyan
        Clear-AnthropicEnv
        & claude --effort $Effort --dangerously-skip-permissions remote-control @ModelSpecs
        exit 0
    }

    Write-Host "`n  Starting routing proxy for $($resolved.name)..." -ForegroundColor Cyan

    $routesJson = Build-RoutesJson $resolved -IncludeAllModels
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

    Initialize-SlotOverrides $resolved

    $provNames = ($resolved.providers.Values | ForEach-Object { $_.name }) -join " + "
    Write-Host "  Providers: $provNames" -ForegroundColor DarkGray
    Write-Host "  Launching remote control...`n" -ForegroundColor Cyan

    if ($Dashboard) {
        Write-Host "  Dashboard: http://127.0.0.1:${proxyPort}/dashboard" -ForegroundColor Cyan
        if ($Open) {
            Start-Process "http://127.0.0.1:${proxyPort}/dashboard"
        }
    }

    $overrides = Get-Content $SlotOverridesFile -Raw | ConvertFrom-Json
    # Helper: append [1m] to model if its context limit is >=1M
    $Append1M = {
        param($m) $modelId = ($m -split ':')[-1]; if ($ModelCtx[$modelId] -ge 1000000) { return $m + '[1m]' }; return $m
    }
    $env:ANTHROPIC_BASE_URL = "http://127.0.0.1:$proxyPort"
    $env:ANTHROPIC_DEFAULT_OPUS_MODEL = & $Append1M ("opus:" + ($overrides.opus ?? $overrides._defaults.opus ?? "$($resolved.slots['opus'].provider):$($resolved.slots['opus'].model)"))
    $env:ANTHROPIC_DEFAULT_SONNET_MODEL = & $Append1M ("sonnet:" + ($overrides.sonnet ?? $overrides._defaults.sonnet ?? "$($resolved.slots['sonnet'].provider):$($resolved.slots['sonnet'].model)"))
    $env:ANTHROPIC_DEFAULT_HAIKU_MODEL = & $Append1M ("haiku:" + ($overrides.haiku ?? $overrides._defaults.haiku ?? "$($resolved.slots['haiku'].provider):$($resolved.slots['haiku'].model)"))
    $env:CLAUDE_CODE_SUBAGENT_MODEL = & $Append1M ("subagent:" + ($overrides.subagent ?? $overrides._defaults.subagent ?? "$($resolved.slots['subagent'].provider):$($resolved.slots['subagent'].model)"))
    $ctxModel = $resolved.slots["opus"].model -replace '\[1m\]', ''
    $opusCtx = $ModelCtx[$ctxModel]
    if ($opusCtx) {
        if ($opusCtx -ge 1000000) {
            $env:CLAUDE_CODE_AUTO_COMPACT_WINDOW = "1000000"
        } elseif ($opusCtx -gt 131072) {
            $env:DISABLE_COMPACT = "1"
            $env:CLAUDE_CODE_MAX_CONTEXT_TOKENS = "$opusCtx"
        } else {
            $env:CLAUDE_CODE_AUTO_COMPACT_WINDOW = "$opusCtx"
        }
    }
    Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue
    $env:ANTHROPIC_AUTH_TOKEN = "proxy"  # dummy — proxy handles real auth
    $env:CLAUDE_CONTEXT_COMPRESSION = 'true'
    $env:ANTHROPIC_MODEL = & $Append1M ($resolved.slots['opus'].model -replace '\[1m\]', '')

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
foreach ($slot in @("opus","sonnet","haiku","subagent")) {
    $s = $resolved.slots[$slot]
    $provName = $resolved.providers[$s.provider].name
    Write-Host "    $($slot.PadRight(10)) $($s.provider):$($s.model)  ->  $provName" -ForegroundColor DarkGray
}
Write-Host ""

$routesJson = Build-RoutesJson $resolved -IncludeAllModels
$proxyState = Get-ProxyState

Write-AtomicFile $CurrentRoutesFile $routesJson

if ($proxyState) {
    # Reuse persistent proxy
    $proxyPort = $proxyState.port
    $proxyInfo = @{ Port = $proxyPort; Process = $null; Persist = $true }
    Write-Host "  Reusing persistent proxy on :$proxyPort" -ForegroundColor DarkGray
} else {
    # Start new proxy (persistent if --persist flag set)
    Show-ProxyWarning
    $proxyInfo = Start-RoutingProxy -RoutesFile $CurrentRoutesFile -Persist:$Persist
    if ($Persist) {
        Save-ProxyState -ProcessId $proxyInfo.Process.Id -Port $proxyInfo.Port -RoutesFile $CurrentRoutesFile
        Write-Host "  Proxy on :$($proxyInfo.Port) (persistent)" -ForegroundColor DarkGray
    } else {
        Write-Host "  Proxy on :$($proxyInfo.Port)" -ForegroundColor DarkGray
    }
}

Initialize-SlotOverrides $resolved

# Resolve actual models from overrides (so /model shows the real model, not config defaults)
$overrides = Get-Content $SlotOverridesFile -Raw | ConvertFrom-Json
function Get-SlotModel($s) { $overrides.$s ?? $overrides._defaults.$s ?? "$($resolved.slots[$s].provider):$($resolved.slots[$s].model)" }
$opusM   = "opus:" + (Get-SlotModel 'opus')
$sonnetM = "sonnet:" + (Get-SlotModel 'sonnet')
$haikuM  = "haiku:" + (Get-SlotModel 'haiku')
$subM    = "subagent:" + (Get-SlotModel 'subagent')

# Append [1m] suffix for models with >=1M context. Claude Code's PV() checks this
# dynamically on every request, so the context window follows /model switches.
function Append-1M($modelSpec) {
    $modelId = ($modelSpec -split ':')[-1]
    $ctxLimit = $ModelCtx[$modelId]
    if ($ctxLimit -ge 1000000) { return $modelSpec + '[1m]' }
    return $modelSpec
}
$opusM   = Append-1M $opusM
$sonnetM = Append-1M $sonnetM
$haikuM  = Append-1M $haikuM
$subM    = Append-1M $subM

if ($Dashboard) {
    Write-Host "  Dashboard: http://127.0.0.1:$($proxyInfo.Port)/dashboard" -ForegroundColor Cyan
    if ($Open) {
        Start-Process "http://127.0.0.1:$($proxyInfo.Port)/dashboard"
    }
}

$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:$($proxyInfo.Port)"
$env:CLAUDE_CONTEXT_COMPRESSION = 'true'
$env:ANTHROPIC_AUTH_TOKEN = "proxy"  # dummy -- proxy handles real auth
$env:ANTHROPIC_MODEL = $opusM
$env:ANTHROPIC_DEFAULT_OPUS_MODEL = $opusM
$env:ANTHROPIC_DEFAULT_SONNET_MODEL = $sonnetM
$env:ANTHROPIC_DEFAULT_HAIKU_MODEL = $haikuM
$env:CLAUDE_CODE_SUBAGENT_MODEL = $subM
$ctxModel = $resolved.slots["opus"].model -replace '\[1m\]', ''
$opusCtx = $ModelCtx[$ctxModel]
if ($opusCtx) {
    if ($opusCtx -ge 1000000) {
        # Claude Code's auto-compact window max is 1,000,000 (bu_ constant).
        # Setting it higher (e.g. 1,048,576) is rejected as invalid by BKH().
        $env:CLAUDE_CODE_AUTO_COMPACT_WINDOW = "1000000"
    } elseif ($opusCtx -gt 131072) {
        $env:DISABLE_COMPACT = "1"
        $env:CLAUDE_CODE_MAX_CONTEXT_TOKENS = "$opusCtx"
    } else {
        $env:CLAUDE_CODE_AUTO_COMPACT_WINDOW = "$opusCtx"
    }
}
Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue

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
