# Launch DeepClaude with ds (DeepSeek) config by default.
# Override with: dc -b or  or  dc -b ds+oc  etc.
param([string[]]$Args)

if ($Args.Count -eq 0) {
    # Just dc → launch with ds config
    & "$PSScriptRoot\deepclaude.ps1" -b ds
} elseif ($Args[0] -match '^-b$|^--backend$') {
    # dc -b or → launch with specified config
    & "$PSScriptRoot\deepclaude.ps1" @Args
} elseif ($Args[0] -notmatch '^-' -and $Args[0] -notmatch ':') {
    # dc ds+oc → shortcut for -b ds+oc
    & "$PSScriptRoot\deepclaude.ps1" -b @Args
} else {
    # dc --other-flags → ds config + flags
    & "$PSScriptRoot\deepclaude.ps1" -b ds @Args
}
