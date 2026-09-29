package main

import (
	"os"
	"os/exec"
	"strconv"
	"strings"

	"github.com/Poiar/defiant-claude/internal/config"
)

// modelIDOf returns the model name after the provider prefix ("ds:foo" → "foo").
func modelIDOf(spec string) string {
	parts := strings.Split(spec, ":")
	return parts[len(parts)-1]
}

// append1m marks a model spec with [1m] when its context limit is >= 1M tokens,
// matching the TS launcher's 1M-context hint marker.
func append1m(spec string, ctxLimits map[string]int64) string {
	if ctxLimits[modelIDOf(spec)] >= 1000000 {
		return spec + "[1m]"
	}
	return spec
}

// buildClaudeEnv constructs the environment for Claude Code pointing at the
// running proxy. ANTHROPIC_API_KEY is removed — the proxy handles auth.
func buildClaudeEnv(sc config.SlotConfig, ctxLimits, compactionWindow map[string]int64, port int) []string {
	opus := append1m("opus:"+sc.Opus, ctxLimits)
	sonnet := append1m("sonnet:"+sc.Sonnet, ctxLimits)
	haiku := append1m("haiku:"+sc.Haiku, ctxLimits)
	sub := append1m("subagent:"+sc.Sub, ctxLimits)
	fable := append1m("fable:"+sc.Fable, ctxLimits)

	overrides := []string{
		"ANTHROPIC_BASE_URL=http://127.0.0.1:" + strconv.Itoa(port),
		"ANTHROPIC_AUTH_TOKEN=proxy",
		"ANTHROPIC_MODEL=" + opus,
		"ANTHROPIC_DEFAULT_OPUS_MODEL=" + opus,
		"ANTHROPIC_DEFAULT_SONNET_MODEL=" + sonnet,
		"ANTHROPIC_DEFAULT_HAIKU_MODEL=" + haiku,
		"ANTHROPIC_DEFAULT_FABLE_MODEL=" + fable,
		"CLAUDE_CODE_SUBAGENT_MODEL=" + sub,
		"CLAUDE_CONTEXT_COMPRESSION=true",
	}
	// Set the compaction threshold so DeepSeek's free disk cache survives
	// compaction (compaction rewrites history, invalidating the cache prefix).
	if cw, ok := compactionWindow[modelIDOf(sc.Opus)]; ok && cw > 0 {
		overrides = append(overrides, "CLAUDE_CODE_AUTO_COMPACT_WINDOW="+strconv.FormatInt(cw, 10))
	}

	env := make([]string, 0, len(os.Environ())+len(overrides))
	for _, e := range os.Environ() {
		if strings.HasPrefix(e, "ANTHROPIC_API_KEY=") {
			continue
		}
		env = append(env, e)
	}
	return append(env, overrides...)
}

// spawnClaude launches Claude Code against the running proxy, inheriting stdio.
func spawnClaude(env []string) error {
	cmd := exec.Command("claude")
	cmd.Env = env
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}
