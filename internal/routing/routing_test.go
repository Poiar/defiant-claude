package routing

import (
	"testing"

	"github.com/Poiar/defiant-claude/internal/config"
)

func testConfig() *config.Config {
	return &config.Config{
		Providers: map[string]config.Provider{
			"ds": {Endpoint: "https://api.deepseek.com/anthropic", KeyEnv: "DS_KEY", AuthHeader: "x-api-key", WireFormat: "anthropic"},
			"or": {Endpoint: "https://openrouter.ai/api/v1", KeyEnv: "OR_KEY", AuthHeader: "bearer", WireFormat: "openai"},
		},
		Aliases: map[string]string{
			"sonnet": "claude-sonnet-4-6",
			"opus":   "claude-opus-4-7",
			"haiku":  "claude-haiku-4-5",
			"v4":     "deepseek-v4-pro",
		},
		Configs: map[string]config.SlotConfig{
			"ds": {Name: "ds", Opus: "ds:deepseek-v4-pro", Sonnet: "ds:deepseek-v4-pro", Haiku: "ds:deepseek-v4-flash", Sub: "ds:deepseek-v4-flash", Fable: "ds:deepseek-v4-pro"},
		},
	}
}

func TestResolve(t *testing.T) {
	r := NewResolver(testConfig(), "ds")
	cases := []struct {
		model     string
		wantProv  string
		wantModel string
		wantErr   bool
	}{
		{"claude-sonnet-4-6", "ds", "deepseek-v4-pro", false},
		{"claude-opus-4-7", "ds", "deepseek-v4-pro", false},
		{"claude-haiku-4-5", "ds", "deepseek-v4-flash", false},
		{"sonnet", "ds", "deepseek-v4-pro", false},          // bare slot alias
		{"ds:v4", "ds", "deepseek-v4-pro", false},           // provider prefix + model alias
		{"ds:deepseek-v4-flash", "ds", "deepseek-v4-flash", false},
		{"sonnet:or:foo", "or", "foo", false}, // slot prefix stripped → provider prefix
		{"[1m]claude-sonnet-4-6", "ds", "deepseek-v4-pro", false},
		{"or:some-model", "or", "some-model", false},
		{"v4", "", "", true}, // bare upstream model, no provider prefix, no slot
		{"garbage", "", "", true},
		{"", "", "", true},
	}
	for _, c := range cases {
		t.Run(c.model, func(t *testing.T) {
			got, err := r.Resolve(c.model)
			if c.wantErr {
				if err == nil {
					t.Fatalf("Resolve(%q) = %+v, want error", c.model, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("Resolve(%q) unexpected error: %v", c.model, err)
			}
			if got.ProviderKey != c.wantProv || got.Model != c.wantModel {
				t.Fatalf("Resolve(%q) = %s:%s, want %s:%s", c.model, got.ProviderKey, got.Model, c.wantProv, c.wantModel)
			}
		})
	}
}

func TestResolveWireFormat(t *testing.T) {
	r := NewResolver(testConfig(), "ds")
	got, err := r.Resolve("or:foo")
	if err != nil {
		t.Fatal(err)
	}
	if got.WireFormat != "openai" {
		t.Fatalf("wireFormat = %q, want openai", got.WireFormat)
	}
	if got.AuthHeader != "bearer" {
		t.Fatalf("authHeader = %q, want bearer", got.AuthHeader)
	}
}

func TestSlotOverride(t *testing.T) {
	r := NewResolver(testConfig(), "ds")
	r.SetOverrides(map[string]string{"sonnet": "or:overridden-model"})
	got, err := r.Resolve("sonnet:ds:deepseek-v4-pro")
	if err != nil {
		t.Fatal(err)
	}
	if got.ProviderKey != "or" || got.Model != "overridden-model" {
		t.Fatalf("got %s:%s, want or:overridden-model", got.ProviderKey, got.Model)
	}
}

func fallbackConfig() *config.Config {
	return &config.Config{
		Providers: map[string]config.Provider{
			"ds": {Endpoint: "https://ds", KeyEnv: "DS_KEY", AuthHeader: "x-api-key", WireFormat: "anthropic", Fallback: []string{"or"}},
			"or": {Endpoint: "https://or", KeyEnv: "OR_KEY", AuthHeader: "bearer", WireFormat: "openai"},
		},
		Aliases: map[string]string{
			"sonnet": "claude-sonnet-4-6",
		},
		Configs: map[string]config.SlotConfig{
			"ds": {Name: "ds", Sonnet: "ds:deepseek-v4-pro"},
			"or": {Name: "or", Sonnet: "or:openrouter/sonnet-model"},
		},
	}
}

func TestFallbackTierMatching(t *testing.T) {
	r := NewResolver(fallbackConfig(), "ds")
	primary, err := r.Resolve("claude-sonnet-4-6")
	if err != nil {
		t.Fatal(err)
	}
	if primary.Slot != "sonnet" {
		t.Fatalf("slot = %q, want sonnet", primary.Slot)
	}
	fbs := r.FallbackTargets(primary)
	if len(fbs) != 1 {
		t.Fatalf("got %d fallbacks, want 1", len(fbs))
	}
	if fbs[0].ProviderKey != "or" || fbs[0].Model != "openrouter/sonnet-model" {
		t.Fatalf("fallback = %s:%s, want or:openrouter/sonnet-model", fbs[0].ProviderKey, fbs[0].Model)
	}
}

func TestFallbackNoSlot(t *testing.T) {
	r := NewResolver(fallbackConfig(), "ds")
	primary, err := r.Resolve("ds:deepseek-v4-pro")
	if err != nil {
		t.Fatal(err)
	}
	if primary.Slot != "" {
		t.Fatalf("slot = %q, want empty", primary.Slot)
	}
	fbs := r.FallbackTargets(primary)
	if len(fbs) != 1 {
		t.Fatalf("got %d fallbacks, want 1", len(fbs))
	}
	// Best-effort: same model name on the fallback provider.
	if fbs[0].ProviderKey != "or" || fbs[0].Model != "deepseek-v4-pro" {
		t.Fatalf("fallback = %s:%s, want or:deepseek-v4-pro", fbs[0].ProviderKey, fbs[0].Model)
	}
}
