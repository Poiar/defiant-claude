package main

import (
	"fmt"
	"net"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/Poiar/defiant-claude/internal/config"
	"github.com/Poiar/defiant-claude/internal/crypto"
)

// runDoctor is a pre-flight system check: config lint plus, for every provider
// the active backend can route to, API-key presence/decryptability and TCP
// reachability of the endpoint host. Exit 0 = all ready.
func runDoctor(args []string) int {
	backend := "ds"
	if len(args) >= 2 && args[0] == "-b" {
		backend = args[1]
	}

	cfg, err := loadConfig()
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		return 1
	}

	fmt.Printf("config: %d providers, %d named configs, %d aliases\n",
		len(cfg.Providers), len(cfg.Configs), len(cfg.Aliases))
	probs := cfg.Lint()
	if len(probs) == 0 {
		fmt.Println("lint:   OK")
	} else {
		fmt.Printf("lint:   %d problem(s)\n", len(probs))
		for _, p := range probs {
			fmt.Printf("        - %s\n", p)
		}
	}

	sc, ok := cfg.Configs[backend]
	if !ok {
		fmt.Fprintf(os.Stderr, "error: unknown backend %q\n", backend)
		return 1
	}

	keys := backendProviderKeys(cfg, sc)
	fmt.Printf("\nbackend %q: %d provider(s)\n", backend, len(keys))

	var missing, unreachable int
	for _, key := range keys {
		p := cfg.Providers[key]
		ks := keyStatus(p)
		if ks == "missing" {
			missing++
		}
		rs, rtt := reachable(p.Endpoint)
		if rs == "unreachable" {
			unreachable++
		}
		if rtt >= 0 {
			fmt.Printf("  %-6s key=%-20s endpoint=%-10s %s (%dms)\n", key, ks, rs, p.Endpoint, rtt.Milliseconds())
		} else {
			fmt.Printf("  %-6s key=%-20s endpoint=%-10s %s\n", key, ks, rs, p.Endpoint)
		}
	}

	switch {
	case len(probs) > 0:
		fmt.Printf("\nFAIL: config has %d lint problem(s)\n", len(probs))
		return 1
	case missing > 0 || unreachable > 0:
		fmt.Printf("\nFAIL: %d missing key(s), %d unreachable endpoint(s)\n", missing, unreachable)
		return 1
	default:
		fmt.Println("\nOK: all providers ready")
		return 0
	}
}

// backendProviderKeys returns the distinct provider keys the backend can route
// to: its five slots plus each provider's one-level fallback chain (matching
// the proxy's own fallback resolution).
func backendProviderKeys(cfg *config.Config, sc config.SlotConfig) []string {
	seen := map[string]bool{}
	var out []string
	add := func(prov string) {
		if prov != "" && !seen[prov] {
			seen[prov] = true
			out = append(out, prov)
		}
	}
	for _, spec := range []string{sc.Opus, sc.Sonnet, sc.Haiku, sc.Sub, sc.Fable} {
		prov, _ := config.SplitSpec(spec)
		add(prov)
	}
	for _, key := range append([]string(nil), out...) {
		for _, fb := range cfg.Providers[key].Fallback {
			add(fb)
		}
	}
	return out
}

// keyStatus reports a provider's key state: ok, missing, no-auth,
// encrypted-ok, encrypted (no master key), or bad-encryption.
func keyStatus(p config.Provider) string {
	if p.NoAuth || p.KeyEnv == "" {
		return "no-auth"
	}
	raw := os.Getenv(p.KeyEnv)
	if raw == "" {
		return "missing"
	}
	if !strings.HasPrefix(raw, "$aes256gcm:") {
		return "ok"
	}
	master := os.Getenv("DEFIANT_CLAUDE_ENCRYPTION_KEY")
	if master == "" {
		return "encrypted (no key)"
	}
	if _, err := crypto.Decrypt(raw, master); err != nil {
		return "bad-encryption"
	}
	return "encrypted-ok"
}

// reachable dials the endpoint's host:port and reports reachability + RTT.
func reachable(endpoint string) (string, time.Duration) {
	u, err := url.Parse(endpoint)
	if err != nil || u.Host == "" {
		return "bad-url", -1
	}
	host := u.Hostname()
	port := u.Port()
	if port == "" {
		if u.Scheme == "http" {
			port = "80"
		} else {
			port = "443"
		}
	}
	start := time.Now()
	conn, err := net.DialTimeout("tcp", net.JoinHostPort(host, port), 3*time.Second)
	if err != nil {
		return "unreachable", -1
	}
	_ = conn.Close()
	return "reachable", time.Since(start)
}
