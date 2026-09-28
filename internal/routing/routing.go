// Package routing resolves an incoming Claude Code model name to a concrete
// upstream target (provider + model + auth). It is a pure, I/O-free layer —
// key resolution and network happen in the proxy package, so routing is easy
// to unit-test in isolation.
package routing

import (
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/Poiar/defiant-claude/internal/config"
	"github.com/Poiar/defiant-claude/internal/crypto"
)

// Target is a fully-resolved upstream destination for one request.
type Target struct {
	ProviderKey  string            // e.g. "ds", "or"
	Endpoint     string            // upstream base URL
	Model        string            // model name to send upstream
	Slot         string            // capability slot ("opus"/"sonnet"/...), "" if unknown
	AuthHeader   string            // "bearer" | "x-api-key"
	APIKey       string            // resolved from the environment
	WireFormat   string            // "anthropic" | "openai" | "gemini"
	ExtraHeaders map[string]string // static headers to inject
	Fallbacks    []string          // fallback provider keys, in order
	NoAuth       bool              // skip auth header entirely (local providers)
}

// slotPrefixes are the reserved model-name prefixes that select a slot.
// Note: these must not collide with provider keys — config-lint enforces that.
var slotPrefixes = []string{"sonnet", "opus", "haiku", "subagent", "fable"}

// Resolver resolves models against a fixed provider registry and one active
// backend config (a named entry in providers.json "configs").
type Resolver struct {
	cfg         *config.Config
	backend     config.SlotConfig
	overrides   map[string]string // slot → "provider:model" override
	reverseSlot map[string]string // claude model name → slot ("opus"/"sonnet"/"haiku")
}

// NewResolver builds a resolver for backendName (a key in providers.json
// "configs"). If backendName is unknown, the first config entry is used.
func NewResolver(cfg *config.Config, backendName string) *Resolver {
	r := &Resolver{
		cfg:         cfg,
		reverseSlot: map[string]string{},
	}
	if sc, ok := cfg.Configs[backendName]; ok {
		r.backend = sc
	} else {
		for _, sc := range cfg.Configs {
			r.backend = sc
			break
		}
	}
	// The opus/sonnet/haiku aliases name the canonical Claude models, which is
	// how a bare incoming model like "claude-sonnet-4-6" is mapped to a slot.
	for slot, alias := range cfg.Aliases {
		switch slot {
		case "opus", "sonnet", "haiku":
			r.reverseSlot[alias] = slot
		}
	}
	return r
}

// SetOverrides installs slot overrides (from ~/.defiant-claude/slot-overrides.json).
func (r *Resolver) SetOverrides(m map[string]string) { r.overrides = m }

// Resolve maps an incoming model string to a Target.
func (r *Resolver) Resolve(model string) (Target, error) {
	model = strings.ReplaceAll(model, "[1m]", "") // 1M-context hint marker
	model = strings.TrimSpace(model)
	if model == "" {
		return Target{}, errors.New("empty model")
	}

	slot := "" // capability slot, tracked so fallbacks can tier-match

	// 1. Slot prefix ("sonnet:...") → slot override if present, else strip.
	if s, rest, ok := cutSlotPrefix(model); ok {
		slot = s
		if v, ok := r.overrides[s]; ok && v != "" {
			model = v
		} else {
			model = rest
		}
	}

	// 2. Explicit provider prefix ("ds:deepseek-v4-pro", "ds:v4"). The model
	//    part is alias-expanded inside resolve.
	if prov, m, ok := strings.Cut(model, ":"); ok {
		if _, exists := r.cfg.Providers[prov]; exists {
			t, err := r.resolve(prov, m)
			t.Slot = slot
			return t, err
		}
	}

	// 3. Alias expansion ("sonnet" → "claude-sonnet-4-6"), bounded to avoid cycles.
	model = r.expandAlias(model)

	// 4. Bare Claude model → slot → the active backend's spec for that slot.
	if s, ok := r.reverseSlot[model]; ok {
		if spec := r.slotSpec(s); spec != "" {
			if prov, m, ok := strings.Cut(spec, ":"); ok {
				t, err := r.resolve(prov, m)
				t.Slot = s
				return t, err
			}
		}
	}

	return Target{}, fmt.Errorf("unable to resolve model %q to a provider", model)
}

// expandAlias repeatedly resolves model aliases, bounded to avoid cycles.
func (r *Resolver) expandAlias(model string) string {
	for i := 0; i < 8; i++ {
		if a, ok := r.cfg.Aliases[model]; ok {
			model = a
			continue
		}
		break
	}
	return model
}

// resolve builds a Target for a provider key + upstream model name.
func (r *Resolver) resolve(provKey, model string) (Target, error) {
	p, ok := r.cfg.Providers[provKey]
	if !ok {
		return Target{}, fmt.Errorf("unknown provider %q", provKey)
	}
	return Target{
		ProviderKey:  provKey,
		Endpoint:     p.Endpoint,
		Model:        r.expandAlias(model),
		AuthHeader:   p.AuthHeader,
		APIKey:       keyFromEnv(p),
		WireFormat:   p.WireFormat,
		ExtraHeaders: p.ExtraHeaders,
		Fallbacks:    p.Fallback,
		NoAuth:       p.NoAuth,
	}, nil
}

// FallbackTargets resolves the fallback chain for a primary target, in order.
// Providers that can't be resolved (unknown key) are skipped.
func (r *Resolver) FallbackTargets(primary Target) []Target {
	out := make([]Target, 0, len(primary.Fallbacks))
	for _, fbKey := range primary.Fallbacks {
		t, err := r.resolveFallback(primary, fbKey)
		if err != nil {
			continue
		}
		out = append(out, t)
	}
	return out
}

// resolveFallback resolves one fallback provider. When the primary target has
// a known slot, the fallback provider's own spec for that slot is used (tier
// matching — different providers name the same model differently). Otherwise
// it falls back to the same model name on the fallback provider.
func (r *Resolver) resolveFallback(primary Target, fbKey string) (Target, error) {
	if primary.Slot != "" {
		if sc, ok := r.cfg.Configs[fbKey]; ok {
			if spec := specForSlot(sc, primary.Slot); spec != "" {
				if prov, m, ok := strings.Cut(spec, ":"); ok {
					t, err := r.resolve(prov, m)
					t.Slot = primary.Slot
					return t, err
				}
			}
		}
	}
	t, err := r.resolve(fbKey, primary.Model)
	t.Slot = primary.Slot
	return t, err
}

// slotSpec returns the "provider:model" spec for a slot, honouring overrides.
func (r *Resolver) slotSpec(slot string) string {
	if v, ok := r.overrides[slot]; ok && v != "" {
		return v
	}
	return specForSlot(r.backend, slot)
}

// specForSlot returns a named config's spec for a capability slot.
func specForSlot(sc config.SlotConfig, slot string) string {
	switch slot {
	case "opus":
		return sc.Opus
	case "sonnet":
		return sc.Sonnet
	case "haiku":
		return sc.Haiku
	case "sub", "subagent":
		return sc.Sub
	case "fable":
		return sc.Fable
	}
	return ""
}

func cutSlotPrefix(model string) (slot, rest string, ok bool) {
	for _, s := range slotPrefixes {
		if strings.HasPrefix(model, s+":") {
			return s, model[len(s)+1:], true
		}
	}
	return "", "", false
}

// keyFromEnv reads the provider's API key from the environment, decrypting
// "$aes256gcm:..." values with DEFIANT_CLAUDE_ENCRYPTION_KEY.
func keyFromEnv(p config.Provider) string {
	if p.KeyEnv == "" || p.NoAuth {
		return ""
	}
	raw := os.Getenv(p.KeyEnv)
	if strings.HasPrefix(raw, "$aes256gcm:") {
		master := os.Getenv("DEFIANT_CLAUDE_ENCRYPTION_KEY")
		if master == "" {
			return ""
		}
		decrypted, err := crypto.Decrypt(raw, master)
		if err != nil {
			return ""
		}
		return decrypted
	}
	return raw
}
