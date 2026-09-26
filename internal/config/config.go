// Package config models and loads the providers.json registry.
package config

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

//go:embed providers.json
var defaultProviders []byte

// Provider describes a single upstream provider.
type Provider struct {
	DisplayName          string            `json:"displayName"`
	Endpoint             string            `json:"endpoint"`
	KeyEnv               string            `json:"keyEnv"`
	AuthHeader           string            `json:"authHeader"` // "bearer" | "x-api-key"
	WireFormat           string            `json:"wireFormat"` // "anthropic" | "openai" | "gemini"
	SetupURL             string            `json:"setupUrl,omitempty"`
	StreamUsageReporting *string           `json:"streamUsageReporting,omitempty"`
	ExtraHeaders         map[string]string `json:"extraHeaders,omitempty"`
	Fallback             []string          `json:"fallback,omitempty"`
	MonthlyBudget        *float64          `json:"monthlyBudget,omitempty"`
	NoAuth               bool              `json:"noAuth,omitempty"`
	NoAutoFallback       bool              `json:"noAutoFallback,omitempty"`
}

// Thinking configures extended thinking/reasoning for a model.
type Thinking struct {
	Type         string `json:"type"`
	BudgetTokens int64  `json:"budget_tokens"`
}

// SlotConfig maps the five model slots to provider:model specs.
type SlotConfig struct {
	Name   string `json:"name"`
	Opus   string `json:"opus"`
	Sonnet string `json:"sonnet"`
	Haiku  string `json:"haiku"`
	Sub    string `json:"sub"`
	Fable  string `json:"fable"`
}

// Pricing is per-million-token USD pricing.
type Pricing struct {
	Input          float64 `json:"input"`
	InputCacheHit  float64 `json:"input_cache_hit,omitempty"`
	InputCacheMiss float64 `json:"input_cache_miss,omitempty"`
	Output         float64 `json:"output"`
}

// Config is the full providers.json registry.
type Config struct {
	Providers        map[string]Provider   `json:"providers"`
	Aliases          map[string]string     `json:"aliases"`
	ContextLimits    map[string]int64      `json:"contextLimits"`
	Thinking         map[string]Thinking   `json:"thinking"`
	CompactionWindow map[string]int64      `json:"compactionWindow"`
	Configs          map[string]SlotConfig `json:"configs"`
	Pricing          map[string]Pricing    `json:"pricing"`
}

// LoadDefault parses the embedded default registry.
func LoadDefault() (*Config, error) {
	return Parse(defaultProviders)
}

// Parse unmarshals providers.json bytes.
func Parse(data []byte) (*Config, error) {
	cleaned, err := stripComments(data)
	if err != nil {
		return nil, fmt.Errorf("parse providers.json: %w", err)
	}
	var c Config
	if err := json.Unmarshal(cleaned, &c); err != nil {
		return nil, fmt.Errorf("parse providers.json: %w", err)
	}
	return &c, nil
}

// stripComments recursively removes "_comment" keys (string metadata that
// doesn't fit the typed maps) so typed unmarshaling can proceed.
func stripComments(raw json.RawMessage) (json.RawMessage, error) {
	if len(bytes.TrimSpace(raw)) == 0 || bytes.TrimSpace(raw)[0] != '{' {
		// Not a JSON object (null, array, string, number, bool): leave unchanged.
		return raw, nil
	}
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(raw, &obj); err != nil {
		return raw, nil
	}
	out := make(map[string]json.RawMessage, len(obj))
	for k, v := range obj {
		if k == "_comment" {
			continue
		}
		cleaned, err := stripComments(v)
		if err != nil {
			return nil, err
		}
		out[k] = cleaned
	}
	return json.Marshal(out)
}

// LoadUser reads a user override from configDir, else the embedded default.
func LoadUser(configDir string) (*Config, error) {
	path := filepath.Join(configDir, "providers.json")
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return LoadDefault()
		}
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	return Parse(data)
}

// DefaultConfigDir returns ~/.defiant-claude.
func DefaultConfigDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".defiant-claude"), nil
}

// SplitSpec splits "provider:model" into (provider, model).
// A bare spec with no ':' returns ("", spec).
func SplitSpec(spec string) (provider, model string) {
	for i := 0; i < len(spec); i++ {
		if spec[i] == ':' {
			return spec[:i], spec[i+1:]
		}
	}
	return "", spec
}

// Lint validates the registry and returns a list of problems (empty = OK).
func (c *Config) Lint() []string {
	var problems []string

	for name, p := range c.Providers {
		if p.Endpoint == "" {
			problems = append(problems, fmt.Sprintf("provider %q: missing endpoint", name))
		}
		if p.KeyEnv == "" && !p.NoAuth {
			problems = append(problems, fmt.Sprintf("provider %q: missing keyEnv (and noAuth=false)", name))
		}
		switch p.WireFormat {
		case "anthropic", "openai", "gemini":
		default:
			problems = append(problems, fmt.Sprintf("provider %q: unknown wireFormat %q", name, p.WireFormat))
		}
		for _, f := range p.Fallback {
			if _, ok := c.Providers[f]; !ok {
				problems = append(problems, fmt.Sprintf("provider %q: fallback %q is not a defined provider", name, f))
			}
		}
	}

	for name, sc := range c.Configs {
		slots := []struct{ n, v string }{
			{"opus", sc.Opus}, {"sonnet", sc.Sonnet}, {"haiku", sc.Haiku}, {"sub", sc.Sub}, {"fable", sc.Fable},
		}
		for _, s := range slots {
			if s.v == "" {
				problems = append(problems, fmt.Sprintf("config %q: slot %q is empty", name, s.n))
				continue
			}
			prov, _ := SplitSpec(s.v)
			if prov == "" {
				if _, ok := c.Aliases[s.v]; !ok {
					problems = append(problems, fmt.Sprintf("config %q: slot %q: alias/model %q not found", name, s.n, s.v))
				}
				continue
			}
			if _, ok := c.Providers[prov]; !ok {
				problems = append(problems, fmt.Sprintf("config %q: slot %q: provider %q not defined", name, s.n, prov))
			}
		}
	}

	return problems
}
