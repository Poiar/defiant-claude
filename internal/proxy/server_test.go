package proxy

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Poiar/defiant-claude/internal/config"
)

func TestProxyOpenAITranslation(t *testing.T) {
	// Mock OpenAI-format upstream: asserts the request arrived in OpenAI shape
	// and returns an OpenAI SSE stream.
	var received []byte
	mock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		received, _ = io.ReadAll(r.Body)
		var o map[string]any
		if err := json.Unmarshal(received, &o); err != nil {
			t.Errorf("upstream received non-JSON body: %s", received)
		}
		if o["messages"] == nil {
			t.Errorf("expected OpenAI messages field, got: %s", received)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"},\"finish_reason\":null}]}\n\n")
		io.WriteString(w, "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n")
		io.WriteString(w, "data: [DONE]\n\n")
	}))
	defer mock.Close()

	cfg := &config.Config{
		Providers: map[string]config.Provider{
			"mock": {Endpoint: mock.URL, AuthHeader: "bearer", WireFormat: "openai", NoAuth: true},
		},
		Aliases: map[string]string{"sonnet": "claude-sonnet-4-6"},
		Configs: map[string]config.SlotConfig{
			"mock": {Name: "mock", Opus: "mock:m", Sonnet: "mock:m", Haiku: "mock:m", Sub: "mock:m", Fable: "mock:m"},
		},
	}

	srv := New(cfg, "mock")
	req := httptest.NewRequest(http.MethodPost, "/v1/messages",
		strings.NewReader(`{"model":"claude-sonnet-4-6","stream":true,"max_tokens":16,"messages":[{"role":"user","content":"hi"}]}`))
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)

	// The upstream should have received OpenAI-format (model rewritten to "m").
	var got map[string]any
	if err := json.Unmarshal(received, &got); err != nil {
		t.Fatalf("upstream body parse: %v", err)
	}
	if got["model"] != "m" {
		t.Errorf("upstream model = %v, want m (rewritten)", got["model"])
	}
	if _, ok := got["stream_options"]; !ok {
		t.Errorf("upstream request missing stream_options")
	}

	// The client should receive Anthropic-format SSE.
	body := rec.Body.String()
	for _, want := range []string{"message_start", "text_delta", "message_stop", "hi", "end_turn"} {
		if !strings.Contains(body, want) {
			t.Errorf("response missing %q\n--- full response ---\n%s", want, body)
		}
	}
}

func TestHealthAndMetricsEndpoints(t *testing.T) {
	cfg := &config.Config{
		Providers: map[string]config.Provider{
			"mock": {Endpoint: "http://127.0.0.1:1", AuthHeader: "bearer", WireFormat: "openai", NoAuth: true},
		},
		Configs: map[string]config.SlotConfig{
			"mock": {Name: "mock", Opus: "mock:m", Sonnet: "mock:m", Haiku: "mock:m", Sub: "mock:m", Fable: "mock:m"},
		},
	}
	srv := New(cfg, "mock")

	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/health", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("/health status = %d, want 200", rec.Code)
	}
	var h map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &h); err != nil {
		t.Fatalf("/health non-JSON: %v", err)
	}
	if h["status"] != "ok" {
		t.Errorf("/health status field = %v, want ok", h["status"])
	}

	rec2 := httptest.NewRecorder()
	srv.ServeHTTP(rec2, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if rec2.Code != http.StatusOK {
		t.Fatalf("/metrics status = %d, want 200", rec2.Code)
	}
	if !strings.Contains(rec2.Body.String(), "defiant_claude_uptime_seconds") {
		t.Errorf("/metrics missing uptime metric:\n%s", rec2.Body.String())
	}
}

func TestFriendlyErrorWhenAllProvidersFail(t *testing.T) {
	mock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer mock.Close()

	cfg := &config.Config{
		Providers: map[string]config.Provider{
			"mock": {Endpoint: mock.URL, AuthHeader: "bearer", WireFormat: "openai", NoAuth: true},
		},
		Aliases: map[string]string{"sonnet": "claude-sonnet-4-6"},
		Configs: map[string]config.SlotConfig{
			"mock": {Name: "mock", Opus: "mock:m", Sonnet: "mock:m", Haiku: "mock:m", Sub: "mock:m", Fable: "mock:m"},
		},
	}
	srv := New(cfg, "mock")
	req := httptest.NewRequest(http.MethodPost, "/v1/messages",
		strings.NewReader(`{"model":"claude-sonnet-4-6","stream":false,"max_tokens":16,"messages":[{"role":"user","content":"hi"}]}`))
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (friendly fallback)", rec.Code)
	}
	if rec.Header().Get("x-defiant-claude-error") != "E012" {
		t.Errorf("missing E012 header: %v", rec.Header())
	}
	if !strings.Contains(rec.Body.String(), "unavailable") {
		t.Errorf("missing friendly message:\n%s", rec.Body.String())
	}
}
