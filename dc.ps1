# Launch DeepClaude with ds+oc (DeepSeek + free OpenCode subs) by default.
# Override with: dc -b ds  or  dc -b or  etc.
#
# NO param() block: use automatic $args. Three reasons:
# 1. A [string[]]$Args param collides with the automatic $args variable
#    (they alias each other in some contexts but not others — pwsh -File
#    vs & invocation). With $Args as param, dc ds+an becomes dc --dry-run
#    and falls through to the "flags only → ds default" branch.
# 2. pwsh -File treats --flags as named parameters (→ $args only),
#    while & treats them as positional (→ param). A named param like
#    $Remaining only sees positional args; --flags get stranded in
#    $args. The fallback "if empty, copy $args" doesn't help when
#    $Remaining already has positional args but --flags are in $args.
#    Bare $args sees everything in both invocation styles.
# 3. dc.ps1 is a dispatch-only script with no other parameters — it
#    doesn't need named-param binding at all.

# Stop sharing command history with other pwsh sessions immediately.
try { Set-PSReadLineOption -HistorySaveStyle SaveAtExit -ErrorAction Stop } catch {}

if ($args.Count -eq 0) {
    # Just dc → launch with ds+oc config (free haiku/subagent)
    & "$PSScriptRoot\deepclaude.ps1" -b ds+oc
} elseif ($args[0] -match '^-b$|^--backend$') {
    # dc -b or → launch with specified config
    & "$PSScriptRoot\deepclaude.ps1" @args
} elseif ($args[0] -notmatch '^-' -and $args[0] -notmatch ':') {
    # dc ds → shortcut for -b ds
    & "$PSScriptRoot\deepclaude.ps1" -b @args
} else {
    # dc --other-flags → ds+oc config + flags
    & "$PSScriptRoot\deepclaude.ps1" -b ds+oc @args
}
