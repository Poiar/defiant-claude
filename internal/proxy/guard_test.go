package proxy

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Poiar/defiant-claude/internal/config"
)

func testConfig(endpoint, wireFormat string) *config.Config {
	return &config.Config{
		Providers: map[string]config.Provider{
			"mock": {Endpoint: endpoint, AuthHeader: "bearer", WireFormat: wireFormat, NoAuth: true},
		},
		Aliases: map[string]string{"sonnet": "claude-sonnet-4-6"},
		Configs: map[string]config.SlotConfig{
			"mock": {Name: "mock", Opus: "mock:m", Sonnet: "mock:m", Haiku: "mock:m", Sub: "mock:m", Fable: "mock:m"},
		},
	}
}

func TestRetryThenSuccess(t *testing.T) {
	old := retryBaseDelay
	retryBaseDelay = time.Millisecond
	defer func() { retryBaseDelay = old }()

	var attempts int32
	mock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if atomic.AddInt32(&attempts, 1) < 3 {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		io.WriteString(w, `{"id":"x","type":"message","role":"assistant","model":"m","content":[{"type":"text","text":"ok"}],"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}`)
	}))
	defer mock.Close()

	srv := New(testConfig(mock.URL, "anthropic"), "mock")
	req := httptest.NewRequest(http.MethodPost, "/v1/messages",
		strings.NewReader(`{"model":"claude-sonnet-4-6","stream":false,"max_tokens":16,"messages":[{"role":"user","content":"hi"}]}`))
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)

	if got := atomic.LoadInt32(&attempts); got != 3 {
		t.Fatalf("upstream attempts = %d, want 3 (2 retries)", got)
	}
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "ok") {
		t.Fatalf("status=%d body=%s, want 200 with upstream body", rec.Code, rec.Body.String())
	}
}

func TestNonRetryableStatusNotRetried(t *testing.T) {
	old := retryBaseDelay
	retryBaseDelay = time.Millisecond
	defer func() { retryBaseDelay = old }()

	var attempts int32
	mock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&attempts, 1)
		w.WriteHeader(http.StatusBadRequest)
		io.WriteString(w, `{"error":"bad model"}`)
	}))
	defer mock.Close()

	srv := New(testConfig(mock.URL, "anthropic"), "mock")
	req := httptest.NewRequest(http.MethodPost, "/v1/messages",
		strings.NewReader(`{"model":"claude-sonnet-4-6","stream":false,"max_tokens":16,"messages":[{"role":"user","content":"hi"}]}`))
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)

	if got := atomic.LoadInt32(&attempts); got != 1 {
		t.Fatalf("upstream attempts = %d, want 1 (400 must not retry)", got)
	}
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 passthrough", rec.Code)
	}
}

func TestResponseBodyCap(t *testing.T) {
	old := maxBodyBytes
	maxBodyBytes = 4096
	defer func() { maxBodyBytes = old }()

	big := strings.Repeat("x", 1<<20) // 1 MiB
	mock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		io.WriteString(w, big)
	}))
	defer mock.Close()

	srv := New(testConfig(mock.URL, "anthropic"), "mock")
	req := httptest.NewRequest(http.MethodPost, "/v1/messages",
		strings.NewReader(`{"model":"claude-sonnet-4-6","stream":false,"max_tokens":16,"messages":[{"role":"user","content":"hi"}]}`))
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if int64(rec.Body.Len()) >= int64(len(big)) {
		t.Fatalf("body not capped: got %d bytes, want < %d", rec.Body.Len(), len(big))
	}
}

func TestIdleTimeoutAbortsStream(t *testing.T) {
	old := idleTimeout
	idleTimeout = 50 * time.Millisecond
	defer func() { idleTimeout = old }()

	mock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		time.Sleep(500 * time.Millisecond) // stall: no further bytes
	}))
	defer mock.Close()

	srv := New(testConfig(mock.URL, "anthropic"), "mock")
	req := httptest.NewRequest(http.MethodPost, "/v1/messages",
		strings.NewReader(`{"model":"claude-sonnet-4-6","stream":true,"max_tokens":16,"messages":[{"role":"user","content":"hi"}]}`))
	rec := httptest.NewRecorder()
	start := time.Now()
	srv.ServeHTTP(rec, req)
	if elapsed := time.Since(start); elapsed > 300*time.Millisecond {
		t.Fatalf("stream not aborted by idle watchdog: took %v", elapsed)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (headers flushed before stall)", rec.Code)
	}
}

func TestSpendTrackingAndUsage(t *testing.T) {
	mock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		io.WriteString(w, `{"id":"x","type":"message","role":"assistant","model":"m","content":[{"type":"text","text":"hi"}],"stop_reason":"end_turn","usage":{"input_tokens":1000,"output_tokens":500}}`)
	}))
	defer mock.Close()

	cfg := &config.Config{
		Providers: map[string]config.Provider{
			"mock": {Endpoint: mock.URL, AuthHeader: "bearer", WireFormat: "anthropic", NoAuth: true},
		},
		Aliases: map[string]string{"sonnet": "claude-sonnet-4-6"},
		Configs: map[string]config.SlotConfig{
			"mock": {Name: "mock", Opus: "mock:m", Sonnet: "mock:m", Haiku: "mock:m", Sub: "mock:m", Fable: "mock:m"},
		},
		Pricing: map[string]config.Pricing{
			"m": {Input: 10.0, Output: 20.0},
		},
	}
	srv := New(cfg, "mock")
	req := httptest.NewRequest(http.MethodPost, "/v1/messages",
		strings.NewReader(`{"model":"claude-sonnet-4-6","stream":false,"max_tokens":16,"messages":[{"role":"user","content":"hi"}]}`))
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}

	hrec := httptest.NewRecorder()
	srv.ServeHTTP(hrec, httptest.NewRequest(http.MethodGet, "/health", nil))
	var h map[string]any
	if err := json.Unmarshal(hrec.Body.Bytes(), &h); err != nil {
		t.Fatalf("/health non-JSON: %v", err)
	}
	p := h["providers"].(map[string]any)["mock"].(map[string]any)
	if p["inputTokens"].(float64) != 1000 {
		t.Errorf("inputTokens = %v, want 1000", p["inputTokens"])
	}
	if p["outputTokens"].(float64) != 500 {
		t.Errorf("outputTokens = %v, want 500", p["outputTokens"])
	}
	// 1000/1e6*10 + 500/1e6*20 = 0.01 + 0.01 = 0.02 USD
	spend, ok := p["spendUSD"].(float64)
	if !ok || spend < 0.0199 || spend > 0.0201 {
		t.Errorf("spendUSD = %v, want ~0.02", p["spendUSD"])
	}
}
