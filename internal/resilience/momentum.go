package resilience

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
	"sync"
	"time"
)

const momentumRing = 5

type momentumDecision struct {
	providerKey string
	model       string
	at          time.Time
}

// Momentum remembers recent successful provider decisions per session key,
// so a conversation that has been working through one provider keeps using it.
type Momentum struct {
	mu      sync.Mutex
	entries map[string][]momentumDecision
	now     func() time.Time
}

func NewMomentum() *Momentum {
	return &Momentum{
		entries: make(map[string][]momentumDecision),
		now:     time.Now,
	}
}

// Record appends a successful decision to the ring buffer for the session.
func (m *Momentum) Record(sk, providerKey, model string) {
	if sk == "" {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	e := append(m.entries[sk], momentumDecision{providerKey, model, m.now()})
	if len(e) > momentumRing {
		e = e[len(e)-momentumRing:]
	}
	m.entries[sk] = e
}

// Get returns the most-frequent provider and a confidence ratio (0..1).
func (m *Momentum) Get(sk string) (preferred string, confidence float64, ok bool) {
	if sk == "" {
		return "", 0, false
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	e := m.entries[sk]
	if len(e) == 0 {
		return "", 0, false
	}
	counts := make(map[string]int, len(e))
	for _, d := range e {
		counts[d.providerKey]++
	}
	var best string
	var max int
	for p, c := range counts {
		if c > max {
			max = c
			best = p
		}
	}
	return best, float64(max) / momentumRing, true
}

// SessionKey hashes the first user message + a truncated system prompt hint
// with SHA-256. Stable across restarts (no per-process salt).
func SessionKey(body []byte) (string, bool) {
	var req struct {
		System   json.RawMessage `json:"system"`
		Messages []struct {
			Role    string          `json:"role"`
			Content json.RawMessage `json:"content"`
		} `json:"messages"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		return "", false
	}
	var firstUser string
	found := false
	for _, m := range req.Messages {
		if m.Role == "user" {
			firstUser = contentText(m.Content)
			found = true
			break
		}
	}
	if !found {
		return "", false
	}
	systemHint := contentText(req.System)
	if len(systemHint) > 500 {
		systemHint = systemHint[:500]
	}
	h := sha256.New()
	h.Write([]byte(firstUser))
	h.Write([]byte{0})
	h.Write([]byte(systemHint))
	return hex.EncodeToString(h.Sum(nil))[:32], true
}

// contentText extracts the text from a content field that may be a plain
// string or an array of {text} blocks.
func contentText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		return s
	}
	var blocks []struct {
		Text string `json:"text"`
	}
	if err := json.Unmarshal(raw, &blocks); err == nil {
		var sb strings.Builder
		for _, b := range blocks {
			sb.WriteString(b.Text)
		}
		return sb.String()
	}
	return ""
}
