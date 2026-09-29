// Package servertools executes web search and web fetch server-side, used to
// populate Claude Code's web_search/web_fetch tool results when the upstream
// provider can't run those tools itself.
package servertools

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/Poiar/defiant-claude/internal/ssrf"
)

const (
	maxFetchBytes = 1 << 20 // 1 MiB cap on raw response
	maxFetchText  = 50000   // cap on extracted text
)

// Fetch retrieves an https URL, SSRF-validating the scheme and every resolved
// address, and returns the page text with HTML stripped. Redirects are
// followed and re-validated per hop; each connection is pinned to a validated
// IP so a re-binding DNS response can't redirect it to a private address (TLS
// still verifies the hostname against the certificate).
func Fetch(rawURL string) (string, error) {
	if _, err := ssrf.Validate(rawURL, false); err != nil { // https-only
		return "", err
	}

	client := &http.Client{
		Transport: &http.Transport{DialContext: safeDialContext(10 * time.Second)},
		Timeout:   30 * time.Second,
	}

	resp, err := client.Get(rawURL)
	if err != nil {
		return "", fmt.Errorf("fetch failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxFetchBytes))
	if err != nil {
		return "", fmt.Errorf("read failed: %w", err)
	}

	text := stripHTML(string(body))
	if len(text) > maxFetchText {
		text = text[:maxFetchText]
	}
	if text == "" {
		return "Fetched " + rawURL + " but could not extract text content.", nil
	}
	return text, nil
}

// safeDialContext returns a DialContext that resolves the host, rejects any
// blocked address, and connects to the first validated IPv4 (or IPv6). Each
// redirect is re-validated because the transport dials per request.
func safeDialContext(timeout time.Duration) func(ctx context.Context, network, addr string) (net.Conn, error) {
	dialer := &net.Dialer{Timeout: timeout}
	return func(ctx context.Context, network, addr string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(addr)
		if err != nil {
			return nil, err
		}
		ips, err := net.LookupIP(host)
		if err != nil {
			return nil, err
		}
		var chosen net.IP
		for _, ip := range ips {
			if ssrf.IsBlocked(ip) {
				return nil, fmt.Errorf("blocked IP %s for %q", ip, host)
			}
			if chosen == nil {
				chosen = ip
			}
			if ip.To4() != nil {
				chosen = ip
				break
			}
		}
		if chosen == nil {
			return nil, fmt.Errorf("no usable addresses for %q", host)
		}
		return dialer.DialContext(ctx, network, net.JoinHostPort(chosen.String(), port))
	}
}

// stripHTML removes script/style blocks and all tags, decodes common HTML
// entities, and collapses whitespace.
func stripHTML(s string) string {
	for _, tag := range []string{"script", "style", "noscript"} {
		s = removeBlocks(s, tag)
	}
	var out strings.Builder
	inTag := false
	for _, r := range s {
		switch r {
		case '<':
			inTag = true
		case '>':
			inTag = false
		default:
			if !inTag {
				out.WriteRune(r)
			}
		}
	}
	text := strings.NewReplacer(
		"&amp;", "&", "&lt;", "<", "&gt;", ">", "&quot;", `"`, "&#39;", "'", "&#x27;", "'",
	).Replace(out.String())
	return strings.Join(strings.Fields(text), " ")
}

// removeBlocks drops "<tag ...>...</tag>" spans (case-insensitive) from s.
func removeBlocks(s, tag string) string {
	var b strings.Builder
	open := "<" + tag
	closeTag := "</" + tag + ">"
	rest := s
	for {
		i := strings.Index(strings.ToLower(rest), open)
		if i < 0 {
			b.WriteString(rest)
			return b.String()
		}
		b.WriteString(rest[:i])
		rest = rest[i:]
		j := strings.Index(strings.ToLower(rest), closeTag)
		if j < 0 {
			return b.String() // unterminated block — drop the rest
		}
		rest = rest[j+len(closeTag):]
	}
}
