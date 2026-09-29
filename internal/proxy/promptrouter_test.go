package proxy

import (
	"strings"
	"testing"

	"github.com/Poiar/defiant-claude/internal/config"
	"github.com/Poiar/defiant-claude/internal/routing"
)

func TestClassifyTier(t *testing.T) {
	cases := []struct {
		name string
		body string
		want string
	}{
		{"tools", `{"tools":[{"name":"x"}],"messages":[]}`, tierTool},
		{"trivial", `{"messages":[{"role":"user","content":"hi"}]}`, tierTrivial},
		{"code", `{"messages":[{"role":"user","content":"here is ` + "```" + `code` + "```" + `"}]}`, tierCode},
		{"chat", `{"messages":[{"role":"user","content":"hello there how are you doing today my friend, this is a normal conversation message"}]}`, tierChat},
		{"heavy", `{"messages":[{"role":"assistant","content":[{"type":"tool_use"},{"type":"tool_use"},{"type":"tool_use"}]}]}`, tierHeavy},
	}
	for _, c := range cases {
		if got := classifyTier([]byte(c.body)); got != c.want {
			t.Errorf("%s: classify = %s, want %s", c.name, got, c.want)
		}
	}
}

func TestCapMaxTokensInBody(t *testing.T) {
	out, err := capMaxTokensInBody([]byte(`{"model":"x","max_tokens":8000}`), tierTrivial)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(out), `"max_tokens":1024`) {
		t.Fatalf("trivial cap => %s", out)
	}

	out, _ = capMaxTokensInBody([]byte(`{"model":"x","max_tokens":8000}`), tierCode)
	if !strings.Contains(string(out), `"max_tokens":8000`) {
		t.Fatalf("code no-cap => %s", out)
	}

	out, _ = capMaxTokensInBody([]byte(`{"model":"x"}`), tierTrivial)
	if strings.Contains(string(out), "max_tokens") {
		t.Fatalf("no field => %s", out)
	}
}

func TestResolvePromptRoute(t *testing.T) {
	cfg := &config.Config{
		Providers: map[string]config.Provider{
			"ds": {Endpoint: "http://ds", WireFormat: "anthropic", NoAuth: true},
			"oc": {Endpoint: "http://oc", WireFormat: "anthropic", NoAuth: true},
		},
		Aliases: map[string]string{"sonnet": "claude-sonnet-4-6"},
		Configs: map[string]config.SlotConfig{
			"mock": {Name: "mock", Opus: "ds:pro", Sonnet: "ds:pro", Haiku: "ds:pro", Sub: "ds:pro", Fable: "ds:pro"},
		},
	}
	res := routing.NewResolver(cfg, "mock")

	primary, err := res.Resolve("claude-sonnet-4-6")
	if err != nil {
		t.Fatal(err)
	}
	if primary.ProviderKey != "ds" || primary.Model != "pro" {
		t.Fatalf("primary = %s:%s, want ds:pro", primary.ProviderKey, primary.Model)
	}

	// CODE stays on the primary (no route).
	if _, ok := resolvePromptRoute(res, primary, tierCode); ok {
		t.Fatal("CODE must not be routed")
	}
	// TRIVIAL → free OpenCode model.
	if tgt, ok := resolvePromptRoute(res, primary, tierTrivial); !ok || tgt.ProviderKey != "oc" || tgt.Model != "big-pickle" {
		t.Fatalf("TRIVIAL route = %+v (%v), want oc:big-pickle", tgt, ok)
	}
	// TOOL → DeepSeek flash.
	if tgt, ok := resolvePromptRoute(res, primary, tierTool); !ok || tgt.ProviderKey != "ds" || tgt.Model != "deepseek-v4-flash" {
		t.Fatalf("TOOL route = %+v (%v), want ds:deepseek-v4-flash", tgt, ok)
	}
}
