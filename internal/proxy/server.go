// Package proxy implements the Claude Code proxy server: it intercepts
// Anthropic Messages API calls, routes the model to a configured provider,
// and streams the response back.
package proxy

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math/rand/v2"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/Poiar/defiant-claude/internal/config"
	"github.com/Poiar/defiant-claude/internal/resilience"
	"github.com/Poiar/defiant-claude/internal/routing"
	"github.com/Poiar/defiant-claude/internal/wire"
)

// Stream-guard and retry tunables are package vars (not consts) so tests can
// tighten them to run fast. Values match the TS proxy's stream guards.
var (
	firstByteTimeout = 15 * time.Second  // wait for upstream response headers
	idleTimeout      = 180 * time.Second // abort if no bytes flow this long (SSE heartbeat)
	maxBodyBytes     = int64(500 << 20)  // cap on a single upstream response body

	maxAttemptsPerProvider = 3
	retryBaseDelay         = 500 * time.Millisecond
	retryMaxDelay          = 4 * time.Second

	concurrencyTimeout = 30 * time.Second // wait for a concurrency slot
)

const (
	defaultMaxConcurrent = 25 // main chat in-flight upstream requests
	defaultSubagentMax   = 8  // subagent in-flight upstream requests
)

// Server forwards Anthropic API requests to resolved upstream providers.
type Server struct {
	backend     string
	snap        atomic.Pointer[configSnapshot]
	client      *http.Client
	logger      *log.Logger
	breakers    *resilience.Breakers
	momentum    *resilience.Momentum
	concurrency *Concurrency
	startTime   time.Time
	version     string
}

// configSnapshot is an immutable bundle of config-derived state, swapped
// atomically on hot reload so a request never sees a torn mix of old/new
// resolver, thinking, and pricing.
type configSnapshot struct {
	resolver *routing.Resolver
	thinking map[string]config.Thinking
	pricing  map[string]config.Pricing
}

// New builds a proxy server for the named backend config.
func New(cfg *config.Config, backend string) *Server {
	transport := &http.Transport{
		MaxIdleConns:          100,
		MaxIdleConnsPerHost:   20,
		IdleConnTimeout:       90 * time.Second,
		ResponseHeaderTimeout: firstByteTimeout,
	}
	s := &Server{
		backend:     backend,
		client:      &http.Client{Transport: transport},
		logger:      log.Default(),
		breakers:    resilience.NewBreakers(),
		momentum:    resilience.NewMomentum(),
		concurrency: NewConcurrency(defaultMaxConcurrent, defaultSubagentMax),
		startTime:   time.Now(),
		version:     "0.1.0",
	}
	s.snap.Store(&configSnapshot{
		resolver: routing.NewResolver(cfg, backend),
		thinking: cfg.Thinking,
		pricing:  cfg.Pricing,
	})
	return s
}

// SetVersion sets the version reported by /health.
func (s *Server) SetVersion(v string) {
	s.version = v
}

// SetSlotOverrides installs per-slot routing overrides (slot-overrides.json).
// Called once at startup, before serving.
func (s *Server) SetSlotOverrides(m map[string]string) {
	s.snap.Load().resolver.SetOverrides(m)
}

// Reload atomically swaps in a fresh resolver + thinking + pricing built from
// cfg and slot overrides. Called by ReloadFromDir / the config watcher.
func (s *Server) Reload(cfg *config.Config, overrides map[string]string) {
	r := routing.NewResolver(cfg, s.backend)
	r.SetOverrides(overrides)
	s.snap.Store(&configSnapshot{
		resolver: r,
		thinking: cfg.Thinking,
		pricing:  cfg.Pricing,
	})
}

// ReloadFromDir loads providers.json + slot-overrides.json from dir and swaps
// them in. On a bad config the previous snapshot stays active and an error is
// returned for the caller to log.
func (s *Server) ReloadFromDir(dir string) error {
	cfg, err := config.LoadUser(dir)
	if err != nil {
		return err
	}
	if probs := cfg.Lint(); len(probs) > 0 {
		return fmt.Errorf("config lint: %s", strings.Join(probs, "; "))
	}
	overrides, err := config.LoadSlotOverrides(dir)
	if err != nil {
		return err
	}
	s.Reload(cfg, overrides)
	s.logger.Printf("config reloaded from %s", dir)
	return nil
}

// WatchConfig polls dir every interval and hot-reloads when providers.json or
// slot-overrides.json changes. Returns a stop function.
func (s *Server) WatchConfig(dir string, interval time.Duration) (stop func()) {
	providers := filepath.Join(dir, "providers.json")
	overrides := filepath.Join(dir, "slot-overrides.json")
	lastP, _ := fileModTime(providers)
	lastO, _ := fileModTime(overrides)
	done := make(chan struct{})
	stop = func() { close(done) }
	go func() {
		t := time.NewTicker(interval)
		defer t.Stop()
		for {
			select {
			case <-done:
				return
			case <-t.C:
				p, _ := fileModTime(providers)
				o, _ := fileModTime(overrides)
				if p.Equal(lastP) && o.Equal(lastO) {
					continue
				}
				lastP, lastO = p, o
				if err := s.ReloadFromDir(dir); err != nil {
					s.logger.Printf("config reload failed: %v", err)
				}
			}
		}
	}()
	return stop
}

// fileModTime returns a file's mod time, or the zero time if it's absent.
func fileModTime(path string) (time.Time, error) {
	fi, err := os.Stat(path)
	if err != nil {
		return time.Time{}, err
	}
	return fi.ModTime(), nil
}

// Listen binds to 127.0.0.1 (loopback only — the proxy must never be
// reachable from the network). port 0 selects an ephemeral port.
func (s *Server) Listen(port int) (net.Listener, error) {
	return net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/v1/messages":
		if r.Method == http.MethodPost {
			s.handleMessages(w, r)
			return
		}
	case "/health":
		s.handleHealth(w, r)
		return
	case "/metrics":
		s.handleMetrics(w, r)
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

	snap := s.snap.Load()
	target, err := snap.resolver.Resolve(req.Model)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	// Prompt tier: cap max_tokens and route simple/mechanical tiers to
	// cheaper providers (CODE stays on the primary for quality).
	tier := classifyTier(body)
	if capped, err := capMaxTokensInBody(body, tier); err == nil {
		body = capped
	}
	if promptRouterEnabled() {
		if routed, ok := resolvePromptRoute(snap.resolver, target, tier); ok {
			target = routed
		}
	}

	// Concurrency guard: cap simultaneous in-flight upstream requests.
	release, err := s.concurrency.Acquire(target.Slot, concurrencyTimeout)
	if err != nil {
		http.Error(w, "too many concurrent requests: "+err.Error(), http.StatusTooManyRequests)
		return
	}
	defer release()

	// Server-side tools: convert web tools for non-native providers and fill
	// empty web_search/web_fetch tool_results with real output.
	if processed, err := preprocessServerTools(body, target.WireFormat != "anthropic"); err == nil {
		body = processed
	} else {
		s.logger.Printf("server tools: %v", err)
	}

	body, err = rewriteModel(body, target.Model)
	if err != nil {
		http.Error(w, "rewrite model: "+err.Error(), http.StatusInternalServerError)
		return
	}

	// Strip provider-unsupported Anthropic fields and per-request billing/cache
	// metadata so the upstream body stays stable for disk caching.
	body, err = wire.Strip(body, target.ProviderKey)
	if err != nil {
		http.Error(w, "strip fields: "+err.Error(), http.StatusInternalServerError)
		return
	}

	body, err = wire.TranslateRequest(body, target.WireFormat, snap.thinking)
	if err != nil {
		http.Error(w, "translate request: "+err.Error(), http.StatusInternalServerError)
		return
	}

	s.forward(w, r, target, body, req.Stream, req.Model)
}

// forward sends the (already model-rewritten) request upstream, falling back
// through the provider's fallback chain on transient failures, and streams
// the response back flushing per chunk so SSE events reach the client live.
func (s *Server) forward(w http.ResponseWriter, r *http.Request, target routing.Target, body []byte, streaming bool, model string) {
	sk, _ := resilience.SessionKey(body)
	chain := s.buildChain(target, sk)
	var attempted []string
	var lastStatus int
	for _, t := range chain {
		attempted = append(attempted, t.ProviderKey)
		start := time.Now()
		resp, status, err := s.requestWithRetry(r, t, body)
		ms := time.Since(start).Milliseconds()
		if err != nil {
			lastStatus = status
			s.logger.Printf("provider %s: gave up after %d attempts: %v", t.ProviderKey, maxAttemptsPerProvider, err)
			continue
		}
		s.breakers.RecordStat(t.ProviderKey, true, ms, resp.StatusCode)
		s.momentum.Record(sk, t.ProviderKey, t.Model)
		u := s.streamResponse(w, resp, t, streaming)
		s.recordUsage(t.ProviderKey, t.Model, u)
		s.logger.Printf("request model=%q -> %s/%s status=%d ms=%d in=%d out=%d",
			model, t.ProviderKey, t.Model, resp.StatusCode, ms, u.InputTokens, u.OutputTokens)
		return
	}
	s.writeFriendlyError(w, streaming, model, attempted, lastStatus)
}

// requestWithRetry sends the request to a single provider, retrying transient
// failures (network errors and retryable HTTP statuses) up to
// maxAttemptsPerProvider with exponential backoff + full jitter. The first
// non-retryable response — including 4xx client errors, which prove the
// provider is up — is returned as success. Failed attempts are recorded
// against the circuit breaker.
func (s *Server) requestWithRetry(r *http.Request, t routing.Target, body []byte) (*http.Response, int, error) {
	var lastStatus int
	var lastErr error
	for attempt := 1; attempt <= maxAttemptsPerProvider; attempt++ {
		start := time.Now()
		resp, err := s.doRequest(r, t, body)
		ms := time.Since(start).Milliseconds()
		switch {
		case err != nil:
			lastErr = err
			s.breakers.RecordStat(t.ProviderKey, false, ms, 0)
			label, _ := classifyTransportError(err)
			s.logger.Printf("provider %s: attempt %d/%d %s: %v", t.ProviderKey, attempt, maxAttemptsPerProvider, label, err)
		case isRetryableStatus(resp.StatusCode):
			lastStatus = resp.StatusCode
			lastErr = fmt.Errorf("HTTP %d", resp.StatusCode)
			resp.Body.Close()
			s.breakers.RecordStat(t.ProviderKey, false, ms, resp.StatusCode)
			s.logger.Printf("provider %s: attempt %d/%d HTTP %d, retrying", t.ProviderKey, attempt, maxAttemptsPerProvider, resp.StatusCode)
		default:
			return resp, resp.StatusCode, nil
		}
		if attempt < maxAttemptsPerProvider {
			time.Sleep(retryBackoff(attempt))
		}
	}
	return nil, lastStatus, lastErr
}

// retryBackoff returns exponential backoff with full jitter: attempt 1 →
// [0, 500ms), attempt 2 → [0, 1s), attempt 3 → [0, 2s), capped at retryMaxDelay.
func retryBackoff(attempt int) time.Duration {
	base := retryBaseDelay << (attempt - 1)
	if base > retryMaxDelay {
		base = retryMaxDelay
	}
	return time.Duration(rand.Int64N(int64(base)))
}

// buildChain assembles the primary target plus health-filtered fallbacks,
// applies session-momentum reordering, and truncates to at most 3 providers.
func (s *Server) buildChain(target routing.Target, sk string) []routing.Target {
	fallbacks := s.snap.Load().resolver.FallbackTargets(target)
	healthy := make([]routing.Target, 0, len(fallbacks))
	for _, fb := range fallbacks {
		if s.breakers.IsHealthy(fb.ProviderKey) {
			healthy = append(healthy, fb)
		}
	}
	chain := append([]routing.Target{target}, healthy...)

	if len(chain) > 1 && sk != "" {
		if pref, conf, ok := s.momentum.Get(sk); ok && pref != "" && conf >= 0.4 && s.breakers.IsHealthy(pref) {
			chain = moveToIndex1(chain, pref)
		} else {
			chain = moveFreeToIndex1(chain)
		}
	}
	if len(chain) > 3 {
		chain = chain[:3]
	}
	return chain
}

// freeProviders cost $0/M and are preferred over paid fallbacks when there is
// no session momentum.
var freeProviders = map[string]bool{"oc": true, "um": true, "lo": true}

// moveToIndex1 moves the named provider (if present at index >= 2) to index 1,
// immediately after the primary.
func moveToIndex1(chain []routing.Target, providerKey string) []routing.Target {
	for i := 2; i < len(chain); i++ {
		if chain[i].ProviderKey == providerKey {
			item := chain[i]
			copy(chain[2:i+1], chain[1:i])
			chain[1] = item
			break
		}
	}
	return chain
}

// moveFreeToIndex1 promotes the first free provider found at index >= 2.
func moveFreeToIndex1(chain []routing.Target) []routing.Target {
	for i := 2; i < len(chain); i++ {
		if freeProviders[chain[i].ProviderKey] {
			return moveToIndex1(chain, chain[i].ProviderKey)
		}
	}
	return chain
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

// streamResponse writes the upstream status + headers and the (translated)
// body to the client, returning the token usage it observed. Non-streaming
// responses are read whole and usage-extracted; streaming responses are
// copied through the idle-guarded copy loop while a usage tee / stream
// reader captures token counts.
func (s *Server) streamResponse(w http.ResponseWriter, resp *http.Response, target routing.Target, streaming bool) wire.Usage {
	defer resp.Body.Close()

	if !streaming {
		body, err := io.ReadAll(io.LimitReader(resp.Body, maxBodyBytes+1))
		if err != nil {
			s.logger.Printf("read response: %v", err)
			return wire.Usage{}
		}
		if int64(len(body)) > maxBodyBytes {
			s.logger.Printf("response exceeded %d bytes, aborting", maxBodyBytes)
			return wire.Usage{}
		}
		usage := wire.Usage{}
		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			switch target.WireFormat {
			case "openai":
				usage = wire.ExtractOpenAIUsage(body)
				translated, err := wire.TranslateOpenAIResponse(body, target.Model)
				if err != nil {
					s.logger.Printf("translate response: %v", err)
					return usage
				}
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(resp.StatusCode)
				w.Write(translated)
				return usage
			case "anthropic":
				usage = wire.ExtractAnthropicUsage(body)
			}
		}
		copyHeaders(w.Header(), resp.Header)
		w.WriteHeader(resp.StatusCode)
		w.Write(body)
		return usage
	}

	copyHeaders(w.Header(), resp.Header)
	w.WriteHeader(resp.StatusCode)

	var usage wire.Usage
	var src io.Reader = resp.Body
	var reporter wire.UsageReporter
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		switch target.WireFormat {
		case "openai":
			r := wire.NewOpenAIStreamReader(resp.Body, target.Model)
			src = r
			if rr, ok := r.(wire.UsageReporter); ok {
				reporter = rr
			}
		case "anthropic":
			src = wire.NewAnthropicUsageTee(resp.Body, &usage)
		}
	}

	s.copyStream(w, resp, src)
	if reporter != nil {
		usage = reporter.Usage()
	}
	return usage
}

// copyStream copies src to the client, flushing per chunk, guarded by an idle
// watchdog (aborts if no bytes flow within idleTimeout) and a total-body cap
// (maxBodyBytes).
func (s *Server) copyStream(w http.ResponseWriter, resp *http.Response, src io.Reader) {
	done := make(chan struct{})
	defer close(done)
	kick := make(chan struct{}, 1)
	go func() {
		timer := time.NewTimer(idleTimeout)
		defer timer.Stop()
		for {
			select {
			case <-done:
				return
			case <-kick:
				if !timer.Stop() {
					select {
					case <-timer.C:
					default:
					}
				}
				timer.Reset(idleTimeout)
			case <-timer.C:
				_ = resp.Body.Close()
				return
			}
		}
	}()

	flusher, _ := w.(http.Flusher)
	buf := make([]byte, 32*1024)
	var total int64
	for {
		n, rerr := src.Read(buf)
		if n > 0 {
			select {
			case kick <- struct{}{}:
			default:
			}
			total += int64(n)
			if total > maxBodyBytes {
				s.logger.Printf("response exceeded %d bytes, aborting", maxBodyBytes)
				return
			}
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

// recordUsage accumulates token counts and USD spend for a completed request.
func (s *Server) recordUsage(providerKey, model string, u wire.Usage) {
	if u.InputTokens == 0 && u.OutputTokens == 0 {
		return
	}
	s.breakers.RecordUsage(providerKey, u.InputTokens, u.OutputTokens)
	if cost := s.costUSD(model, u); cost > 0 {
		s.breakers.RecordCost(providerKey, cost)
	}
}

// costUSD estimates the request cost from the model's pricing entry and the
// token breakdown. Returns 0 when the model has no pricing entry.
func (s *Server) costUSD(model string, u wire.Usage) float64 {
	p, ok := s.snap.Load().pricing[model]
	if !ok {
		return 0
	}
	const perMillion = 1_000_000.0
	var cost float64
	if u.CacheReadTokens > 0 || u.CacheWriteTokens > 0 {
		miss := p.InputCacheMiss
		if miss == 0 {
			miss = p.Input
		}
		cost += float64(u.CacheReadTokens)/perMillion*p.InputCacheHit +
			float64(u.CacheWriteTokens)/perMillion*miss
	} else {
		cost += float64(u.InputTokens) / perMillion * p.Input
	}
	cost += float64(u.OutputTokens) / perMillion * p.Output
	return cost
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
