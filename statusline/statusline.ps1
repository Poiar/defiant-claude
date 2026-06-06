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
      $model = $overrides.$slot ?? $fallback
    }
  } catch {}
}

$modelKey = $model
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

$maxTokens = $d.context_window.max_input_tokens ?? $ctxMap[$modelLookup]
$tokStr = if ($tokens) { if ($tokens -ge 1000) { "$([math]::Round($tokens/1000))k" } else { "$tokens" } } else { '' }
$pct = $null
if ($tokens -and $maxTokens -and $maxTokens -gt 0) {
  $pct = [math]::Round(($tokens / $maxTokens) * 100)
}
$ctxStr = if ($tokStr -and $null -ne $pct) { "$tokStr/$pct%" } elseif ($null -ne $pct) { "$pct%" } elseif ($tokStr) { $tokStr } else { '' }

function fg($r, $g, $b) { "$([char]27)[38;2;$r;$g;$($b)m" }
$reset  = "$([char]27)[0m"
$bold   = "$([char]27)[1m"
$narrow = '  '
$wide   = '     '

$effortColor = if ($effort -eq 'high') { fg 255 80 80 } elseif ($effort -eq 'medium') { fg 255 180 50 } else { fg 100 160 255 }
$ctxColor    = if ($null -ne $pct -and $pct -ge 80) { fg 255 80 80 } elseif ($null -ne $pct -and $pct -ge 50) { fg 255 180 50 } else { fg 80 200 120 }

$locationParts = @()
if ($dir)    { $locationParts += "$bold$(fg 100 180 255)$dir$reset" }
if ($branch) { $locationParts += "$bold$(fg 255 80 180)$branch$reset" }
$locationGroup = $locationParts -join $narrow

$modelParts = @()
if ($slotLabel -or $model) {
  $modelParts += "$bold$(fg 200 100 255)$slotLabel$modelKey$reset"
}
if ($effort) {
  $modelParts += "$bold$effortColor$effort$reset"
}
$modelGroup = $modelParts -join $narrow

$ctxGroup = if ($ctxStr) { "$bold$ctxColor$ctxStr$reset" } else { '' }

@($locationGroup, $modelGroup, $ctxGroup | Where-Object { $_ }) -join $wide
