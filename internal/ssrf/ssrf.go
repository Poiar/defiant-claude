// Package ssrf validates outbound URLs against server-side request forgery:
// it rejects non-HTTP(S) schemes and any host that resolves to a private,
// loopback, link-local, carrier-grade-NAT, or cloud-metadata address. The
// validated IPs are returned so the caller can pin its connection (defense
// against DNS rebinding at connect time).
package ssrf

import (
	"fmt"
	"net"
	"net/url"
)

// metadataIPs are cloud instance-metadata endpoints that must always be
// blocked, regardless of range checks.
var metadataIPs = map[string]bool{
	"169.254.169.254": true, // AWS / GCP / Azure IMDS
	"169.254.169.253": true,
	"100.100.100.200": true, // Alibaba Cloud IMDS
	"fd00:ec2::254":   true,
}

// Validate parses rawURL, checks its scheme, resolves the host, and returns
// every non-blocked resolved IP. Any blocked address fails the whole URL.
// allowHTTP permits plain http; otherwise only https is accepted.
func Validate(rawURL string, allowHTTP bool) ([]net.IP, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return nil, fmt.Errorf("invalid URL %q: %w", rawURL, err)
	}
	switch u.Scheme {
	case "https":
	case "http":
		if !allowHTTP {
			return nil, fmt.Errorf("http URL blocked: %q", rawURL)
		}
	default:
		return nil, fmt.Errorf("blocked scheme %q in %q", u.Scheme, rawURL)
	}
	host := u.Hostname()
	if host == "" {
		return nil, fmt.Errorf("missing host in %q", rawURL)
	}

	ips, err := net.LookupIP(host)
	if err != nil {
		return nil, fmt.Errorf("DNS resolution failed for %q: %w", host, err)
	}

	var valid []net.IP
	for _, ip := range ips {
		if IsBlocked(ip) {
			return nil, fmt.Errorf("blocked IP %s for host %q", ip, host)
		}
		valid = append(valid, ip)
	}
	if len(valid) == 0 {
		return nil, fmt.Errorf("no usable addresses for %q", host)
	}
	return valid, nil
}

// IsBlocked reports whether an IP is private, loopback, link-local,
// unspecified, carrier-grade NAT, or a cloud metadata endpoint.
func IsBlocked(ip net.IP) bool {
	if v4 := ip.To4(); v4 != nil {
		ip = v4
		if metadataIPs[ip.String()] {
			return true
		}
		return ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() ||
			ip.IsLinkLocalMulticast() || ip.IsUnspecified() || isCGNAT(ip)
	}
	if metadataIPs[ip.String()] {
		return true
	}
	return ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() ||
		ip.IsLinkLocalMulticast() || ip.IsUnspecified()
}

// isCGNAT reports whether ip is in 100.64.0.0/10 (RFC 6598 carrier-grade NAT).
// Go's net.IP.IsPrivate does not cover this range.
func isCGNAT(ip net.IP) bool {
	if v4 := ip.To4(); v4 != nil {
		return v4[0] == 100 && v4[1] >= 64 && v4[1] <= 127
	}
	return false
}
