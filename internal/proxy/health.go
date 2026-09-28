package proxy

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/poiarnoia/defiant-claude/internal/resilience"
)

// handleHealth returns a JSON snapshot of proxy and per-provider health.
func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	providers := make(map[string]any)
	for k, st := range s.breakers.Snapshot() {
		var avgMs int64
		if st.Requests > 0 {
			avgMs = st.TotalMs / st.Requests
		}
		providers[k] = map[string]any{
			"requests":       st.Requests,
			"successes":      st.Successes,
			"fails":          st.Fails,
			"avgMs":          avgMs,
			"inputTokens":    st.InputTokens,
			"outputTokens":   st.OutputTokens,
			"circuitBreaker": s.breakers.State(k).String(),
		}
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"status":    "ok",
		"uptime":    int64(time.Since(s.startTime).Seconds()),
		"version":   s.version,
		"providers": providers,
	})
}

// handleMetrics exposes Prometheus-format metrics for the proxy and providers.
func (s *Server) handleMetrics(w http.ResponseWriter, _ *http.Request) {
	const pf = "defiant_claude"
	var b strings.Builder
	writeCounter := func(name, help string, value int64, label string) {
		fmt.Fprintf(&b, "# HELP %s %s\n", pf+name, help)
		fmt.Fprintf(&b, "# TYPE %s counter\n", pf+name)
		fmt.Fprintf(&b, "%s%s{%s} %d\n", pf, name, label, value)
	}

	fmt.Fprintf(&b, "# HELP %s_uptime_seconds Proxy uptime in seconds.\n", pf)
	fmt.Fprintf(&b, "# TYPE %s_uptime_seconds gauge\n", pf)
	fmt.Fprintf(&b, "%s_uptime_seconds %d\n", pf, int64(time.Since(s.startTime).Seconds()))

	for k, st := range s.breakers.Snapshot() {
		label := `provider="` + k + `"`
		writeCounter("_requests_total", "Total requests per provider.", st.Requests, label)
		writeCounter("_successes_total", "Successful requests per provider.", st.Successes, label)
		writeCounter("_fails_total", "Failed requests per provider (429 excluded).", st.Fails, label)

		stateVal := 0
		switch s.breakers.State(k) {
		case resilience.StateOpen:
			stateVal = 1
		case resilience.StateHalfOpen:
			stateVal = 2
		}
		fmt.Fprintf(&b, "# HELP %s_circuit_breaker_state Circuit breaker (0=CLOSED, 1=OPEN, 2=HALF_OPEN).\n", pf)
		fmt.Fprintf(&b, "# TYPE %s_circuit_breaker_state gauge\n", pf)
		fmt.Fprintf(&b, "%s_circuit_breaker_state{%s} %d\n", pf, label, stateVal)
	}
	w.Header().Set("Content-Type", "text/plain; version=0.0.4")
	_, _ = w.Write([]byte(b.String()))
}
