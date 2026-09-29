package ssrf

import (
	"net"
	"strings"
	"testing"
)

func TestBlocked(t *testing.T) {
	cases := []struct {
		ip   string
		want bool
	}{
		{"127.0.0.1", true},       // loopback
		{"10.0.0.5", true},        // RFC1918
		{"172.16.0.1", true},      // RFC1918
		{"172.31.255.255", true},  // RFC1918 edge
		{"192.168.1.1", true},     // RFC1918
		{"169.254.169.254", true}, // link-local + metadata
		{"169.254.0.1", true},     // link-local
		{"100.64.0.1", true},      // CGNAT
		{"100.127.255.255", true}, // CGNAT edge
		{"0.0.0.0", true},         // unspecified
		{"100.100.100.200", true}, // metadata (also CGNAT)
		{"::1", true},             // IPv6 loopback
		{"fc00::1", true},         // IPv6 ULA
		{"fe80::1", true},         // IPv6 link-local
		{"fd00:ec2::254", true},   // metadata IPv6
		{"8.8.8.8", false},        // public
		{"1.1.1.1", false},        // public
		{"2606:4700:4700::1111", false}, // public IPv6
	}
	for _, c := range cases {
		ip := net.ParseIP(c.ip)
		if ip == nil {
			t.Fatalf("bad test IP %q", c.ip)
		}
		if got := IsBlocked(ip); got != c.want {
			t.Errorf("IsBlocked(%s) = %v, want %v", c.ip, got, c.want)
		}
	}
}

func TestValidate(t *testing.T) {
	// Non-HTTP scheme.
	if _, err := Validate("ftp://example.com/", true); err == nil {
		t.Error("ftp scheme should be blocked")
	}
	// HTTP blocked by default.
	if _, err := Validate("http://8.8.8.8/", false); err == nil {
		t.Error("http should be blocked when allowHTTP=false")
	}
	// HTTP allowed when requested.
	if _, err := Validate("http://8.8.8.8/", true); err != nil {
		t.Errorf("public http should be allowed: %v", err)
	}
	// HTTPS allowed.
	if _, err := Validate("https://8.8.8.8/", false); err != nil {
		t.Errorf("public https should be allowed: %v", err)
	}
	// Loopback literal blocked.
	if _, err := Validate("https://127.0.0.1/", false); err == nil {
		t.Error("loopback should be blocked")
	}
	// Private literal blocked.
	if _, err := Validate("https://192.168.1.1/", false); err == nil {
		t.Error("private IP should be blocked")
	}
	// Metadata literal blocked.
	if _, err := Validate("https://169.254.169.254/", false); err == nil {
		t.Error("metadata IP should be blocked")
	}
	// Validated addresses are returned.
	ips, err := Validate("https://8.8.8.8/", false)
	if err != nil || len(ips) == 0 || ips[0].String() != "8.8.8.8" {
		t.Errorf("Validate returned %v, %v; want [8.8.8.8]", ips, err)
	}
}

func TestValidateMissingHost(t *testing.T) {
	if _, err := Validate("https:///path", false); err == nil {
		t.Error("missing host should fail")
	}
	// Malformed URL.
	if _, err := Validate("://bad", false); err == nil {
		t.Error("malformed URL should fail")
	}
	// Error should be descriptive (no panic, no crash).
	_, err := Validate("https://nonexistent.invalid.example/", false)
	if err == nil || !strings.Contains(err.Error(), "DNS") {
		t.Errorf("DNS failure should produce a DNS error, got: %v", err)
	}
}
