package proxy

import "strings"

// classifyTransportError maps a Go network error to a human-readable label
// and the HTTP status the proxy should report, mirroring the TS
// transport-errors classifier.
func classifyTransportError(err error) (label string, httpStatus int) {
	msg := strings.ToLower(err.Error())
	switch {
	case strings.Contains(msg, "no such host"),
		strings.Contains(msg, "name or service not known"),
		strings.Contains(msg, "getaddrinfo"),
		strings.Contains(msg, "server misbehaving"),
		strings.Contains(msg, "eai_again"):
		return "DNS resolution failed", 502
	case strings.Contains(msg, "connection refused"):
		return "Connection refused by upstream", 502
	case strings.Contains(msg, "connection reset"):
		return "Connection reset by upstream", 502
	case strings.Contains(msg, "certificate"),
		strings.Contains(msg, "tls"),
		strings.Contains(msg, "x509"):
		return "TLS connection failed", 502
	case strings.Contains(msg, "i/o timeout"),
		strings.Contains(msg, "deadline exceeded"),
		strings.Contains(msg, "context deadline"):
		return "Upstream connection timed out", 504
	case strings.Contains(msg, "context canceled"):
		return "Request aborted", 499
	case strings.Contains(msg, "broken pipe"):
		return "Upstream connection lost", 502
	case strings.Contains(msg, "network is unreachable"),
		strings.Contains(msg, "no route to host"):
		return "Network unreachable", 502
	default:
		return "connection failure", 502
	}
}
