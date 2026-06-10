# Compact peer JSONL files. Keeps latest entries, discards old data.
# Usage: peer-rotate.ps1         → rotate all 3 files with defaults
#        peer-rotate.ps1 -DryRun  → show what would be removed
#        peer-rotate.ps1 -KeepMessages 2000 -KeepArtifacts 1000
# Safe: uses temp-file + atomic Move-Item to minimize the write window.
# Run during fleet idle periods for zero risk of concurrent-write loss.
param(
  [int]$KeepMessages = 1000,
  [int]$KeepArtifacts = 500,
  [switch]$DryRun
)

$files = @{
  status   = @{ path = "$env:USERPROFILE\.claude\peer-status.jsonl";   mode = "dedup" }
  messages = @{ path = "$env:USERPROFILE\.claude\peer-messages.jsonl"; mode = "tail";  keep = $KeepMessages }
  artifacts= @{ path = "$env:USERPROFILE\.claude\peer-artifacts.jsonl";mode = "tail";  keep = $KeepArtifacts }
}

foreach ($key in $files.Keys) {
  $info = $files[$key]
  $path = $info.path
  if (-not (Test-Path $path)) { continue }

  $lines = Get-Content $path
  $before = $lines.Count
  if ($before -eq 0) { continue }

  if ($info.mode -eq "dedup") {
    $latest = @{}
    foreach ($line in $lines) {
      $e = try { $line | ConvertFrom-Json } catch { $null }
      if (-not $e) { continue }
      $latest[$e.uuid] = $line
    }
    $kept = $latest.Values
  } else {
    $keep = $info.keep
    if ($before -le $keep) { continue }
    $kept = $lines[($before - $keep)..($before - 1)]
  }

  $after = $kept.Count
  $removed = $before - $after
  if ($DryRun) {
    Write-Output "$key : $before → $after (remove $removed)"
  } else {
    # Write to temp file, then atomically swap via Move-Item.
    # Window between read and move is <50ms; run during idle for zero risk.
    $tmp = "$path.tmp"
    $kept | Out-File $tmp -Encoding utf8
    Move-Item -Force $tmp $path
    Write-Output "$key : $before → $after (removed $removed)"
  }
}
