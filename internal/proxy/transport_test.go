package proxy

import (
	"fmt"
	"testing"
)

func TestClassifyTransportError(t *testing.T) {
	cases := []struct {
		msg    string
		label  string
		status int
	}{
		{"dial tcp: lookup foo.bar: no such host", "DNS resolution failed", 502},
		{"dial tcp 127.0.0.1:1: connect: connection refused", "Connection refused by upstream", 502},
		{"x509: certificate signed by unknown authority", "TLS connection failed", 502},
		{"context deadline exceeded", "Upstream connection timed out", 504},
		{"context canceled", "Request aborted", 499},
		{"something totally unknown", "connection failure", 502},
	}
	for _, c := range cases {
		label, status := classifyTransportError(fmt.Errorf("%s", c.msg))
		if label != c.label || status != c.status {
			t.Errorf("classify(%q) = (%q, %d), want (%q, %d)", c.msg, label, status, c.label, c.status)
		}
	}
}
