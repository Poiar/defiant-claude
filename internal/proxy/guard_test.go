package proxy

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
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

func TestReloadSwapsConfig(t *testing.T) {
	mockA := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		io.WriteString(w, `{"id":"a","type":"message","role":"assistant","model":"m","content":[{"type":"text","text":"AAA"}],"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}`)
	}))
	defer mockA.Close()
	mockB := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		io.WriteString(w, `{"id":"b","type":"message","role":"assistant","model":"m","content":[{"type":"text","text":"BBB"}],"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}`)
	}))
	defer mockB.Close()

	srv := New(testConfig(mockA.URL, "anthropic"), "mock")
	roundtrip := func() string {
		req := httptest.NewRequest(http.MethodPost, "/v1/messages",
			strings.NewReader(`{"model":"claude-sonnet-4-6","stream":false,"max_tokens":16,"messages":[{"role":"user","content":"hi"}]}`))
		rec := httptest.NewRecorder()
		srv.ServeHTTP(rec, req)
		return rec.Body.String()
	}

	if !strings.Contains(roundtrip(), "AAA") {
		t.Fatalf("before reload, want AAA, got %s", roundtrip())
	}
	srv.Reload(testConfig(mockB.URL, "anthropic"), nil)
	if !strings.Contains(roundtrip(), "BBB") {
		t.Fatalf("after reload, want BBB, got %s", roundtrip())
	}
}

func TestReloadFromDir(t *testing.T) {
	mock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		io.WriteString(w, `{"id":"x","type":"message","role":"assistant","model":"m","content":[{"type":"text","text":"RELOADED"}],"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}`)
	}))
	defer mock.Close()

	dir := t.TempDir()
	providersJSON := `{
	  "providers": {"mock": {"endpoint": "` + mock.URL + `", "authHeader": "bearer", "wireFormat": "anthropic", "noAuth": true}},
	  "aliases": {"sonnet": "claude-sonnet-4-6"},
	  "configs": {"mock": {"name": "mock", "opus": "mock:m", "sonnet": "mock:m", "haiku": "mock:m", "sub": "mock:m", "fable": "mock:m"}}
	}`
	if err := os.WriteFile(filepath.Join(dir, "providers.json"), []byte(providersJSON), 0o644); err != nil {
		t.Fatal(err)
	}

	// Start against a dead endpoint; ReloadFromDir should point at the mock.
	srv := New(testConfig("http://127.0.0.1:1", "anthropic"), "mock")
	if err := srv.ReloadFromDir(dir); err != nil {
		t.Fatalf("ReloadFromDir: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/v1/messages",
		strings.NewReader(`{"model":"claude-sonnet-4-6","stream":false,"max_tokens":16,"messages":[{"role":"user","content":"hi"}]}`))
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if !strings.Contains(rec.Body.String(), "RELOADED") {
		t.Fatalf("expected RELOADED response, got %s", rec.Body.String())
	}
}
