package main

import (
	"net"
	"testing"

	"github.com/Poiar/defiant-claude/internal/config"
)

func TestBackendProviderKeys(t *testing.T) {
	cfg := &config.Config{
		Providers: map[string]config.Provider{
			"ds": {Fallback: []string{"or"}},
			"or": {Fallback: []string{"gr"}},
		},
	}
	sc := config.SlotConfig{
		Opus: "ds:a", Sonnet: "ds:a", Haiku: "ds:b", Sub: "ds:b", Fable: "ds:a",
	}
	keys := backendProviderKeys(cfg, sc)
	// Slots resolve to ds; ds's fallback chain adds or. gr is two levels deep
	// (or's own fallback) and is NOT expanded — matching the proxy.
	if len(keys) != 2 || keys[0] != "ds" || keys[1] != "or" {
		t.Fatalf("keys = %v, want [ds or]", keys)
	}
}

func TestKeyStatus(t *testing.T) {
	t.Setenv("DC_TEST_KEY", "plain-secret")
	if s := keyStatus(config.Provider{KeyEnv: "DC_TEST_KEY"}); s != "ok" {
		t.Fatalf("plain key = %q, want ok", s)
	}
	if s := keyStatus(config.Provider{KeyEnv: "DC_TEST_MISSING"}); s != "missing" {
		t.Fatalf("absent key = %q, want missing", s)
	}
	if s := keyStatus(config.Provider{NoAuth: true}); s != "no-auth" {
		t.Fatalf("noAuth = %q, want no-auth", s)
	}
}

func TestReachable(t *testing.T) {
	if s, _ := reachable(""); s != "bad-url" {
		t.Fatalf("empty url = %q, want bad-url", s)
	}
	if s, _ := reachable("http://127.0.0.1:1"); s != "unreachable" {
		t.Fatalf("closed port = %q, want unreachable", s)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	if s, rtt := reachable("http://"+ln.Addr().String()); s != "reachable" || rtt < 0 {
		t.Fatalf("open port = %q (%v), want reachable", s, rtt)
	}
}
