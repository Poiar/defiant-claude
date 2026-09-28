package main

import (
	"strings"
	"testing"

	"github.com/Poiar/defiant-claude/internal/config"
)

func TestAppend1m(t *testing.T) {
	limits := map[string]int64{
		"big-model":   2000000,
		"small-model": 200000,
	}
	if got := append1m("ds:big-model", limits); got != "ds:big-model[1m]" {
		t.Errorf("append1m = %q, want ds:big-model[1m]", got)
	}
	if got := append1m("ds:small-model", limits); got != "ds:small-model" {
		t.Errorf("append1m = %q, want ds:small-model (no [1m])", got)
	}
}

func TestBuildClaudeEnv(t *testing.T) {
	sc := config.SlotConfig{
		Opus: "ds:opus-m", Sonnet: "ds:sonnet-m", Haiku: "ds:haiku-m",
		Sub: "ds:sub-m", Fable: "ds:fable-m",
	}
	env := buildClaudeEnv(sc, map[string]int64{}, 12345)
	var base, model, auth, sub string
	for _, e := range env {
		switch {
		case strings.HasPrefix(e, "ANTHROPIC_BASE_URL="):
			base = e
		case strings.HasPrefix(e, "ANTHROPIC_MODEL="):
			model = e
		case strings.HasPrefix(e, "ANTHROPIC_AUTH_TOKEN="):
			auth = e
		case strings.HasPrefix(e, "CLAUDE_CODE_SUBAGENT_MODEL="):
			sub = e
		}
	}
	if base != "ANTHROPIC_BASE_URL=http://127.0.0.1:12345" {
		t.Errorf("base url = %q", base)
	}
	if model != "ANTHROPIC_MODEL=opus:ds:opus-m" {
		t.Errorf("model = %q", model)
	}
	if auth != "ANTHROPIC_AUTH_TOKEN=proxy" {
		t.Errorf("auth = %q", auth)
	}
	if sub != "CLAUDE_CODE_SUBAGENT_MODEL=subagent:ds:sub-m" {
		t.Errorf("subagent = %q", sub)
	}
	for _, e := range env {
		if strings.HasPrefix(e, "ANTHROPIC_API_KEY=") {
			t.Errorf("ANTHROPIC_API_KEY should be removed from env")
		}
	}
}
