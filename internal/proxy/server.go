// Package proxy implements the Claude Code proxy server: it intercepts
// Anthropic Messages API calls, routes the model to a configured provider,
// and streams the response back.
package proxy

import (
	"bytes"
	"encoding/json"
	"io"
	"log"
	"net"
	"net/http"
	"strconv"
	"time"

	"github.com/poiarnoia/defiant-claude/internal/config"
	"github.com/poiarnoia/defiant-claude/internal/routing"
	"github.com/poiarnoia/defiant-claude/internal/wire"
)

// Server forwards Anthropic API requests to resolved upstream providers.
type Server struct {
	resolver *routing.Resolver
	client   *http.Client
	logger   *log.Logger
	thinking map[string]config.Thinking
}

// New builds a proxy server for the named backend config.
func New(cfg *config.Config, backend string) *Server {
	transport := &http.Transport{
		MaxIdleConns:        100,
		MaxIdleConnsPerHost: 20,
		IdleConnTimeout:     90 * time.Second,
	}
	return &Server{
		resolver: routing.NewResolver(cfg, backend),
		client:   &http.Client{Transport: transport},
		logger:   log.Default(),
		thinking: cfg.Thinking,
	}
}

// Listen binds to 127.0.0.1 (loopback only — the proxy must never be
// reachable from the network). port 0 selects an ephemeral port.
func (s *Server) Listen(port int) (net.Listener, error) {
	return net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/v1/messages" && r.Method == http.MethodPost {
		s.handleMessages(w, r)
		return
	}
	http.NotFound(w, r)
}

func (s *Server) handleMessages(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(r.Body)
	r.Body.Close()
	if err != nil {
		http.Error(w, "read body: "+err.Error(), http.StatusBadRequest)
		return
	}

	var req struct {
		Model  string `json:"model"`
		Stream bool   `json:"stream"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, "invalid JSON: "+err.Error(), http.StatusBadRequest)
		return
	}

	target, err := s.resolver.Resolve(req.Model)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	body, err = rewriteModel(body, target.Model)
	if err != nil {
		http.Error(w, "rewrite model: "+err.Error(), http.StatusInternalServerError)
		return
	}

	body, err = wire.TranslateRequest(body, target.WireFormat, s.thinking)
	if err != nil {
		http.Error(w, "translate request: "+err.Error(), http.StatusInternalServerError)
		return
	}

	s.forward(w, r, target, body, req.Stream)
}

// forward sends the (already model-rewritten) request upstream, falling back
// through the provider's fallback chain on transient failures, and streams
// the response back flushing per chunk so SSE events reach the client live.
func (s *Server) forward(w http.ResponseWriter, r *http.Request, target routing.Target, body []byte, streaming bool) {
	targets := append([]routing.Target{target}, s.resolver.FallbackTargets(target)...)
	for _, t := range targets {
		resp, err := s.doRequest(r, t, body)
		if err != nil {
			s.logger.Printf("provider %s: %v", t.ProviderKey, err)
			continue
		}
		if isRetryableStatus(resp.StatusCode) {
			resp.Body.Close()
			s.logger.Printf("provider %s: HTTP %d, trying fallback", t.ProviderKey, resp.StatusCode)
			continue
		}
		s.streamResponse(w, resp, t, streaming)
		return
	}
	http.Error(w, "all providers failed", http.StatusBadGateway)
}

// doRequest builds and sends the upstream request for a single target.
func (s *Server) doRequest(r *http.Request, target routing.Target, body []byte) (*http.Response, error) {
	endpoint := target.Endpoint + "/v1/messages"
	req, err := http.NewRequestWithContext(r.Context(), http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream")
	if !target.NoAuth && target.APIKey != "" {
		switch target.AuthHeader {
		case "x-api-key", "":
			req.Header.Set("x-api-key", target.APIKey)
		default: // "bearer"
			req.Header.Set("Authorization", "Bearer "+target.APIKey)
		}
	}
	for k, v := range target.ExtraHeaders {
		req.Header.Set(k, v)
	}
	return s.client.Do(req)
}

// streamResponse copies the upstream status + headers and streams the body,
// translating non-Anthropic wire formats (OpenAI SSE → Anthropic SSE for
// streaming; OpenAI JSON → Anthropic JSON for non-streaming).
func (s *Server) streamResponse(w http.ResponseWriter, resp *http.Response, target routing.Target, streaming bool) {
	defer resp.Body.Close()

	// Non-streaming OpenAI response: translate the single JSON body.
	if target.WireFormat == "openai" && !streaming && resp.StatusCode >= 200 && resp.StatusCode < 300 {
		body, err := io.ReadAll(resp.Body)
		if err != nil {
			s.logger.Printf("read response: %v", err)
			return
		}
		translated, err := wire.TranslateOpenAIResponse(body, target.Model)
		if err != nil {
			s.logger.Printf("translate response: %v", err)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(resp.StatusCode)
		w.Write(translated)
		return
	}

	copyHeaders(w.Header(), resp.Header)
	w.WriteHeader(resp.StatusCode)

	var src io.Reader = resp.Body
	if target.WireFormat == "openai" && resp.StatusCode >= 200 && resp.StatusCode < 300 {
		src = wire.NewOpenAIStreamReader(resp.Body, target.Model)
	}

	flusher, _ := w.(http.Flusher)
	buf := make([]byte, 32*1024)
	for {
		n, rerr := src.Read(buf)
		if n > 0 {
			if _, werr := w.Write(buf[:n]); werr != nil {
				return
			}
			if flusher != nil {
				flusher.Flush()
			}
		}
		if rerr == io.EOF {
			return
		}
		if rerr != nil {
			s.logger.Printf("stream error: %v", rerr)
			return
		}
	}
}

// isRetryableStatus reports whether an upstream status should trigger a
// fallback attempt: transient/rate-limit/server errors, not client errors.
func isRetryableStatus(code int) bool {
	switch code {
	case http.StatusRequestTimeout, http.StatusTooManyRequests,
		http.StatusInternalServerError, http.StatusBadGateway,
		http.StatusServiceUnavailable, http.StatusGatewayTimeout:
		return true
	}
	return false
}

// rewriteModel replaces the "model" field, preserving every other field's raw
// bytes so the body is forwarded verbatim apart from the model name.
func rewriteModel(body []byte, model string) ([]byte, error) {
	var m map[string]json.RawMessage
	if err := json.Unmarshal(body, &m); err != nil {
		return nil, err
	}
	quoted, err := json.Marshal(model)
	if err != nil {
		return nil, err
	}
	m["model"] = quoted
	return json.Marshal(m)
}

// hopHeaders are stripped when copying the upstream response.
var hopHeaders = map[string]bool{
	"Connection":          true,
	"Keep-Alive":          true,
	"Proxy-Authenticate":  true,
	"Proxy-Authorization": true,
	"Te":                  true,
	"Trailer":             true,
	"Transfer-Encoding":   true,
	"Upgrade":             true,
	"Content-Length":      true,
}

func copyHeaders(dst, src http.Header) {
	for k, vv := range src {
		if hopHeaders[k] {
			continue
		}
		for _, v := range vv {
			dst.Add(k, v)
		}
	}
}
