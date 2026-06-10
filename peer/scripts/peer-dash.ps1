# Fleet dashboard: status board + recent inbox + recent artifacts in one call.
# Usage: peer-dash.ps1        → full dashboard
#        peer-dash.ps1 -Status  → status board only
#        peer-dash.ps1 -Msgs 10 → last 10 inbox messages
#        peer-dash.ps1 -Arts    → artifact board with tag counts
param([switch]$Status, [int]$Msgs, [switch]$Arts)
$all = -not ($Status -or $Msgs -or $Arts)

$me = & "$PSScriptRoot\peer-id.ps1" | ConvertFrom-Json
if ($me.uuid -eq "unknown") { throw "Not a Claude Code session (CLAUDE_CODE_SESSION_ID not set)" }

$result = @{ self = @{ name = $me.name; status = "unknown" } }

# ---- Fleet ----
if ($all -or $Status) {
  $board = "$env:USERPROFILE\.claude\peer-status.jsonl"
  if (Test-Path $board) {
    $entries = @{}
    foreach ($line in (Get-Content $board)) {
      $e = try { $line | ConvertFrom-Json } catch { $null }
      if (-not $e) { continue }
      if ($e.name -eq $me.name) {
        $result.self.status = $e.status
        $result.self.project = $e.project
        $result.self.task = $e.task
        continue
      }
      $entries[$e.uuid] = $e
    }
    $now = Get-Date
    $peers = foreach ($e in $entries.Values) {
      $age = ($now - (Get-Date $e.at)).TotalMinutes
      if ($age -ge 60) { continue }
      [PSCustomObject]@{
        name    = $e.name
        status  = $e.status
        project = $e.project
        task    = $e.task
        caps    = $e.caps
        age_min = [math]::Round($age, 1)
      }
    }
    $order = @{idle = 0; busy = 1; dnd = 2}
    $result.fleet = @($peers | Sort-Object { $order[$_.status] }, name)
  } else {
    $result.fleet = @()
  }
}

# ---- Inbox ----
$msgLog = "$env:USERPROFILE\.claude\peer-messages.jsonl"
if (($all -and -not $Arts) -or $Msgs) {
  $n = if ($Msgs) { $Msgs } else { 8 }
  if (Test-Path $msgLog) {
    $items = @()
    foreach ($line in (Get-Content $msgLog -Tail ($n * 6))) {
      $m = try { $line | ConvertFrom-Json } catch { $null }
      if (-not $m -or ($m.to -ne $me.name -and $m.from -ne $me.name)) { continue }
      $txt = [string]$m.msg
      $items += [PSCustomObject]@{
        dir    = if ($m.from -eq $me.name) { '→' } else { '←' }
        from   = $m.from
        to     = $m.to
        type   = $m.type
        msgId  = $m.msgId
        refs   = $m.refs
        msg    = if ($txt.Length -gt 120) { $txt.Substring(0, 117) + '...' } else { $txt }
        at     = $m.at
      }
      if ($items.Count -ge $n) { break }
    }
    [array]::Reverse($items)
    $result.inbox = $items
  } else {
    $result.inbox = @()
  }
}

# ---- Artifacts ----
$artBoard = "$env:USERPROFILE\.claude\peer-artifacts.jsonl"
if ($all -or $Arts) {
  if (Test-Path $artBoard) {
    $artLines = Get-Content $artBoard -Tail 8
    $latestArts = @()
    $tagCounts = @{}
    $allLines = Get-Content $artBoard
    foreach ($line in $allLines) {
      $a = try { $line | ConvertFrom-Json } catch { $null }
      if (-not $a) { continue }
      $tagCounts[$a.tag] = [int]$tagCounts[$a.tag] + 1
    }
    foreach ($line in $artLines) {
      $a = try { $line | ConvertFrom-Json } catch { $null }
      if (-not $a) { continue }
      $latestArts += [PSCustomObject]@{
        tag   = $a.tag
        title = $a.title
        name  = $a.name
        at    = $a.at
      }
    }
    [array]::Reverse($latestArts)
    $result.artifacts = $latestArts
    $result.tags = $tagCounts
  } else {
    $result.artifacts = @()
    $result.tags = @{}
  }
}

ConvertTo-Json $result -Compress -Depth 3
