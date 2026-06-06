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
    deepclaude --doctor             # System health check (prereqs, keys, proxy test)
    deepclaude --cost               # Pricing comparison
    deepclaude --benchmark          # Parallel latency test across all configs
    deepclaude -h                   # This help
    deepclaude --lint               # Self-lint with PSScriptAnalyzer
    deepclaude --fix-av             # Print AV exclusion commands
#>

param(
    [Parameter(Position=0)]
    [Alias("b")]
    [string]$Backend,
    [Alias("r")]
    [switch]$Remote,
    [switch]$Status,
    [switch]$Cost,
    [switch]$Benchmark,
    [Alias("h")]
    [switch]$Help,
    [switch]$Lint,
    [switch]$FixAv,
    [switch]$Persist,
    [string]$Switch,
    [string]$SetSlot,
    [switch]$Models,
    [switch]$StopProxy,
    [switch]$Version,
    [switch]$Doctor,
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
    elseif ($flag -eq 'models')          { $Models = $true }
    elseif ($flag -eq 'stop-proxy')      { $StopProxy = $true }
    elseif ($flag -eq 'remote')          { $Remote = $true }
    elseif ($flag -eq 'status')          { $Status = $true }
    elseif ($flag -eq 'cost')            { $Cost = $true }
    elseif ($flag -eq 'benchmark')       { $Benchmark = $true }
    elseif ($flag -eq 'help')            { $Help = $true }
    elseif ($flag -eq 'lint')            { $Lint = $true }
    elseif ($flag -eq 'fix-av')          { $FixAv = $true }
    elseif ($flag -eq 'version')         { $Version = $true }
    elseif ($flag -eq 'doctor')          { $Doctor = $true }
    $Backend = $null
}

# State directory for persistent proxy
$DeepClaudeDir = Join-Path $env:USERPROFILE ".deepclaude"
$ProxyStateFile = Join-Path $DeepClaudeDir "proxy.json"
$CurrentRoutesFile = Join-Path $DeepClaudeDir "current-routes.json"
$SlotOverridesFile = Join-Path $DeepClaudeDir "slot-overrides.json"

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

if (-not $AllSpecs -and -not $Status -and -not $Cost -and -not $Benchmark -and -not $Help -and -not $Lint -and -not $FixAv -and -not $Switch -and -not $SetSlot -and -not $Models -and -not $StopProxy -and -not $Version -and -not $Doctor) {
    $AllSpecs = @(if ($env:DEEPCLAUDE_DEFAULT_BACKEND) { $env:DEEPCLAUDE_DEFAULT_BACKEND } elseif ($env:CHEAPCLAUDE_DEFAULT_BACKEND) { $env:CHEAPCLAUDE_DEFAULT_BACKEND } else { "ds" })
}

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

# Push keys into process env so child processes (proxy) inherit them
$env:DEEPSEEK_API_KEY = $DeepSeekKey
$env:OPENROUTER_API_KEY = $OpenRouterKey
$env:FIREWORKS_API_KEY = $FireworksKey
$env:OPENCODE_API_KEY = $OpenCodeKey
$env:ALIBABA_DASHSCOPE_API_KEY = $AlibabaKey
$env:KIMI_API_KEY = $KimiKey
$env:MIMO_API_KEY = $MimoKey
$env:UMANS_API_KEY = $UmansKey

function Clear-AnthropicEnv {
    foreach ($v in @("ANTHROPIC_BASE_URL","ANTHROPIC_AUTH_TOKEN","ANTHROPIC_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL","ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL","CLAUDE_CODE_SUBAGENT_MODEL",
        "ANTHROPIC_API_KEY")) {
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
    $tmpFile = $path + ".tmp"
    [System.IO.File]::WriteAllText($tmpFile, $json)
    if (Test-Path $path) { Remove-Item $path }
    Rename-Item $tmpFile $path
}

function Stop-PersistentProxy {
    [CmdletBinding(SupportsShouldProcess)]
    param()
    $PSCmdlet.ShouldProcess("127.0.0.1", "Stop persistent proxy") | Out-Null
    $state = Get-ProxyState
    if (-not $state) {
        Write-Host "  No persistent proxy is running." -ForegroundColor Yellow
        return
    }
    try {
        $proc = Get-Process -Id $state.pid -ErrorAction Stop
        $proc.Kill()
        $proc.Dispose()
    } catch { $null = $_ }
    Clear-ProxyState
    Write-Host "  Proxy stopped." -ForegroundColor Green
}

# --- Provider Registry ---
# auth = "x-api-key" or "bearer"
$Providers = @{
    ds = @{
        name = "DeepSeek (direct)"
        url  = "https://api.deepseek.com/anthropic"
        key  = $DeepSeekKey; keyName = "DEEPSEEK_API_KEY"
        auth = "x-api-key"
    }
    or = @{
        name = "OpenRouter"
        url  = "https://openrouter.ai/api"
        key  = $OpenRouterKey; keyName = "OPENROUTER_API_KEY"
        auth = "bearer"
    }
    fw = @{
        name = "Fireworks AI"
        url  = "https://api.fireworks.ai/inference"
        key  = $FireworksKey; keyName = "FIREWORKS_API_KEY"
        auth = "bearer"
    }
    oc = @{
        name = "OpenCode Zen"
        url  = "https://opencode.ai/zen"
        key  = $OpenCodeKey; keyName = "OPENCODE_API_KEY"
        auth = "bearer"
    }
    al = @{
        name = "Alibaba/DashScope"
        url  = "https://dashscope.aliyuncs.com/api/v1/chat/completions"
        key  = $AlibabaKey; keyName = "ALIBABA_DASHSCOPE_API_KEY"
        auth = "bearer"
    }
    km = @{
        name = "Kimi/Moonshot"
        url  = "https://api.moonshot.ai/anthropic"
        key  = $KimiKey; keyName = "KIMI_API_KEY"
        auth = "bearer"
    }
    mm = @{
        name = "Xiaomi Mimo"
        url  = "https://token-plan-sgp.xiaomimimo.com/anthropic"
        key  = $MimoKey; keyName = "MIMO_API_KEY"
        auth = "bearer"
    }
    um = @{
        name = "Umans AI"
        url  = "https://api.code.umans.ai"
        key  = $UmansKey; keyName = "UMANS_API_KEY"
        auth = "bearer"
    }
}

# --- Per-model context window limits (tokens) ---
$ModelCtx = @{
    "deepseek-v4-pro"                        = 1048576  # 1M
    "deepseek-v4-flash"                      = 1048576  # 1M
    "deepseek/deepseek-v4-pro"               = 1048576  # 1M via OpenRouter
    "deepseek/deepseek-v4-flash"             = 1048576  # 1M via OpenRouter
    "accounts/fireworks/models/deepseek-v4-pro" = 1048576  # 1M via Fireworks
    "openrouter/owl-alpha"                   = 200000   # 200K
    "openai/gpt-oss-120b:free"              = 131072   # 128K
    "poolside/laguna-m.1:free"             = 131072   # 128K
    "z-ai/glm-4.5-air:free"                 = 131072   # 128K
    "liquid/lfm-2.5-1.2b-instruct:free"     = 32768    # 32K
    "big-pickle"                             = 131072   # 128K (conservative)
    "kimi-k2.6"                              = 131072   # 128K
    "mimo-v2.5-pro"                          = 131072   # 128K (conservative)
    "umans-kimi-k2.6"                        = 131072   # 128K
}

# --- Configuration Registry ---
# Each config maps model slots to "providerKey:modelId"
# Single-provider configs -> direct mode (no proxy)
# Multi-provider configs  -> auto-starts local proxy
$Configs = [ordered]@{
    ds = @{
        name     = "DeepSeek V4 Pro"
        opus     = "ds:deepseek-v4-pro[1m]"
        sonnet   = "ds:deepseek-v4-pro[1m]"
        haiku    = "ds:deepseek-v4-flash[1m]"
        subagent = "ds:deepseek-v4-flash[1m]"
    }
    or = @{
        name     = "OpenRouter (owl-alpha)"
        opus     = "or:openrouter/owl-alpha"
        sonnet   = "or:openrouter/owl-alpha"
        haiku    = "or:z-ai/glm-4.5-air:free"
        subagent = "or:z-ai/glm-4.5-air:free"
    }
    or2 = @{
        name     = "OpenRouter (DeepSeek)"
        opus     = "or:deepseek/deepseek-v4-pro[1m]"
        sonnet   = "or:deepseek/deepseek-v4-pro[1m]"
        haiku    = "or:deepseek/deepseek-v4-flash[1m]"
        subagent = "or:deepseek/deepseek-v4-flash[1m]"
    }
    or3 = @{
        name     = "OpenRouter (best free)"
        opus     = "or:openai/gpt-oss-120b:free"
        sonnet   = "or:poolside/laguna-m.1:free"
        haiku    = "or:z-ai/glm-4.5-air:free"
        subagent = "or:liquid/lfm-2.5-1.2b-instruct:free"
    }
    fw = @{
        name     = "Fireworks AI"
        opus     = "fw:accounts/fireworks/models/deepseek-v4-pro[1m]"
        sonnet   = "fw:accounts/fireworks/models/deepseek-v4-pro[1m]"
        haiku    = "fw:accounts/fireworks/models/deepseek-v4-pro[1m]"
        subagent = "fw:accounts/fireworks/models/deepseek-v4-pro[1m]"
    }
    oc = @{
        name     = "OpenCode Zen"
        opus     = "oc:big-pickle"
        sonnet   = "oc:big-pickle"
        haiku    = "oc:big-pickle"
        subagent = "oc:big-pickle"
    }
    km = @{
        name     = "Kimi K2.6"
        opus     = "km:kimi-k2.6"
        sonnet   = "km:kimi-k2.6"
        haiku    = "km:kimi-k2.6"
        subagent = "km:kimi-k2.6"
    }
    mm = @{
        name     = "Xiaomi Mimo V2.5 Pro"
        opus     = "mm:mimo-v2.5-pro"
        sonnet   = "mm:mimo-v2.5-pro"
        haiku    = "mm:mimo-v2.5-pro"
        subagent = "mm:mimo-v2.5-pro"
    }
    um = @{
        name     = "Umans Kimi K2.6"
        opus     = "um:umans-kimi-k2.6"
        sonnet   = "um:umans-kimi-k2.6"
        haiku    = "um:umans-kimi-k2.6"
        subagent = "um:umans-kimi-k2.6"
    }
    # --- Mixed-provider configs ---
    "ds+or" = @{
        name     = "DeepSeek + OpenRouter subs"
        opus     = "ds:deepseek-v4-pro[1m]"
        sonnet   = "ds:deepseek-v4-pro[1m]"
        haiku    = "or:z-ai/glm-4.5-air:free"
        subagent = "or:z-ai/glm-4.5-air:free"
    }
    "ds+oc" = @{
        name     = "DeepSeek + OpenCode subs"
        opus     = "ds:deepseek-v4-pro[1m]"
        sonnet   = "ds:deepseek-v4-pro[1m]"
        haiku    = "oc:big-pickle"
        subagent = "oc:big-pickle"
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
            if (-not $provider.key) { throw "$($provider.keyName) not set (needed by config '$configName')" }
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
        if (-not $provider.key) { throw "$($provider.keyName) not set (needed for spec '$spec')" }

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
                $providerEntries[$kv.Key] = @{
                    url  = $kv.Value.url
                    keyEnv = $kv.Value.keyName
                    auth   = $kv.Value.auth
                }
            }
        }
    } else {
        foreach ($kv in $resolved.providers.GetEnumerator()) {
            $providerEntries[$kv.Key] = @{
                url    = $kv.Value.url
                keyEnv = $kv.Value.keyName
                auth   = $kv.Value.auth
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
    $proxyScript = Join-Path $myDir "proxy\start-proxy.js"

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

    $proc = Start-Process -FilePath $nodePath `
        -ArgumentList $proxyScript, '--routes', $RoutesFile, '--overrides', $SlotOverridesFile `
        -NoNewWindow `
        -RedirectStandardOutput $outFile `
        -RedirectStandardError $errFile `
        -PassThru

    # Wait for port output
    $waited = 0
    while (((-not (Test-Path $outFile)) -or (Get-Item $outFile).Length -eq 0) -and $waited -lt 50) {
        Start-Sleep -Milliseconds 100
        $waited++
    }

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

    Show-ProxyWarning

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

# --- Cost ---
if ($Cost) {
    Write-Host "`n  DeepSeek V4 Pro Pricing" -ForegroundColor Cyan
    Write-Host "  =======================" -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "  Provider        Input/M    Output/M   Cache Hit/M" -ForegroundColor Yellow
    Write-Host "  ----------      --------   --------   -----------"
    Write-Host "  DeepSeek        `$0.44      `$0.87      `$0.004" -ForegroundColor Green
    Write-Host "  OpenRouter      `$0.44      `$0.87      (provider)"
    Write-Host "  Fireworks       `$1.74      `$3.48      (provider)"
    Write-Host "  Anthropic       `$3.00      `$15.00     `$0.30"
    Write-Host ""
    Write-Host "  Monthly estimate (heavy use): `$30-80 vs `$200 Anthropic" -ForegroundColor Green
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
    Write-Host "  --cost          Pricing comparison"
    Write-Host "  --benchmark     Latency test"
    Write-Host "  --persist       Keep proxy running after CC exits (enables --switch)"
    Write-Host "  --switch CONFIG  Switch active config of a running persistent proxy"
    Write-Host "  --models        List all available models (for use with /model in CC)"
    Write-Host "  --set-slot SLOT MODEL  Override a slot's model: opus/sonnet/haiku/subagent"
    Write-Host "                     e.g. --set-slot haiku or:z-ai/glm-4.5-air:free"
    Write-Host "                     e.g. --set-slot sonnet   (no model = clear override)"
    Write-Host "  --stop-proxy    Kill the persistent proxy"
    Write-Host "  --lint          Self-lint with PSScriptAnalyzer"
    Write-Host "  --fix-av        Print AV exclusion commands"
    Write-Host "  --doctor        Run system health check (prereqs, keys, proxy test)"
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
    Write-Host "deepclaude v1.0.0 ($mtime)"
    Write-Host "Proxy: $(Join-Path $myPath 'proxy\start-proxy.js')"
    exit 0
}

# --- Doctor ---
if ($Doctor) {
    $myDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
    $proxyScript = Join-Path $myDir "proxy\start-proxy.js"
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
    $keyProviders = @("ds","or","fw","oc","al","km","mm","um")
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

    # 7. Proxy startup test
    if ($nodePath -and (Test-Path $proxyScript)) {
        Write-Host "`n  Proxy Test:" -ForegroundColor Yellow
        try {
            $testRoutesJson = Build-RoutesJson (Resolve-Config "ds") -IncludeAllModels
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
            Write-Host "    Proxy startup     $fail  $($_.Exception.Message)"
            $allOk = $false
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
    $issues = Invoke-ScriptAnalyzer -Path $myPath -Severity Error,Warning | Where-Object {
        $_.RuleName -notin @('PSAvoidUsingWriteHost', 'PSUseBOMForUnicodeEncodedFile')
    }
    if ($issues) {
        Write-Host "`n  Issues found:" -ForegroundColor Red
        $issues | Format-Table Line, Severity, RuleName, Message -AutoSize
        exit 1
    }
    Write-Host "  No issues found." -ForegroundColor Green
    exit 0
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
    Write-Host ""
    exit 0
}

# --- Benchmark ---
if ($Benchmark) {
    Write-Host "`n  Latency Benchmark" -ForegroundColor Cyan
    Write-Host "  ==================" -ForegroundColor DarkGray

    # Pre-resolve configs (can't call script functions in -Parallel runspaces)
    $benchJobs = foreach ($id in @("ds","or","or2","or3","fw","oc","km","mm","um")) {
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
        $plainModel = $slotModel -replace '^[a-z][a-z0-9_-]*:', ''
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

    $proxyState = Get-ProxyState
    $routesJson = Build-RoutesJson $switchResolved -IncludeAllModels

    $routesFile = $CurrentRoutesFile
    Write-AtomicFile $routesFile $routesJson

    if (-not $proxyState) {
        Write-Host "`n  Starting persistent proxy for $($switchResolved.name)..." -ForegroundColor Cyan
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
}

# --- Remote ---
if ($Remote) {
    if ($IsAnthropic) {
        Write-Host "`n  Launching remote control (Anthropic)...`n" -ForegroundColor Cyan
        Clear-AnthropicEnv
        & claude --effort max --dangerously-skip-permissions remote-control @Args
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
        $proxyInfo = Start-RoutingProxy -RoutesFile $CurrentRoutesFile -Persist
        Save-ProxyState -ProcessId $proxyInfo.Process.Id -Port $proxyInfo.Port -RoutesFile $CurrentRoutesFile
        $proxyPort = $proxyInfo.Port
        Write-Host "  Proxy on :$proxyPort (persistent)" -ForegroundColor DarkGray
    }

    Initialize-SlotOverrides $resolved

    $provNames = ($resolved.providers.Values | ForEach-Object { $_.name }) -join " + "
    Write-Host "  Providers: $provNames" -ForegroundColor DarkGray
    Write-Host "  Launching remote control...`n" -ForegroundColor Cyan

    $overrides = Get-Content $SlotOverridesFile -Raw | ConvertFrom-Json
    $env:ANTHROPIC_BASE_URL = "http://127.0.0.1:$proxyPort"
    $env:ANTHROPIC_DEFAULT_OPUS_MODEL = "opus:" + ($overrides.opus ?? $overrides._defaults.opus ?? "$($resolved.slots['opus'].provider):$($resolved.slots['opus'].model)")
    $env:ANTHROPIC_DEFAULT_SONNET_MODEL = "sonnet:" + ($overrides.sonnet ?? $overrides._defaults.sonnet ?? "$($resolved.slots['sonnet'].provider):$($resolved.slots['sonnet'].model)")
    $env:ANTHROPIC_DEFAULT_HAIKU_MODEL = "haiku:" + ($overrides.haiku ?? $overrides._defaults.haiku ?? "$($resolved.slots['haiku'].provider):$($resolved.slots['haiku'].model)")
    $env:CLAUDE_CODE_SUBAGENT_MODEL = "subagent:" + ($overrides.subagent ?? $overrides._defaults.subagent ?? "$($resolved.slots['subagent'].provider):$($resolved.slots['subagent'].model)")
    $opusCtx = $ModelCtx[$resolved.slots["opus"].model]
    if ($opusCtx) {
        if ($opusCtx -gt 131072 -and $opusCtx -lt 1048576) {
            $env:CLAUDE_CODE_MAX_CONTEXT_TOKENS = $opusCtx
            $env:DISABLE_COMPACT = '1'
        } else {
            $env:CLAUDE_CODE_AUTO_COMPACT_WINDOW = $opusCtx
        }
    }
    Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue

    try {
        & claude --effort max --dangerously-skip-permissions remote-control @Args
    } catch {
        Test-ContextLengthError $_.Exception.Message
        throw $_
    }
    exit 0
}

# --- Launch (Anthropic) ---
if ($IsAnthropic) {
    Clear-AnthropicEnv
    Write-Host "`n  Launching Claude Code (normal Anthropic)...`n" -ForegroundColor Cyan
    try {
        & claude --effort max --dangerously-skip-permissions @Args
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

$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:$($proxyInfo.Port)"
$env:CLAUDE_CONTEXT_COMPRESSION = 'true'
$env:ANTHROPIC_AUTH_TOKEN = "proxy"  # dummy -- proxy handles real auth
$env:ANTHROPIC_MODEL = $opusM
$env:ANTHROPIC_DEFAULT_OPUS_MODEL = $opusM
$env:ANTHROPIC_DEFAULT_SONNET_MODEL = $sonnetM
$env:ANTHROPIC_DEFAULT_HAIKU_MODEL = $haikuM
$env:CLAUDE_CODE_SUBAGENT_MODEL = $subM
$opusCtx = $ModelCtx[$resolved.slots["opus"].model]
if ($opusCtx) {
    if ($opusCtx -gt 131072 -and $opusCtx -lt 1048576) {
        $env:CLAUDE_CODE_MAX_CONTEXT_TOKENS = $opusCtx
        $env:DISABLE_COMPACT = '1'
    } else {
        $env:CLAUDE_CODE_AUTO_COMPACT_WINDOW = $opusCtx
    }
}
Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue

try {
    & claude --effort max --dangerously-skip-permissions @Args
} catch {
    Test-ContextLengthError $_.Exception.Message
    throw $_
} finally {
    if ($proxyInfo) { Stop-RoutingProxy $proxyInfo }
    Clear-AnthropicEnv
}
