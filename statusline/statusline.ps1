#!/usr/bin/env pwsh
$input = $input | Out-String
$d = $input | ConvertFrom-Json

$cwd = $d.workspace.current_dir ?? $d.cwd ?? ''
$dir = if ($cwd) { Split-Path -Leaf $cwd } else { '' }

$branch = ''
if ($cwd) {
  $branch = & git -C $cwd --no-optional-locks rev-parse --abbrev-ref HEAD 2>$null
}

$model = $d.model.id ?? $d.model.display_name ?? ''
$effort = $d.effort.level ?? ''
$slotLabel = ''

# Resolve slot overrides
$overridesFile = "$env:USERPROFILE\.deepclaude\slot-overrides.json"
if ($model -and (Test-Path $overridesFile)) {
  try {
    $overrides = Get-Content $overridesFile -Raw | ConvertFrom-Json
    if ($model -match '^(sonnet|opus|haiku|sub):(.+)$') {
      $slot = $Matches[1]
      $fallback = $Matches[2]
      $abbr = @{ opus = 'o'; sonnet = 's'; haiku = 'h'; subagent = 'sub' }
      $slotLabel = ($abbr[$slot] ?? $slot) + ' '
      # Slot override takes highest priority
      $model = $overrides.$slot ?? $fallback
      # Check dedicated subagent model when no override and slot is subagent
      if (-not $overrides.$slot -and ($slot -eq 'sub' -or $slot -eq 'subagent')) {
        $subModelFile = "$env:USERPROFILE\.deepclaude\subagent-model.json"
        if (Test-Path $subModelFile) {
          try {
            $subData = Get-Content $subModelFile -Raw | ConvertFrom-Json
            if ($subData.providerKey -and $subData.modelId) {
              $model = "$($subData.providerKey):$($subData.modelId)"
            }
          } catch {}
        }
      }
    }
  } catch {}
}

$modelKey = $model -replace '^[a-f0-9]{6,}:', ''   # Strip bare hex tab/session IDs
$modelLookup = $modelKey -replace '^[a-z][a-z0-9_-]*:', ''

$tokens = $d.context_window.total_input_tokens
$ctxMap = @{}
$routesFile = "$env:USERPROFILE\.deepclaude\current-routes.json"
if (Test-Path $routesFile) {
  try {
    $routes = Get-Content $routesFile -Raw | ConvertFrom-Json
    if ($routes.contextLimits) {
      foreach ($prop in $routes.contextLimits.PSObject.Properties) {
        $ctxMap[$prop.Name] = [int]$prop.Value
      }
    }
  } catch {}
}

function fg($r, $g, $b) { "$([char]27)[38;2;$r;$g;$($b)m" }
$reset  = "$([char]27)[0m"
$bold   = "$([char]27)[1m"
$narrow = '  '
$wide   = '     '

$spendGroup = ''
$spendFile = "$env:USERPROFILE\.deepclaude\spend.json"
if (Test-Path $spendFile) {
  try {
    $spendData = Get-Content $spendFile -Raw | ConvertFrom-Json
    $todayKey = (Get-Date).ToString('yyyy-MM-dd')
    $todaySpend = if ($spendData.daily -and $spendData.daily.$todayKey -and $spendData.daily.$todayKey.total) {
      $spendData.daily.$todayKey.total
    } else { $null }
    $proxySessionTotal = if ($spendData.sessions -and $spendData.sessions[0] -and $spendData.sessions[0].total) {
      $spendData.sessions[0].total
    } elseif ($spendData.total) { $spendData.total }

    # Heartbeat: tell the proxy which CC session is currently active.
    # The proxy reads this at spend-flush time and attributes pending cost.
    $ccSessId = $env:CLAUDE_CODE_SESSION_ID
    if ($ccSessId) {
      $ccActiveFile = "$env:USERPROFILE\.deepclaude\cc-active.json"
      try {
        @{ sessionId = $ccSessId; timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() } | ConvertTo-Json -Compress | Set-Content $ccActiveFile -NoNewline
      } catch {}
    }

    # Read per-session spend file: cc-spend-<sessionId>.json contains a single
    # dollar amount written by the proxy on every flush tick.
    $sessionSpend = 0
    if ($ccSessId) {
      $ccSpendFile = "$env:USERPROFILE\.deepclaude\cc-spend-$ccSessId.json"
      if (Test-Path $ccSpendFile) {
        try {
          $sessionSpend = [double](Get-Content $ccSpendFile -Raw).Trim()
        } catch {}
      }
    } else {
      $sessionSpend = $proxySessionTotal
    }

    if ($sessionSpend -and $sessionSpend -gt 0) {
      $inv = [System.Globalization.CultureInfo]::InvariantCulture
      $parts = @()
      $parts += "$bold$(fg 255 210 80)`$$($sessionSpend.ToString('F2', $inv))$reset"
      if ($todaySpend -and $todaySpend -gt $proxySessionTotal + 0.001) {
        $parts += "$(fg 120 120 120)`$$($todaySpend.ToString('F2', $inv))$reset"
      }
      $spendGroup = $parts -join ' '
    }
  } catch {}
}

# Circuit breaker health indicator
$cbIndicator = ''
$proxyFile = "$env:USERPROFILE\.deepclaude\proxy.json"
if (Test-Path $proxyFile) {
  try {
    $proxyCfg = Get-Content $proxyFile -Raw | ConvertFrom-Json
    $port = $proxyCfg.port
    if ($port -and $port -gt 0) {
      $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -TimeoutSec 1 -ErrorAction SilentlyContinue
      if ($health -and $health.providers) {
        $worstState = 'CLOSED'
        $hasData = $false
        foreach ($provider in $health.providers.PSObject.Properties) {
          $reqs = $provider.Value.requests
          $cb = $provider.Value.circuitBreaker
          if ($reqs -gt 0) { $hasData = $true }
          if ($cb -eq 'OPEN') { $worstState = 'OPEN'; break }
          if ($cb -eq 'HALF_OPEN' -and $worstState -ne 'OPEN') { $worstState = 'HALF_OPEN' }
        }
        if ($hasData) {
          $cbIndicator = switch ($worstState) {
            'OPEN'     { "$bold$(fg 255 80 80)✕$reset" }
            'HALF_OPEN' { "$bold$(fg 255 180 50)◐$reset" }
            'CLOSED'    { "$bold$(fg 80 200 120)·$reset" }
          }
        }
        # Fallback indicator — show if failover happened in last 10 min
        if ($health.lastFallback) {
          $age = [math]::Round(((Get-Date) - [datetime]::Parse($health.lastFallback.at)).TotalMinutes)
          if ($age -lt 10) {
            $cbIndicator += " $bold" + (fg 255 180 50) + "↳" + $health.lastFallback.to + $reset
          }
        }
        # Budget warning
        if ($health.budgetWarning -and $health.budgetWarning.level -ne 'info') {
          $color = if ($health.budgetWarning.level -eq 'red') { (fg 255 80 80) } else { (fg 255 180 50) }
          $cbIndicator += " $bold" + $color + "⚠ " + $health.budgetWarning.message + $reset
        }
      }
    }
  } catch {}
}

$maxTokens = $d.context_window.max_input_tokens ?? $ctxMap[$modelLookup]
$tokStr = if ($tokens) { if ($tokens -ge 1000) { "$([math]::Round($tokens/1000))k" } else { "$tokens" } } else { '' }
$pct = $null
if ($tokens -and $maxTokens -and $maxTokens -gt 0) {
  $pct = [math]::Round(($tokens / $maxTokens) * 100)
}
$ctxStr = if ($tokStr -and $null -ne $pct) { "$tokStr/$pct%" } elseif ($null -ne $pct) { "$pct%" } elseif ($tokStr) { $tokStr } else { '' }

# DeepSeek V4 Pro context-window milestone tags
$milestone = ''
if ($modelLookup -eq 'deepseek-v4-pro' -and $tokens) {
  if ($tokens -ge 400000) { $milestone = " $bold$(fg 255 100 255)FBR$reset" }
  elseif ($tokens -ge 300000) { $milestone = " $(fg 200 100 255)SR$reset" }
}

$effortColor = if ($effort -eq 'high') { fg 255 80 80 } elseif ($effort -eq 'medium') { fg 255 180 50 } else { fg 100 160 255 }
$ctxColor    = if ($null -ne $pct -and $pct -ge 80) { fg 255 80 80 } elseif ($null -ne $pct -and $pct -ge 50) { fg 255 180 50 } else { fg 80 200 120 }

$locationParts = @()
if ($dir)    { $locationParts += "$bold$(fg 100 180 255)$dir$reset" }
if ($branch) { $locationParts += "$bold$(fg 255 80 180)$branch$reset" }
$locationGroup = $locationParts -join $narrow

$modelParts = @()
if ($slotLabel -or $model) {
  $displayModel = if ($modelKey -match '^[a-f0-9]{6,}$') { '' } else { $modelKey }
  $modelParts += "$bold$(fg 200 100 255)$slotLabel$displayModel$reset"
}
if ($effort) {
  $modelParts += "$bold$effortColor$effort$reset"
}
if ($cbIndicator) {
  $modelParts += $cbIndicator
}
$modelGroup = $modelParts -join $narrow

$ctxGroup = if ($ctxStr) { "$bold$ctxColor$ctxStr$reset" } else { '' }
if ($milestone) { $ctxGroup += $milestone }

$output = @($locationGroup, $modelGroup, $ctxGroup, $spendGroup | Where-Object { $_ }) -join $wide
# Strip any bare hex UUID/tab IDs (6+ lowercase hex chars) that leaked through
$output -replace '\b[a-f0-9]{6,}\b', '' -replace '\s+', ' ' -replace '^\s+|\s+$', ''
